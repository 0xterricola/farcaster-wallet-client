/**
 * A `fetch` that answers the fork's hosted-API calls from your own node.
 *
 * WHY A FETCH
 *
 * The client's data layer is one class (`FarcasterApiClient`) with ~700
 * endpoint methods, and the app's pages and hooks sit on top of it. Rewriting
 * them is not the job; changing where their bytes come from is. The one seam
 * that every request already passes through is the `fetch` handed to the
 * client (`FarcasterApiClientOptions.getFetch`), so this wraps it:
 *
 *        host request → classify (hostedRoutes) → node reader → hosted shape
 *
 * Everything downstream — react-query keys, hooks, components — is untouched,
 * which is exactly what "behind a clean adapter" has to mean here.
 *
 * WHAT IT REFUSES TO DO
 *
 * - It never answers a request it has no real source for with an empty success.
 *   Those come back as the hosted API's own error envelope (HTTP 501) with a
 *   sentence saying whose job the endpoint is, so the UI can show a truthful
 *   line instead of "there is nothing here".
 * - It never falls through to `farcaster.xyz` when the node fails. Falling
 *   through would silently mix two data sources and hand the user someone
 *   else's session requirement half way through a page.
 *
 * THE WRITES IT ANSWERS
 *
 * Two, and neither is a read:
 *
 * - `POST /v1/generate-image-upload-url` is the media pipeline. The answer names
 *   our own media host (`mediaUploadUrl`, see `mediaUpload.ts`), which really
 *   stores the bytes; the composer then uploads to it and keeps the URL it gets
 *   back. Everything else about media that belongs to Warpcast's pipeline (video
 *   transcoding, attachment resolution) still says so.
 * - every route in `hostedRoutes.ts`'s `write` table — the heart, the recast
 *   action, Follow/Unfollow and the composer's Cast. They are answered by
 *   `nodeWrites.ts`, which builds the protocol message, signs it with this
 *   device's app key, submits it to the node, and reads the node's own state
 *   back before it says the write landed.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';

import {
  clientFilterPolicyInUse,
  knownClientsInUse,
} from '~/snapchain/clientFilterPreferences';
import { mutesInUse } from '~/snapchain/mutePreferences';
import { THIS_CLIENT_APP_FID } from '~/snapchain/thisClientApp';

import { type EmbedCardResolver } from './embedCards';
import { type EmbedKindResolver } from './embedKinds';
import { classifyHostedRequest, type HostedRouteMatch } from './hostedRoutes';
import { answerLocalDraftRequest, LocalDraftStore } from './localDrafts';
import { mediaUploadUrl } from './mediaUpload';
import {
  type ManagedPoster,
  NodeBackedWrites,
  type WriteApproval,
  type WriteEvidence,
  writeIntentFor,
} from './nodeWrites';
import { isPublicFeedKey, windowFromFeedType } from './publicFeedWindow';
import {
  castAuthorOf,
  type CastCountsSink,
  channelParentUrlFor,
  NodeBackedReads,
  NodeCannotAnswerError,
} from './reads';

export interface NodeBackedFetchOptions {
  /** The node's base URL, already resolved (proxy path in the browser). */
  nodeBaseUrl: string;
  /** The signed-in FID, if this device has one. */
  getSignedInFid: () => number | undefined;
  /** Requests to the node. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Reads, injectable so tests can drive them without a network. */
  reads?: NodeBackedReads;
  /** Cap on paged counts. */
  countCap?: number;
  /**
   * How each embed URL's media type is decided (see `embedKinds.ts`), so a
   * photo renders as a photo instead of a link card. Defaults to the real
   * thing — bounded probes of the URLs themselves, cached per session.
   * Injectable so a test can answer without a network.
   */
  embedKinds?: EmbedKindResolver;
  /**
   * How each link embed's own page is read, for its title, its picture and its
   * mini-app card (see `embedCards.ts`). Defaults to the real thing: one
   * bounded, cached read per URL. The provider seam hands in a resolver that
   * can also ask the reader's index when a page refuses to be read.
   */
  embedCards?: EmbedCardResolver;
  /** How long one read to the node may take. Defaults to NODE_READ_TIMEOUT_MS. */
  readTimeoutMs?: number;
  /**
   * Where our own media host takes uploads. Defaults to this build's media
   * host (`VITE_FIDDY_MEDIA_URL`, else https://fiddy.fun); injectable so a test
   * can point at a local instance without an env.
   */
  mediaUploadUrl?: string;
  /**
   * Where cast drafts are kept (this browser, one list per signed-in FID).
   * Defaults to a store over `localStorage`; injectable so a test can use a
   * storage of its own (the test runner has no `window`).
   */
  drafts?: LocalDraftStore;
  /**
   * The app key this device signs writes with, per account. Defaults to the
   * store the one-time "Issue app key" step writes to
   * (`~/snapchain/appKeyStorage`); injectable so a test can drive a write
   * without a browser.
   */
  getAppKeyHex?: (fid: number) => Promise<string | null>;
  /**
   * The posting key the person granted Fiddy in their own Farcaster app
   * (`~/snapchain/accounts/managedConnect`), used *before* this device's own
   * key. Defaults to that module; `null` turns the granted-key path off (a
   * probe that must exercise the device key), and a fake is injectable so a
   * test can drive a granted-key write without a network.
   */
  managedPoster?: ManagedPoster | null;
  /**
   * Asked when a write arrives with no key to sign it, so the reader can approve
   * a posting key where they are instead of being sent to Advanced
   * (`~/snapchain/accounts/postingKeyApproval` is the app's own). Defaults to
   * none, so a test or a probe that must see the bare refusal can leave it out;
   * `null` says the same thing out loud.
   */
  askForPostingKey?: WriteApproval | null;
  /**
   * The server's plain name, used by the sentences a write's failures are
   * phrased in ("your node would not accept this like: …").
   */
  nodeLabel?: string;
  /**
   * Where a feed page's engagement counts go when they arrive behind its paint.
   *
   * With this in hand `POST /v2/feed-items` answers a page built WITHOUT its
   * like/recast counts and reads them afterwards (`reads.ts` `readCastCounts`),
   * handing the whole pass here when it lands — see the card this exists for:
   * a cold first cast used to wait ~5.5 s on the slowest per-cast count read.
   * Without it the page carries its counts, exactly as before. The app that
   * renders counts is the one that registers this
   * (`~/hooks/data/useCountsBehindSink`, wired in
   * `~/contexts/WebFarcasterApiClientProvider`), because only it knows where a
   * late count has to land.
   */
  onCountsRead?: CastCountsSink;
  /**
   * Where a write records what it submitted and whether the node's state showed
   * it. Defaults to the request log below, so a probe reads it from the same
   * place it reads everything else.
   */
  onWriteEvidence?: (evidence: WriteEvidence) => void;
  /**
   * Where this adapter appends what it classified. Defaults to an array of its
   * own. The provider layer passes one shared sink here so that whichever layer
   * answered a request — the node adapter, or the provider seam above it — the
   * page's debug surface reads one continuous log (`scripts/verify-media-upload.mjs`
   * depends on that: the cast payload is only visible there).
   */
  log?: RequestLogEntry[];
}

/**
 * How long a single read to your node may take before the adapter stops waiting.
 *
 * MEASURED (2026-10-20, a live public read node, exactly the feed's fan-out: 60
 * accounts × `pageSize=10` at concurrency 12): p50 **258 ms**, p90 759 ms,
 * p95 **773 ms**, p99 986 ms, max **986 ms**; a cold first read 819 ms. Ten
 * seconds is an order of magnitude above the worst healthy read, so a read that
 * has not been answered in ten seconds is a read the node is not answering —
 * while still leaving room for a slow-but-alive node.
 *
 * This is the *second* deadline, not the first: the client already times every
 * endpoint out itself (`DEFAULT_TIMEOUT_FEED_ITEMS` = 5 s, threads/notifications
 * 10 s — see `farcaster-client-data`'s `constants/endpointTimeouts`) and passes
 * that `AbortSignal` in. This one only covers reads the client gives no deadline
 * for, and any read still in flight after the client has stopped waiting.
 */
export const NODE_READ_TIMEOUT_MS = 10_000;

/** The sentence a read that ran out of time is answered with. */
export const nodeDidNotAnswerWithin = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Your node did not answer this read within ${seconds} s.`;
};

/** A read the adapter stopped waiting for. */
export class NodeReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no reply within ${timeoutMs}ms`);
    this.name = 'NodeReadTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Is this failure the read's deadline running out?
 *
 * The node client answers a failed fetch with `NodeUnreachableError`
 * (`packages/farcaster-node-client/src/errors.ts`), which folds the cause's
 * message into its own and does not keep the cause object — so the timeout is
 * also recognised by the sentence this file writes, not only by its type.
 */
export const isNodeReadTimeout = (error: unknown): boolean =>
  error instanceof NodeReadTimeoutError ||
  (error instanceof Error && /no reply within \d+ms/.test(error.message));

/** The hosted API's error envelope. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * The answer every `hosted` route gets: the hosted API's error envelope with the
 * classification's own sentence, which the UI shows as written.
 *
 * Exported because one of those routes used to be answered by the provider seam
 * as well as by this adapter — `POST /v2/casts`, which is now a real write
 * (`nodeWrites.ts`) rather than a refusal. The export stays because a provider
 * that cannot take writes still refuses in this shape, and a test asserts it.
 */
export const hostedRefusal = (route: HostedRouteMatch): Response =>
  errorResponse(501, route.why);

/**
 * What a node says when the app catalog is asked of it.
 *
 * A mini app is a web page that carries an `fc:miniapp` tag — it is not a
 * message, so a Snapchain node stores no list of apps, no favourites and no
 * app search. The honest answer names the source that does have one and the one
 * thing the reader can do about it, instead of the old "no reader has been
 * written for this endpoint yet", which told them nothing and read like a bug
 * in Fiddy rather than a fact about nodes.
 */
export const NODE_CANNOT_LIST_APPS =
  'A node keeps no list of mini apps — a mini app is a web page, not a message. The list comes from Neynar’s public app catalog: add your own Neynar key under Advanced, or pick Neynar there, and it will load.';

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Where this device's app key lives — loaded only when a write actually
 * happens.
 *
 * Dynamic on purpose: the key store is `localforage`-backed browser storage,
 * and a *read* has no business pulling a storage engine into the module graph.
 * A build with no key store at all (a test runner, an odd browser) then fails
 * inside one write's answer — as a sentence about the key — instead of taking
 * the whole client down at import time.
 */
const appKeyFromThisDevice = async (fid: number): Promise<string | null> => {
  const { loadAppKey } = await import('~/snapchain/appKeyStorage');
  return loadAppKey(fid);
};

/**
 * The granted posting key, when this account has one: `~/snapchain/accounts/
 * managedConnect`, imported on the same terms as the app key store above (only
 * when a write actually happens). If that module cannot be loaded at all, the
 * answer is "no granted key" — so the write falls back to this device's own key
 * rather than failing, which is exactly what a build without the accounts
 * surface should do.
 */
const grantedPosterFromThisDevice: ManagedPoster = {
  available: async (fid: number): Promise<boolean> => {
    try {
      const { canWriteThroughConnect } =
        await import('~/snapchain/accounts/managedConnect');
      return await canWriteThroughConnect(fid);
    } catch {
      return false;
    }
  },
  post: async (write) => {
    const { writeThroughConnect } =
      await import('~/snapchain/accounts/managedConnect');
    return writeThroughConnect(write);
  },
};

/**
 * Protocol limits, not server data: these are the Farcaster cast limits and the
 * client's own capabilities. Answering them locally is the truth — the hosted
 * API is reporting the same constants.
 */
const LOCAL_USER_APP_CONTEXT = {
  canAddLinks: true,
  showConnectedApps: false,
  signerRequestsEnabled: false,
  prompts: [] as string[],
  castActions: [] as unknown[],
  canAddCastAction: false,
  canEditAllChannels: false,
  adminForChannelKeys: [] as string[],
  modOfChannelKeys: [] as string[],
  memberOfChannelKeys: [] as string[],
  canUploadVideo: false,
  regularCastByteLimit: 320,
  longCastByteLimit: 1024,
  castEmbedLimit: 2,
  // The one notification tab this client serves. Everything else the hosted
  // API offers (invites, wallet, mini apps) is not on the node.
  notificationTabsV2: [{ id: 'default', name: 'All' }],
  higherClientEventSamplingRateEnabled: false,
  castShareEnabledMiniApps: [] as unknown[],
};

interface ParsedRequest {
  url: URL;
  method: string;
  body?: unknown;
}

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

/**
 * The caller's own deadline, whether it was handed in as `init.signal` or on a
 * `Request` object. The fork's client always uses the `init` form; a `Request`
 * is accepted too because `fetch` accepts one and dropping its signal here would
 * silently restore the old "never settles" behaviour for that caller.
 */
const requestSignal = (
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | undefined => {
  if (init?.signal) {
    return init.signal;
  }
  if (typeof input === 'object' && input !== null && 'signal' in input) {
    return (input as Request).signal;
  }
  return undefined;
};

export interface RequestLogEntry {
  method: string;
  path: string;
  kind: HostedRouteMatch['kind'];
  /** The status this adapter answered with, when it answered locally. */
  status?: number;
  /**
   * A bounded preview of the request body for a request this adapter answered
   * (or refused) itself — what a write asked for, e.g. the embeds a composer
   * submitted. Only kept when the debug surface is on; never sent anywhere.
   */
  bodyPreview?: string;
  /**
   * For a write: what was signed, which server was asked to carry it, and
   * whether that server's own state showed it afterwards. This is the evidence a
   * probe reads — a node's ack alone is not evidence that anything happened
   * (see `nodeWrites.ts`). Never sent anywhere.
   */
  write?: WriteEvidence;
}

export interface NodeBackedFetchHandle {
  fetch: typeof fetch;
  reads: NodeBackedReads;
  /** Every classification made, newest last — evidence for the parity doc. */
  log: RequestLogEntry[];
}

/** How much of a write's body the debug log keeps. */
export const REQUEST_BODY_PREVIEW_LIMIT = 2000;

/**
 * A probe surface for the page, off unless a build asks for it.
 *
 * `VITE_SNAPCHAIN_DEBUG=true` puts the classification log on
 * `window.__nodeBackedRequests`, which is how `scripts/verify-media-upload.mjs`
 * reads back the cast payload the composer built: the adapter answers writes
 * inside the page, so no network trace can show what was submitted. Nothing
 * leaves the tab, and a normal build never sets the flag.
 */
export const isRequestDebugEnabled = (
  env: Record<string, unknown> = import.meta.env,
): boolean =>
  String(env.VITE_SNAPCHAIN_DEBUG ?? '')
    .trim()
    .toLowerCase() === 'true';

/**
 * The media pipeline's answer, in one place.
 *
 * The hosted API mints a signed CDN upload URL here (`POST
 * /v1/generate-image-upload-url`); we hand back our own upload endpoint
 * instead. The shape is kept (`url` + `optimisticImageId`) because that is what
 * `useFetchImageUploadUrl` and the composer read; the id is a fresh random
 * value that our own path never uses — the composer recognises this URL as ours
 * and reads the final URL back from the upload response (`mediaUpload.ts`).
 *
 * Exported because two layers can be the one that answers: the node adapter's
 * `case 'media'`, and the provider seam above it (`providers/providerFetch`),
 * which is where a request lands when the reader's live server is not a node.
 * The media pipeline belongs to neither: the same bytes must go to the same
 * host whichever machine answers today's feed, so both layers must give exactly
 * this answer, and a test can assert it without a page.
 */
export const mediaUploadAnswer = (
  target: string = mediaUploadUrl(),
): Response =>
  jsonResponse({
    result: {
      url: target,
      optimisticImageId:
        globalThis.crypto?.randomUUID?.() ??
        `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });

/**
 * Build the adapter. The returned `fetch` has the platform's signature, so it
 * drops straight into the client's options.
 */
export const createNodeBackedFetch = ({
  nodeBaseUrl,
  getSignedInFid,
  fetchImpl,
  reads,
  countCap,
  embedKinds,
  embedCards,
  readTimeoutMs = NODE_READ_TIMEOUT_MS,
  mediaUploadUrl: mediaUploadUrlOption,
  drafts: draftsOption,
  getAppKeyHex: getAppKeyHexOption,
  managedPoster: managedPosterOption,
  askForPostingKey: askForPostingKeyOption,
  nodeLabel = 'your node',
  onCountsRead,
  onWriteEvidence,
  log: logOption,
}: NodeBackedFetchOptions): NodeBackedFetchHandle => {
  const nodeFetch = fetchImpl ?? fetch;
  // `window.fetch` has to be called with `this === window`: passing the bare
  // function along and calling it as `this.fetch(...)` on the node client
  // throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal
  // invocation` — measured, and it is what made every request the adapter
  // answered come back 502 ("your node did not answer") even though the node
  // was fine. The client's own provider binds for the same reason; do it here
  // so the seam is safe for every caller.
  const boundFetch = (nodeFetch as (...args: unknown[]) => unknown).bind(
    globalThis,
  ) as typeof fetch;
  // Every read to the node goes out under this deadline, so a node that never
  // answers fails as a read instead of holding a socket open: the abort reaches
  // the fetch, and the failure is named as a timeout rather than as whatever
  // the engine calls an abort. The node client's own timeout is set to the same
  // number below, so a read has one deadline, from one place.
  const readFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, readTimeoutMs);
    return (
      boundFetch(input, {
        ...(init ?? {}),
        signal: controller.signal,
      }) as Promise<Response>
    )
      .catch((error: unknown) => {
        // Our deadline, or the node client's identical one, cut the read.
        if (timedOut || init?.signal?.aborted) {
          throw new NodeReadTimeoutError(readTimeoutMs);
        }
        throw error;
      })
      .finally(() => clearTimeout(deadline));
  }) as typeof fetch;
  // The node client takes its own narrow fetch signature (a string URL and a
  // `Uint8Array` body for protobuf writes). A platform `fetch` satisfies it at
  // runtime; the cast is the shape difference, not a behaviour one.
  const nodeClient = new SnapchainNodeClient({
    baseUrl: nodeBaseUrl,
    fetch: readFetch as unknown as FetchLike,
    timeoutMs: readTimeoutMs,
  });
  const reader =
    reads ??
    new NodeBackedReads({
      node: nodeClient,
      nodeBaseUrl,
      fetchImpl: readFetch,
      getSignedInFid,
      // Which app made each cast, and which apps this reader wants to see: both
      // are read fresh on every request from the stores that own them
      // (`clientFilterPreferences`, kept in step with storage by the app shell),
      // so a filter changed on the settings screen applies to the very next
      // page without this adapter being rebuilt. A reader with no preferences
      // loaded filters nothing.
      thisAppFid: THIS_CLIENT_APP_FID,
      knownClients: knownClientsInUse,
      clientFilter: clientFilterPolicyInUse,
      // The reader's own mutes, blocks and hidden words. Protocol messages carry
      // none of it and a node stores none of it, so this is the only thing that
      // can make "hide this person" true of a node-assembled feed — read fresh
      // on every request from the store the app shell keeps in step with
      // storage, so saving a mute changes the very next page with no reload.
      mutes: mutesInUse,
      ...(countCap ? { countCap } : {}),
      ...(embedKinds ? { embedKinds } : {}),
      ...(embedCards ? { embedCards } : {}),
    });

  const log: RequestLogEntry[] = logOption ?? [];
  // Off unless a build sets VITE_SNAPCHAIN_DEBUG=true; see isRequestDebugEnabled.
  const debugEnabled = isRequestDebugEnabled();
  if (debugEnabled) {
    (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests =
      log;
  }

  const mediaUploadTarget = mediaUploadUrlOption ?? mediaUploadUrl();
  const mediaAnswer = (): Response => mediaUploadAnswer(mediaUploadTarget);
  // One store per adapter; the provider seam keeps its own over the same
  // browser storage, so both layers read the same drafts.
  const drafts = draftsOption ?? new LocalDraftStore();

  /**
   * A writer for one write — wired to that write's own request-log entry.
   *
   * Built per write rather than once per adapter on purpose: the evidence
   * ("this is the message that was signed, this is the server that was asked,
   * this is whether its state showed it") belongs to one request, and a probe
   * reads it next to the request it came from. Writes are user actions, so the
   * construction is not on any hot path, and it keeps the writer free of state
   * that two overlapping writes could mix up.
   */
  const writerFor = (entry: RequestLogEntry): NodeBackedWrites =>
    new NodeBackedWrites({
      nodeBaseUrl,
      nodeLabel,
      // The write carries its own deadline (the node client's), so it is not
      // put under the read deadline here: a read must fail fast, a write must
      // get its answer.
      fetchImpl: boundFetch,
      getAppKeyHex: getAppKeyHexOption ?? appKeyFromThisDevice,
      ...(managedPosterOption === null
        ? {}
        : {
            managedPoster: managedPosterOption ?? grantedPosterFromThisDevice,
          }),
      ...(askForPostingKeyOption === null ||
      askForPostingKeyOption === undefined
        ? {}
        : { askForPostingKey: askForPostingKeyOption }),
      castAuthor: castAuthorOf,
      channelParentUrl: channelParentUrlFor,
      apiCastFor: (message) => reader.apiCastFor(message),
      onEvidence: (evidence) => {
        entry.write = evidence;
        onWriteEvidence?.(evidence);
      },
    });

  const answer = async (
    { url, method, body }: ParsedRequest,
    route: HostedRouteMatch,
    entry: RequestLogEntry,
  ): Promise<Response> => {
    const searchParams = url.searchParams;

    switch (route.kind) {
      case 'hosted':
        return hostedRefusal(route);

      case 'media':
        return mediaAnswer();

      case 'catalog':
        // The app catalog is an indexer's job and a node keeps none of it:
        // saying so here (rather than falling through to the node's own
        // readers) is what keeps the mini-app surfaces honest when there is no
        // index to read from. See `hostedRoutes.ts` and `capabilities.ts`.
        return errorResponse(501, NODE_CANNOT_LIST_APPS);

      case 'index':
        // A read only an index can answer (the quotes of a cast, casts by hash
        // alone, the mute list, search). The node is honestly the wrong machine,
        // and the sentence the routing table wrote for this route is the one a
        // person reads — the provider seam asks the index first, and only a
        // reader with no index reaches this.
        return hostedRefusal(route);

      case 'market':
        // A token's market is not a node's read at all: it comes from a public
        // market index (`~/snapchain/providers/marketIndex`), and the provider
        // seam answers it before any provider sees it. A node adapter reached
        // with no seam above it refuses in the routing table's own words rather
        // than claiming a reader is missing.
        return hostedRefusal(route);

      case 'write': {
        // The write half of this seam: this device signs it and the node
        // carries it, then the node's own state is read back before the answer
        // is given. See `nodeWrites.ts`.
        const intent = writeIntentFor({ method, path: route.path, body });
        const answer = await writerFor(entry).answer({
          method,
          path: route.path,
          body,
          fid: getSignedInFid(),
        });
        // A like or recast that really landed is folded into the viewer's own
        // reaction set, which the reads memoise for a minute: the heart the
        // person just pressed, and the one they just took back, have to be drawn
        // that way by the NEXT page or thread read, without either of them
        // paying to re-read the viewer's whole reaction log. A write that failed
        // changes nothing — the client's own optimistic patch is reverted for
        // exactly the same reason (`useCreateCastLike`).
        if (answer.ok && intent !== null && intent.kind === 'reaction') {
          reader.noteViewerReaction({
            castHash: intent.castHash,
            reactionType: intent.reaction === 'like' ? 'Like' : 'Recast',
            added: intent.add,
          });
        }
        return answer;
      }

      case 'local':
        return localAnswer({
          path: route.path,
          method,
          searchParams,
          body,
          reads: reader,
          drafts,
        });

      case 'node':
        break;
    }

    try {
      switch (route.path) {
        case '/v2/me': {
          const fid = reader.requireFid();
          const user = await reader.readUser(fid);
          return jsonResponse({ result: { user, enabledFeatureFlags: [] } });
        }

        case '/v2/user':
        case '/v2/user-by-fid': {
          const fid = Number(searchParams.get('fid'));
          if (!Number.isFinite(fid)) {
            return errorResponse(400, 'This read needs a fid.');
          }
          return jsonResponse({
            result: userProfile(await reader.readUser(fid), fid),
          });
        }

        case '/v2/user-by-username': {
          const username = searchParams.get('username') ?? '';
          const user = await reader.readUserByUsername(username);
          if (!user) {
            return errorResponse(
              404,
              `No account holds the handle ${username}.`,
            );
          }
          return jsonResponse({ result: userProfile(user, user.fid) });
        }

        case '/v2/user-casts':
        case '/v2/profile-casts':
        case '/v2/casts': {
          // Three names, one read. `/v2/profile-casts` is what the profile
          // surfaces ask for and `/v2/casts` what the casts-and-replies tab
          // asks for (`fid`, `cursor`, `limit` — the client's own signature,
          // `ApiGetUserCastsAndRepliesQueryParams`); the node serves all three
          // from `castsByFid`. MEASURED (the 501 sweep, 2026-10-22): those pages
          // were showing the adapter's shrug because nobody had classified the
          // second and third names for the same reader.
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 25);
          const casts = await reader.readUserCasts({ fid, limit });
          return jsonResponse({ result: { casts }, next: {} });
        }

        case '/v2/verifications': {
          const fid = Number(searchParams.get('fid'));
          const verifications = await reader.readVerifications(fid);
          return jsonResponse({ result: { verifications } });
        }

        case '/v2/thread-casts': {
          const castHash = searchParams.get('castHash') ?? '';
          const limit = Number(searchParams.get('limit') ?? 15);
          return jsonResponse({
            result: await reader.readThread({ castHash, limit }),
          });
        }

        case '/v2/cast-recasters': {
          const castHash = searchParams.get('castHash') ?? '';
          const cursor = searchParams.get('cursor') ?? undefined;
          const limit = Number(searchParams.get('limit') ?? 15);
          const { users, nextCursor } = await reader.readCastRecasters({
            castHash,
            cursor,
            limit,
          });
          return jsonResponse({
            result: { users },
            next: nextCursor ? { cursor: nextCursor } : {},
          });
        }

        case '/v2/cast-likes': {
          const castHash = searchParams.get('castHash') ?? '';
          const cursor = searchParams.get('cursor') ?? undefined;
          const limit = Number(searchParams.get('limit') ?? 15);
          const { likes, nextCursor } = await reader.readCastLikes({
            castHash,
            cursor,
            limit,
          });
          return jsonResponse({
            result: { likes },
            next: nextCursor ? { cursor: nextCursor } : {},
          });
        }

        case '/v2/unseen':
          return jsonResponse({ result: await reader.readUnseen() });

        case '/v1/notifications-for-tab': {
          const groups = await reader.readNotifications({});
          return jsonResponse({ result: { notifications: groups } });
        }

        case '/v2/channel': {
          const key = searchParams.get('key') ?? '';
          return jsonResponse({
            result: { channel: channelFromKey(key, reader) },
          });
        }

        case '/v2/get-blocked-users': {
          const fid = reader.requireFid();
          const limit = Number(searchParams.get('limit') ?? 25);
          const { blockedUsers, cursor } = await reader.readBlockedUsers({
            fid,
            limit,
          });
          return jsonResponse({
            result: { blockedUsers },
            ...(cursor ? { next: { cursor } } : { next: {} }),
          });
        }

        case '/v2/storage-utilization': {
          const fid = reader.requireFid();
          return jsonResponse({
            result: {
              storageUtilization: await reader.readStorageUtilization({ fid }),
            },
          });
        }

        // The follow graph, both ways, from this node's own follow links —
        // MEASURED (2026-10-22): `linksByTargetFid` and `linksByFid` with
        // `link_type=follow` answer the two tabs that were showing the adapter's
        // shrug for want of a reader. The cursor is the node's own page token,
        // passed straight through: a client that pages asks the next question
        // with it, and nothing is re-numbered on the way.
        case '/v2/followers': {
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 25);
          const cursor = searchParams.get('cursor') ?? undefined;
          const { users, cursor: next } = await reader.readFollowers({
            fid,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          return jsonResponse({
            result: { users },
            ...(next ? { next: { cursor: next } } : { next: {} }),
          });
        }

        case '/v2/following': {
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 25);
          const cursor = searchParams.get('cursor') ?? undefined;
          const { users, cursor: next } = await reader.readFollowing({
            fid,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          return jsonResponse({
            result: {
              users,
              // Who you interact with *least* is a ranking this client does not
              // compute and the node does not keep, so the summary is empty
              // rather than invented — the list above is the honest answer, and
              // no surface is told a number nobody measured.
              leastInteractedWith: { count: 0, users: [] },
            },
            ...(next ? { next: { cursor: next } } : { next: {} }),
          });
        }

        // The accounts one account follows that also follow another — the
        // "followers you know" tab. Both halves are the node's own follow links
        // (`readFollowersYouKnow`), so this is not a hosted read at all.
        case '/v2/followers-you-know': {
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 20);
          const { users, totalCount } = await reader.readFollowersYouKnow({
            fid,
            limit,
          });
          return jsonResponse({ result: { users, totalCount }, next: {} });
        }

        // One group of the notifications tab, filled from the same node
        // messages the tab itself is built from (`readNotificationGroup`).
        case '/v2/notification-group': {
          const groupId = searchParams.get('groupId') ?? '';
          const limit = Number(searchParams.get('limit') ?? 25);
          return jsonResponse({
            result: {
              notifications: await reader.readNotificationGroup({
                groupId,
                limit,
              }),
            },
            next: {},
          });
        }

        // One account's snaps: its own casts, kept to the snaps channel's
        // parent URL (`readSnapCasts`). MEASURED (2026-10-22): the channel is
        // `https://warpcast.com/~/channel/snaps` on the network.
        case '/v2/profile-snap-casts': {
          const fid = Number(searchParams.get('fid'));
          const limit = Number(searchParams.get('limit') ?? 15);
          return jsonResponse({
            result: { casts: await reader.readSnapCasts({ fid, limit }) },
            next: {},
          });
        }

        // A cast page reached by its own address (a username and the first
        // characters of a hash). A node shards casts by author, so the account
        // is resolved first and its casts walked — bounded, and a prefix that
        // matches nothing is a 404 in plain words rather than an invented cast.
        case '/v2/user-cast': {
          const cast = await userCastFromAddress(reader, searchParams);
          if (cast === undefined) {
            return errorResponse(
              404,
              'Your node has no cast of that account starting with those characters.',
            );
          }
          return jsonResponse({ result: { cast } });
        }

        // The thread a cast page draws: the same cast, its ancestors and its
        // replies. Resolving the cast by its address fills the hash → author
        // memo `readThread` needs, which is why the two reads are one call apart.
        case '/v2/user-thread-casts': {
          const cast = await userCastFromAddress(reader, searchParams);
          if (cast === undefined) {
            return errorResponse(
              404,
              'Your node has no cast of that account starting with those characters.',
            );
          }
          return jsonResponse({
            result: await reader.readThread({ castHash: cast.hash }),
          });
        }

        case '/v2/feed-items': {
          const requestBody = (body ?? {}) as {
            feedKey?: string;
            feedType?: string;
            olderThan?: number;
            limit?: number;
            updateState?: boolean;
          };
          // The browse surfaces (`/feed`, `/explore`) ask with the public feed
          // key, because the window a signed-out visitor reads is not anyone's
          // follow graph: it is anchored on named public accounts and needs no
          // session at all (`reads.ts`, `readPublicFeed`). Everything else is
          // the viewer's own feed and does need one.
          if (isPublicFeedKey(requestBody.feedKey)) {
            const window = windowFromFeedType(requestBody.feedType);
            return jsonResponse({
              result: await reader.readPublicFeed({
                kind: window.kind,
                topic: window.topic,
                ...(requestBody.olderThan !== undefined
                  ? { olderThan: requestBody.olderThan }
                  : {}),
              }),
            });
          }
          const result = await reader.readFeed({
            feedKey: requestBody.feedKey ?? 'home',
            ...(requestBody.feedType ? { feedType: requestBody.feedType } : {}),
            ...(requestBody.olderThan !== undefined
              ? { olderThan: requestBody.olderThan }
              : {}),
            ...(requestBody.limit !== undefined
              ? { limit: requestBody.limit }
              : {}),
            ...(requestBody.updateState !== undefined
              ? { updateState: requestBody.updateState }
              : {}),
            // A page that can have its counts read behind it is answered behind
            // them; with no sink registered the page carries its own counts.
            ...(onCountsRead ? { onCounts: onCountsRead } : {}),
          });
          return jsonResponse({ result });
        }

        default:
          // The one sentence a read that reached the node and has no reader says.
          // It must be true (nothing was faked, and no source was invented) and
          // it must read as a state of the app rather than as a note to a
          // programmer — the 501 sweep found the old wording ("No node-backed
          // reader has been written for this endpoint yet") on 48 signed-in
          // surfaces a person reaches deliberately.
          return errorResponse(
            501,
            `Fiddy can’t read ${route.path} yet: this read has no reader wired up in this app. Nothing was faked and nothing was sent — your account is untouched.`,
          );
      }
    } catch (error) {
      if (error instanceof NodeCannotAnswerError) {
        // The hosted API's own error envelope, so the client turns this into a
        // HandledFetchError with this sentence in `message` — a component with
        // an error branch can show it as written.
        return errorResponse(501, error.message);
      }
      if (isNodeReadTimeout(error)) {
        // A node that never answers is the one failure the generic 502 sentence
        // reads badly for: say how long the wait was, because that is the fact
        // the user needs (the node is not slow, it is silent).
        return errorResponse(502, nodeDidNotAnswerWithin(readTimeoutMs));
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(
        502,
        `Your node did not answer this read: ${message}`,
      );
    }
  };

  /**
   * Wait for `work`, but stop when the caller's own deadline fires.
   *
   * The fork's client times every endpoint out itself: it builds an
   * `AbortController`, hands the signal to the fetch it was given, and aborts at
   * the endpoint's configured timeout (`DEFAULT_TIMEOUT_FEED_ITEMS` = 5 s, and
   * 10 s for threads and notifications — `farcaster-client-data`'s
   * `constants/endpointTimeouts`). MEASURED, at the state of this card: that
   * abort did nothing at all, because this adapter never looked at
   * `init.signal` — the client's own promise never settled, no request ever
   * failed, and the feed stayed in its loading state for as long as the page was
   * open. Honouring it is what makes the client's deadline real.
   *
   * The read itself is not cancelled mid-flight: it is already bounded by the
   * per-read deadline above, and its failure (or its success) is simply no
   * longer what the caller is waiting for.
   */
  const raceClientDeadline = (
    work: Promise<Response>,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<Response> => {
    if (!signal) {
      return work;
    }
    if (signal.aborted) {
      // Nobody is waiting for this read any more, so its outcome is only
      // interesting to the log; it must not surface as an unhandled rejection.
      void work.catch(() => undefined);
      return Promise.resolve(
        errorResponse(502, nodeDidNotAnswerWithin(Date.now() - startedAt)),
      );
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        resolve(
          errorResponse(502, nodeDidNotAnswerWithin(Date.now() - startedAt)),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };

  const nodeBackedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const startedAt = Date.now();
    const parsed = await parseRequest(input, init);
    const route = classifyHostedRequest({
      method: parsed.method,
      path: parsed.url.pathname,
    });
    const entry: RequestLogEntry = {
      method: parsed.method,
      path: parsed.url.pathname,
      kind: route.kind,
    };
    log.push(entry);
    const response = await raceClientDeadline(
      answer(parsed, route, entry),
      requestSignal(input, init),
      startedAt,
    );
    entry.status = response.status;
    // What a request the adapter answered itself actually carried. The request
    // never leaves the page, so this is the only way a probe can see the cast
    // payload a composer built. A write is kept even when the node is the one
    // asked: what a write was going to submit is the question a probe has, and
    // reading it costs nothing when the debug surface is on.
    const isWrite = parsed.method !== 'GET' && parsed.method !== 'HEAD';
    if (
      debugEnabled &&
      parsed.body !== undefined &&
      (route.kind !== 'node' || isWrite)
    ) {
      try {
        entry.bodyPreview = JSON.stringify(parsed.body).slice(
          0,
          REQUEST_BODY_PREVIEW_LIMIT,
        );
      } catch {
        /* a body that cannot be serialised is not worth failing the request for */
      }
    }
    return response;
  }) as typeof fetch;

  return { fetch: nodeBackedFetch, reads: reader, log };
};

/** `ApiUserProfile`: the user plus the fields the profile page reads. */
const userProfile = (
  user: Awaited<ReturnType<NodeBackedReads['readUser']>>,
  fid: number,
) => ({
  user,
  collectionsOwned: [],
  // `custodyAddress` is an on-chain fact this read does not fetch. Empty rather
  // than invented; nothing in the signed-in surfaces renders it.
  extras: { fid, custodyAddress: '' },
});

/**
 * A cast addressed the way a cast page addresses it: `@username` + a hash prefix.
 *
 * A node cannot be asked for a cast by hash alone (it shards by author), so the
 * account is resolved first and its own casts are walked for a hash with that
 * prefix. Undefined means this node has no such cast — the caller says so in
 * plain words rather than rendering an empty page that reads as "nothing here".
 */
const userCastFromAddress = async (
  reader: NodeBackedReads,
  searchParams: URLSearchParams,
): Promise<
  Awaited<ReturnType<NodeBackedReads['readUserCastByHashPrefix']>>
> => {
  const username = searchParams.get('username') ?? '';
  // The two routes this helper serves name the prefix differently, each after
  // its own client signature: `useUserCast` sends `hashPrefix`
  // (`ApiGetUserCastQueryParams`), while the cast-page thread read sends
  // `castHashPrefix` (`ApiGetUserThreadCastsQueryParams`). Reading only the
  // second name left `/v2/user-cast` answering 404 for every prefix page it was
  // asked for, however real the cast was; both names are read here.
  const hashPrefix =
    searchParams.get('hashPrefix') ?? searchParams.get('castHashPrefix') ?? '';
  if (username.length === 0 || hashPrefix.length === 0) {
    return undefined;
  }
  const user = await reader.readUserByUsername(username);
  if (!user) {
    return undefined;
  }
  return await reader.readUserCastByHashPrefix({ fid: user.fid, hashPrefix });
};

/**
 * A channel object from its key.
 *
 * The node has no channel directory (measured: `/v1/channel` and
 * `/v1/channelDetails` are 404 on a live node), so the name and image the hosted
 * API would return cannot be read. What *can* be stated is the key and the
 * parent URL the channel's casts carry; everything else is left at its neutral
 * value instead of being made up.
 */
const channelFromKey = (key: string, reader: NodeBackedReads) => ({
  type: 'channel' as const,
  key,
  name: key,
  showCastSourceLabels: false,
  showCastTags: false,
  sectionRank: 0,
  subscribable: false,
  viewerContext: {
    following: false,
    isMember: false,
    hasUnseenItems: false,
  },
  // Kept in the object so callers can see where the casts come from without
  // reading this file.
  parentUrl: reader.channelParentUrl(key),
});

const localAnswer = async ({
  path,
  method,
  searchParams,
  body,
  reads,
  drafts,
}: {
  path: string;
  method: string;
  searchParams: URLSearchParams;
  body: unknown;
  reads: NodeBackedReads;
  drafts: LocalDraftStore;
}): Promise<Response> => {
  // Drafts first: this device's own state, answered from the real store in
  // `localDrafts.ts`. A store that cannot be written says so (501) rather than
  // reporting a save that did not happen.
  const draftAnswer = answerLocalDraftRequest(
    { method, path, searchParams, body, fid: reads.signedInFid() },
    drafts,
  );
  if (draftAnswer) {
    return draftAnswer;
  }

  switch (path) {
    case '/v2/user-app-context':
      return jsonResponse({ result: { context: LOCAL_USER_APP_CONTEXT } });

    case '/v2/user-preferences':
      // Every field of these preferences is an email toggle. This client sends
      // no email, so the honest answer is "no preferences", not a fake set.
      return jsonResponse({ result: { preferences: {} } });

    case '/v2/snap/blocklist':
    case '/v2/frame-blocklist':
      return jsonResponse({ result: [] });

    case '/v2/mark-all-notifications-read':
    case '/v2/mark-tab-notifications-seen': {
      const fid = reads.requireFid();
      reads.markSeen(fid, 'notifications');
      return jsonResponse({ result: { success: true } });
    }

    case '/v2/feed-seen': {
      const feeds =
        ((body ?? {}) as { feeds?: { feedKey?: string }[] }).feeds ?? [];
      const fid = reads.requireFid();
      for (const feed of feeds) {
        reads.markSeen(fid, feed.feedKey ?? 'home');
      }
      return jsonResponse({ result: { success: true } });
    }

    default:
      // A local route with no local answer is a routing bug, and saying so is
      // better than an empty 200.
      return errorResponse(500, `No local answer for ${path}.`);
  }
};

export { NodeCannotAnswerError };
