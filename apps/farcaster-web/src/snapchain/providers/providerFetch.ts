/**
 * The one `fetch` the client is handed, now provider-aware.
 *
 * Before this file the client had a single seam: a `fetch` that answered the
 * hosted API's requests from one node (`nodeApi/nodeBackedFetch`). This wraps
 * that seam once more so *which server* answers can change while the app is
 * open, without the client being rebuilt:
 *
 *   client request → the live provider → that provider's own way of answering
 *
 * How each provider answers, honestly:
 *
 *   snapchain          the existing node-backed adapter, pointed at that
 *                      node's address. This is the real thing: the signed-in
 *                      reads (feed, unseen, notifications) only exist here.
 *   neynar             the thin mapper in `neynarMap.ts`, for the reads Neynar
 *                      actually serves. Everything else is refused by name.
 *   farcaster-public   the same request path at `api.farcaster.xyz`, whose
 *                      public reads already speak the hosted shapes — no mapper
 *                      needed, and no credential forwarded. Its signed-in
 *                      endpoints answer 401, which this turns into a sentence
 *                      saying that read needs a node.
 *
 * Two rules this file exists to enforce:
 *
 *   - A reader's session token never travels to a provider that is not what it
 *     was minted for. `Authorization`, `Cookie` and the fork's own device
 *     headers are stripped from anything that is not a node-backed read.
 *   - No provider change is silent. Every switch was decided by the failover
 *     engine and carries a reason the pill renders; this file only obeys.
 *
 * One request is never a provider's to answer: the media pipeline (`POST
 * /v1/generate-image-upload-url`, classified `media`) is answered here, before
 * any provider sees it, because the bytes belong to our own host rather than to
 * whichever machine is answering today's feed. A provider that takes no writes
 * would otherwise turn "post a photo" into a 501. Cast drafts are the second:
 * they are this device's own state (`localDrafts.ts`), so the draft write the
 * composer makes before every Cast is answered here too, for the same reason
 * (`local`, see `answerLocalDraftRequest`). The home feed is the third, and any
 * other route the table classifies `node` with it: a read a node assembles out
 * of protocol messages is answered from a node whatever HTTP method the fork
 * spells it with and whichever server is live — see the `node`-route block in
 * `providerBackedFetch`, where `POST /v2/feed-items` and its own measured
 * failure live.
 */

import { loadAppKey } from '~/snapchain/appKeyStorage';
import { createEmbedCardResolver } from '~/snapchain/nodeApi/embedCards';
import {
  classifyHostedRequest,
  hostedApiPath,
  type HostedRouteMatch,
} from '~/snapchain/nodeApi/hostedRoutes';
import {
  answerLocalDraftRequest,
  LocalDraftStore,
} from '~/snapchain/nodeApi/localDrafts';
import {
  createNodeBackedFetch,
  hostedRefusal,
  isRequestDebugEnabled,
  mediaUploadAnswer,
  REQUEST_BODY_PREVIEW_LIMIT,
  type RequestLogEntry,
} from '~/snapchain/nodeApi/nodeBackedFetch';
import {
  NodeBackedWrites,
  type WriteApproval,
} from '~/snapchain/nodeApi/nodeWrites';
import { castAuthorOf, channelParentUrlFor } from '~/snapchain/nodeApi/reads';

import {
  providerCanServe,
  providerPlainName,
  type ServeableRouteKind,
} from './capabilities';
import {
  FARCASTER_PUBLIC_BASE_URL,
  NEYNAR_BASE_URL,
  NEYNAR_NODE_BASE_URL,
} from './catalog';
import {
  answerFromNeynar,
  fetchCastAuthorFromNeynar,
  fetchFrameCardFromNeynar,
} from './neynarMap';
import { neynarApiKeyFromEnv } from './preferences';
import type { NodeProvider } from './providerTypes';
import {
  PUBLIC_SERVER_OFF_THE_WEB_STATUS,
  publicServerCannotAnswer,
} from './publicServerOffTheWeb';
import { getProviderSnapshot } from './runtime';

export interface ProviderBackedFetchOptions {
  /** Which provider is live right now, asked fresh on every request. */
  getActiveProvider: () => NodeProvider | null;
  /** The signed-in FID, if this device has one. */
  getSignedInFid: () => number | undefined;
  /** The address this build was configured with, used when nothing else is live. */
  nodeBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Neynar key from the build's own configuration; injectable for tests. */
  neynarApiKey?: string | null;
  /** Cap on paged counts, passed through to the node-backed readers. */
  countCap?: number;
  /**
   * Called after every request a provider answered, with whether that answer was
   * usable. This is how "repeated errors" reaches the failover engine: a server
   * can pass a status check and still fail every read, and only the reads know.
   */
  onRead?: (providerId: string, ok: boolean) => void;
  /** Test seam: stand in for the node-backed adapter. */
  createNodeAdapter?: typeof createNodeBackedFetch;
  /**
   * The classification sink, shared with every node adapter this seam builds —
   * one request, one log, whichever layer answered. Injectable for tests; the
   * page's debug surface (`window.__nodeBackedRequests`, on with
   * `VITE_SNAPCHAIN_DEBUG=true`) reads this same array.
   */
  requestLog?: RequestLogEntry[];
  /**
   * The reader's servers, in the order they want them tried. Defaults to the
   * runtime's live order, which is what the pill and the picker read. Injectable
   * so a test can describe an order without a watch running.
   */
  getProviderOrder?: () => NodeProvider[];
  /**
   * Where cast drafts are kept. Defaults to a store over this browser's own
   * storage; injectable so a test can use a storage of its own.
   */
  drafts?: LocalDraftStore;
  /**
   * Asked when a write arrives with no key to sign it, so the reader can approve
   * a posting key where they are instead of being sent to Advanced. Handed to
   * every writer this seam builds — the node adapters below and Neynar's own
   * node — so a write is asked about the same way whichever server carries it.
   * Leave it out (or pass `null`) for the bare refusal.
   */
  askForPostingKey?: WriteApproval | null;
}

export interface ProviderBackedFetchHandle {
  fetch: typeof fetch;
  /** Every request, with the provider that answered it — evidence, not logs. */
  log: { path: string; providerId: string; kind: NodeProvider['kind'] }[];
}

interface ParsedRequest {
  url: URL;
  method: string;
  body?: unknown;
}

/** Same parsing rules as the node-backed adapter, for the same reasons. */
const parseRequest = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ParsedRequest> => {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (
    init?.method ??
    (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  )
    .toString()
    .toUpperCase();

  let body: unknown;
  const rawBody = init?.body;
  if (typeof rawBody === 'string' && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      body = undefined;
    }
  }

  return { url: new URL(rawUrl, 'http://localhost'), method, body };
};

const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Headers that belong to this device's session with Fiddy's own API. They are
 * never replayed to a third-party server: the non-node branches below build
 * their own requests and pass no headers through at all.
 */

/**
 * The sink a write's refusal goes to when the seam answers it itself; the same
 * shape the adapter keeps.
 */
const recordSelfAnswered = (
  requestLog: RequestLogEntry[],
  parsed: ParsedRequest,
  route: { path: string; kind: RequestLogEntry['kind'] },
  response: Response,
  bodyPreview: { bodyPreview?: string },
): void => {
  requestLog.push({
    method: parsed.method,
    path: parsed.url.pathname,
    kind: route.kind,
    status: response.status,
    ...bodyPreview,
  });
};

export const createProviderBackedFetch = ({
  getActiveProvider,
  getSignedInFid,
  nodeBaseUrl,
  fetchImpl,
  neynarApiKey,
  countCap,
  onRead,
  createNodeAdapter = createNodeBackedFetch,
  requestLog: requestLogOption,
  getProviderOrder,
  drafts: draftsOption,
  askForPostingKey,
}: ProviderBackedFetchOptions): ProviderBackedFetchHandle => {
  const drafts = draftsOption ?? new LocalDraftStore();
  const nodeFetch = fetchImpl ?? fetch;
  const boundFetch = (nodeFetch as (...args: unknown[]) => unknown).bind(
    globalThis,
  ) as typeof fetch;

  // One adapter per node address: building one constructs a client and its
  // readers, so it is worth keeping between requests. A provider that is not a
  // node never lands here.
  const adapters = new Map<string, ReturnType<typeof createNodeBackedFetch>>();

  /**
   * The key this build (or this test) has for Neynar, resolved once per call.
   *
   * `undefined` asks this build's own configuration; an explicit `null` means
   * "there is none" — `??` would silently read a key off the build's env.
   */
  const neynarKey = (): string | null =>
    neynarApiKey === undefined ? neynarApiKeyFromEnv() : neynarApiKey;

  /**
   * What a link embed's own page says about itself, with an index behind it.
   *
   * The page is read first — that is the author's own card, and it is the only
   * source that can name the button the app declared. The index is asked only
   * when the page could not be read at all: measured, most app pages do not
   * grant a browser permission to read them, and Neynar has already read those
   * pages, so its catalog can still answer for an app it knows. Without a key
   * there is no index, and the resolver simply reads the page.
   *
   * This is a *card* lookup, not a read of the reader's timeline: it never
   * touches the provider chain, so it cannot move a reader off their node, and
   * the key travels in a header to Neynar alone.
   */
  const embedCards = createEmbedCardResolver({
    fetchImpl: boundFetch,
    indexLookup: async (url) => {
      const key = neynarKey();
      if (key === null) {
        return null;
      }
      return fetchFrameCardFromNeynar({
        url,
        apiKey: key,
        fetchImpl: boundFetch,
        baseUrl: NEYNAR_BASE_URL,
      });
    },
  });

  const nodeAdapter = (
    provider: NodeProvider,
  ): ReturnType<typeof createNodeBackedFetch> => {
    const baseUrl = provider.baseUrl || nodeBaseUrl;
    const existing = adapters.get(baseUrl);
    if (existing) {
      return existing;
    }
    const created = createNodeAdapter({
      nodeBaseUrl: baseUrl,
      nodeLabel: providerPlainName(provider),
      getSignedInFid,
      fetchImpl: boundFetch,
      embedCards,
      ...(countCap ? { countCap } : {}),
      // The same draft store the seam answers with, so a draft written while a
      // node was live is the draft read back when it is not.
      drafts,
      // One sink for the whole client: a request the node adapter answers and a
      // request this seam answers land in the same list, in order.
      log: requestLog,
      ...(askForPostingKey === null || askForPostingKey === undefined
        ? {}
        : { askForPostingKey }),
    });
    adapters.set(baseUrl, created);
    return created;
  };

  /**
   * The node this build was configured with, as a provider — the last honest
   * answer for a read a node assembles when the reader's list holds no node.
   */
  const buildConfiguredNode = (): NodeProvider => ({
    id: 'build-configured',
    kind: 'snapchain',
    source: 'public',
    label: 'The node this build was configured with',
    detail: '',
    baseUrl: nodeBaseUrl,
    readOnly: false,
  });

  /**
   * The node a read that only a node can answer is handed to, when the live
   * provider is not a node.
   *
   * The reader's list first — a node the health check has just measured as
   * answering, else the first node on it (their own node, or the public relay
   * this build reads from today) — and this build's configured address when the
   * list holds no node at all. Never a provider that is not a node: that is the
   * whole point of asking this question.
   */
  const nodeForNodeOnlyRead = (): NodeProvider => {
    const order = getProviderOrder
      ? getProviderOrder()
      : getProviderSnapshot().order;
    const health = getProviderSnapshot().health;
    const nodes = order.filter((provider) => provider.kind === 'snapchain');
    return (
      nodes.find((provider) => health[provider.id]?.status === 'live') ??
      nodes[0] ??
      buildConfiguredNode()
    );
  };

  /**
   * The Neynar half of a write.
   *
   * Neynar is two servers (see `catalog.ts`): the index that answers reads, and
   * its own Snapchain node at `NEYNAR_NODE_BASE_URL`, which is where a message
   * this device signed is handed over — exactly as it would be handed to any
   * other node, with the reader's key in a header and nothing else different.
   * MEASURED live: `/v1/info` and `/v1/submitMessage` both answer there with the
   * key this build was given, and a bad signer is refused with the same
   * `invalid signer` a public node gives.
   *
   * Its one extra power over a public node is used here and nowhere else: it can
   * turn a cast *hash* into its author's FID (`fetchCastAuthorFromNeynar`), which
   * is what a reaction needs to address itself to a cast the client has not read
   * through a node yet.
   */
  const neynarWriterFor = (
    key: string,
    entry: RequestLogEntry,
  ): NodeBackedWrites =>
    new NodeBackedWrites({
      nodeBaseUrl: NEYNAR_NODE_BASE_URL,
      nodeLabel: 'Neynar',
      headers: { 'x-api-key': key },
      fetchImpl: boundFetch,
      getAppKeyHex: (fid) => loadAppKey(fid),
      castAuthor: castAuthorOf,
      resolveCastAuthor: (hash) =>
        fetchCastAuthorFromNeynar({
          hash,
          apiKey: key,
          fetchImpl: boundFetch,
          baseUrl: NEYNAR_BASE_URL,
        }),
      channelParentUrl: channelParentUrlFor,
      ...(askForPostingKey === null || askForPostingKey === undefined
        ? {}
        : { askForPostingKey }),
      onEvidence: (evidence) => {
        entry.write = evidence;
      },
    });

  const log: ProviderBackedFetchHandle['log'] = [];
  const requestLog: RequestLogEntry[] = requestLogOption ?? [];

  /**
   * The first server on the reader's list that can answer this request.
   *
   * The list is the same one the pill and the picker read, and the preferred
   * server is tried first — so a request only leaves the reader's first choice
   * when that choice genuinely cannot serve it (`capabilities.ts`). Nothing is
   * measured here: whether a server *can* answer is a fact about the server's
   * shape, not about its health, and health is the failover engine's job.
   */
  const firstCapableProvider = ({
    kind,
    path,
    preferred,
  }: {
    kind: ServeableRouteKind;
    path: string;
    preferred: NodeProvider;
  }): NodeProvider | null => {
    const order = getProviderOrder
      ? getProviderOrder()
      : getProviderSnapshot().order;
    const candidates = [
      preferred,
      ...order.filter((provider) => provider.id !== preferred.id),
    ];
    return (
      candidates.find(
        (provider) => providerCanServe({ provider, kind, path }).can,
      ) ?? null
    );
  };
  const debugEnabled = isRequestDebugEnabled();
  if (debugEnabled) {
    (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests =
      requestLog;
  }

  /** What a write was about to submit, kept only on the debug surface. */
  const bodyPreviewOf = (parsed: ParsedRequest): { bodyPreview?: string } => {
    const isWrite = parsed.method !== 'GET' && parsed.method !== 'HEAD';
    if (!debugEnabled || parsed.body === undefined || !isWrite) {
      return {};
    }
    try {
      return {
        bodyPreview: JSON.stringify(parsed.body).slice(
          0,
          REQUEST_BODY_PREVIEW_LIMIT,
        ),
      };
    } catch {
      return {};
    }
  };

  /** Same request, at Farcaster's own public server, without our session. */
  const answerFromFarcasterPublic = async (
    { url, method }: ParsedRequest,
    provider: NodeProvider,
  ): Promise<Response> => {
    const endpoint = hostedApiPath(url.pathname);

    if (method !== 'GET' && method !== 'HEAD') {
      return errorResponse(
        501,
        `${method} ${endpoint} is a write, and Farcaster's own public server does not take writes from this client. Posting goes through your node (or ours) instead.`,
      );
    }

    const target = `${provider.baseUrl || FARCASTER_PUBLIC_BASE_URL}${endpoint}${url.search}`;
    let response: Response;
    try {
      response = await boundFetch(target, {
        method: 'GET',
        credentials: 'omit',
      });
    } catch (error) {
      return errorResponse(
        502,
        `Farcaster's own public server did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      return errorResponse(
        501,
        `${endpoint} needs a signed-in session, which only Farcaster's own app can hold. This client reads that from a node — not from the public server.`,
      );
    }

    // The body is already in the hosted shapes the client expects, so it is
    // passed through as-is; only the status and content type are re-stated.
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ??
          'application/json; charset=utf-8',
      },
    });
  };

  const answer = async (
    parsed: ParsedRequest,
    provider: NodeProvider,
    route: HostedRouteMatch,
    entry: RequestLogEntry,
  ): Promise<Response> => {
    switch (provider.kind) {
      case 'neynar': {
        // `undefined` asks this build's own configuration; an explicit `null`
        // means "there is none", which is what a caller (or a test) needs to be
        // able to say — `??` would silently read the key off the build's env.
        const key =
          neynarApiKey === undefined ? neynarApiKeyFromEnv() : neynarApiKey;
        if (key === null) {
          return errorResponse(
            501,
            'Neynar needs your own API key before it can answer. Run scripts/fiddy-setup.command to add one, or pick another server.',
          );
        }
        if (route.kind === 'write') {
          return neynarWriterFor(key, entry).answer({
            method: parsed.method,
            path: route.path,
            body: parsed.body,
            fid: getSignedInFid(),
          });
        }
        return answerFromNeynar({
          path: hostedApiPath(parsed.url.pathname),
          searchParams: parsed.url.searchParams,
          signedInFid: getSignedInFid(),
          apiKey: key,
          fetchImpl: boundFetch,
          baseUrl: provider.baseUrl || NEYNAR_BASE_URL,
        });
      }

      case 'farcaster-public':
        return answerFromFarcasterPublic(parsed, provider);

      case 'snapchain':
      default: {
        const adapter = nodeAdapter(provider);
        return adapter.fetch(parsed.url.toString(), {
          method: parsed.method,
          ...(parsed.body !== undefined
            ? { body: JSON.stringify(parsed.body) }
            : {}),
        });
      }
    }
  };

  const providerBackedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const parsed = await parseRequest(input, init);
    const provider = getActiveProvider();
    const path = hostedApiPath(parsed.url.pathname);
    const route = classifyHostedRequest({ method: parsed.method, path });

    // The media pipeline is ours, not a provider's read.
    //
    // MEASURED (2026-10-21, headless Chrome, the real composer): with
    // `farcaster-public` as the live provider the mint never reached the node
    // adapter, so the `media` route added there was unreachable and "post a
    // photo" failed with that provider's write guard
    // (`501 POST /v1/generate-image-upload-url is a write …`) — the same
    // user-visible failure, one layer up. Answering it here, before any
    // provider sees it, makes the answer the same whichever machine answers
    // today's feed: the bytes always go to our own host.
    if (route.kind === 'media') {
      const response = mediaUploadAnswer();
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        response,
        bodyPreviewOf(parsed),
      );
      return response;
    }

    // A cast draft is this device's own state, so it is answered here too —
    // before any provider sees it. A provider that takes no writes would
    // otherwise refuse `POST /v2/draft-caststorms` as a write with a sentence
    // about itself, in front of every Cast attempt, for a request that never
    // had to leave the browser at all (measured on `farcaster-public`; the same
    // shape of failure the media mint had one endpoint over).
    if (route.kind === 'local') {
      const local = answerLocalDraftRequest(
        {
          method: parsed.method,
          path,
          body: parsed.body,
          searchParams: parsed.url.searchParams,
          fid: getSignedInFid(),
        },
        drafts,
      );
      if (local) {
        recordSelfAnswered(
          requestLog,
          parsed,
          route,
          local,
          bodyPreviewOf(parsed),
        );
        return local;
      }
    }

    // A route the classification calls `node` is read from a node — whatever
    // HTTP method the fork spells it with, and whichever server is live.
    //
    // `POST /v2/feed-items` is the one that spells a read as a write (a read
    // with a body), and it is assembled from the follow graph (`linksByFid` →
    // `castsByFid`) and from nothing else. No non-node server in this catalog
    // can serve it: Neynar's index keeps no follow graph, and Farcaster's own
    // public server refuses a non-GET by name. So it is not a provider's read to
    // answer, and a provider's refusal must not be able to stand in for it.
    //
    // MEASURED (2026-10-21, live public node, `farcaster-public` live): a cold
    // load or a reload of `/` replaced the whole home column with `POST
    // /v2/feed-items is a write, and Farcaster's own public server does not take
    // writes from this client.` and it stayed there for the whole 60s budget and
    // 20s beyond it, while the node answered every read it was handed (770 reads
    // in one measured run, all 200). Reaching that state needs no fault: the
    // checks measure every server at once and land on `farcaster-public`
    // whenever the node's first probe is slow or fails, then hold that choice
    // through a 60s cooldown. Measured again at this seam on the landed tree
    // (2026-10-21, `providers/__tests__/providerFetch.test.ts`): the same 501,
    // with the routing log attributing the feed to `farcaster-public`.
    //
    // The other node-only reads the same sentence used to cover — a cast's
    // thread, a profile, a channel, the notifications tally, the unseen counts —
    // are this same rule one route over, and they are answered from a node here
    // too: a surface that can be served must not fail because the server the
    // failover engine happens to be holding cannot assemble it. The surfaces
    // that genuinely have no node source (ranked feeds, search, the direct-cast
    // inbox, the channel directory) are `hosted` and are still refused in one
    // set of words below.
    if (
      provider !== null &&
      provider.kind !== 'snapchain' &&
      route.kind === 'node'
    ) {
      const capable = firstCapableProvider({
        kind: route.kind,
        path,
        preferred: provider,
      });
      // A server that really can assemble this read answers it (Neynar's index
      // for the paths it keeps — `capabilities.ts`); otherwise it is a node's.
      if (capable === null || capable.kind === 'snapchain') {
        const node = capable ?? nodeForNodeOnlyRead();
        log.push({ path, providerId: node.id, kind: 'snapchain' });
        const response = await nodeAdapter(node).fetch(parsed.url.toString(), {
          method: parsed.method,
          ...(parsed.body !== undefined
            ? { body: JSON.stringify(parsed.body) }
            : {}),
        });
        // The node answered this read (or did not), and the failover engine is
        // told exactly that — the same signal every other answered read gives.
        onRead?.(node.id, response.status < 500);
        return response;
      }
    }

    // Farcaster's own public server cannot be read from a web page at all —
    // measured on the live site: eleven distinct reads, every one of them
    // refused by CORS (see `publicServerOffTheWeb`). So it is refused here
    // rather than asked. The reader gets a sentence about the read itself
    // instead of "Failed to fetch", and no request leaves the page for an
    // origin that will throw it away.
    //
    // It counts as a failed read through `onRead`, exactly like any other 5xx
    // answer: this server did not answer the read, and the engine should be
    // able to move the reader onto a node because of it. (The measurement also
    // fixed the other half of this: `probeFarcasterPublic` now asks a read this
    // client actually makes, so in a page this server is measured as not
    // answering and is never made live in the first place.)
    //
    // It fires only for the requests this server would really have been the one
    // to answer: a route the table calls `node` is answered a few lines above,
    // from a node, so the sentence below is about the reads and writes that
    // genuinely have no other source.
    //
    // This sits before the classification's own hosted refusal and before the
    // routing decision below, and for the same reason: when this server is the
    // one the reader is on, the honest sentence names *both* whose job the
    // request is and the measured fact that a page cannot read this server at
    // all (`publicServerCannotAnswer` puts the route's own reason first). A
    // write through it is refused by name too, whatever else is in the list —
    // it takes no writes from a web page either.
    if (provider !== null && provider.kind === 'farcaster-public') {
      // The routing log keeps it: this request WAS routed to that provider, and
      // the provider could not answer it — that is the fact worth recording.
      log.push({ path, providerId: provider.id, kind: provider.kind });
      const refusal = errorResponse(
        PUBLIC_SERVER_OFF_THE_WEB_STATUS,
        publicServerCannotAnswer(route),
      );
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        refusal,
        bodyPreviewOf(parsed),
      );
      onRead?.(provider.id, refusal.status < 500);
      return refusal;
    }

    // A read only an INDEX can answer, on a list that holds no index that serves
    // it: the honest answer is the routing table's own sentence for the route
    // ("search runs on an index — a read node keeps no search index"), not a
    // provider's generic note about itself. MEASURED (the 501 sweep,
    // 2026-10-22): before this, an index route with no capable server fell
    // through to whichever provider was live and came back with that provider's
    // own list of what it covers — true, but about the server rather than about
    // the read the reader asked for.
    if (provider !== null && route.kind === 'index') {
      const capable = firstCapableProvider({
        kind: route.kind,
        path,
        preferred: provider,
      });
      if (capable === null) {
        const refusal = hostedRefusal(route);
        recordSelfAnswered(
          requestLog,
          parsed,
          route,
          refusal,
          bodyPreviewOf(parsed),
        );
        return refusal;
      }
    }

    // A request no server in this catalog answers is refused in one set of words,
    // before any provider sees it — an unclassified write says "no writer has been
    // written", a read says "no reader". Both name the real gap instead of a
    // provider's generic excuse.
    if (route.kind === 'hosted') {
      const refusal = hostedRefusal(route);
      recordSelfAnswered(
        requestLog,
        parsed,
        route,
        refusal,
        bodyPreviewOf(parsed),
      );
      return refusal;
    }

    if (provider === null) {
      // Nothing has been measured yet (or the reader's list is empty). The
      // build's own node is the honest answer, exactly as before this file —
      // writes included, which is why the label is the neutral one.
      const node = buildConfiguredNode();
      log.push({ path, providerId: node.id, kind: 'snapchain' });
      return nodeAdapter(node).fetch(parsed.url.toString(), {
        method: parsed.method,
        ...(parsed.body !== undefined
          ? { body: JSON.stringify(parsed.body) }
          : {}),
      });
    }

    // WHICH SERVER ANSWERS THIS ONE
    //
    // The order says which server the reader prefers; this decides which one can
    // answer the request in front of us, and the two are not the same question
    // (`capabilities.ts`). Two rules, both honest:
    //
    //   - A WRITE goes to the preferred server and nowhere else. A write commits
    //     something under the reader's name; if their server cannot carry it,
    //     they get that server's own refusal rather than this client silently
    //     posting through another machine.
    //   - A READ may go to the first server on their list that can serve it.
    //     That is what makes "Neynar is the default" workable: Neynar's index has
    //     profiles, threads and casts but not the follow-graph feed, so the feed
    //     is read from the node behind it instead of failing on the default.
    const answerer =
      route.kind === 'write'
        ? provider
        : (firstCapableProvider({
            kind: route.kind,
            path,
            preferred: provider,
          }) ?? provider);

    log.push({ path, providerId: answerer.id, kind: answerer.kind });

    // `init.headers` is deliberately not forwarded to a provider that is not a
    // node: what the client attaches is this device's session with Fiddy's own
    // API, and handing that to a third-party server is how a token leaks.
    //
    // The entry is created before the answer so a write has somewhere to record
    // what it signed (a node provider's adapter keeps its own, over this same
    // sink); it is pushed for a non-node provider, whose requests nothing else
    // in the client records.
    const entry: RequestLogEntry = {
      method: parsed.method,
      path: parsed.url.pathname,
      kind: route.kind,
    };
    if (answerer.kind !== 'snapchain') {
      requestLog.push(entry);
    }
    const response = await answer(parsed, answerer, route, entry);
    if (answerer.kind !== 'snapchain') {
      entry.status = response.status;
      Object.assign(entry, bodyPreviewOf(parsed));
    }
    // A 5xx is the provider failing; a 4xx is this client asking for something
    // that provider does not serve, which is our bug to fix, not a reason to
    // move the reader's feed to another machine.
    onRead?.(answerer.id, response.status < 500);
    return response;
  }) as typeof fetch;

  return { fetch: providerBackedFetch, log };
};
