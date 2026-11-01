/**
 * Writes, through whichever server the reader's client is pointed at.
 *
 * THE BUG THIS FILE EXISTS FOR
 *
 * MEASURED (2026-10-21, the live client, signed in): pressing the heart on a
 * cast answered
 *
 *     UpdateCastLikeError — createCastLike 501
 *     no node-backed reader has been written for this endpoint yet
 *     Request: PUT /v2/cast-likes
 *
 * The reader was reading Farcaster fine; the *write* had no answer anywhere in
 * the seam. The reads half of `~/snapchain/nodeApi` was built and measured; the
 * write half — likes, follows, recasts, and the cast submit itself — was not,
 * so `PUT /v2/cast-likes` fell through the routing table's unknown-path branch
 * and was refused with an apology about a reader.
 *
 * WHAT A WRITE IS HERE
 *
 * A Farcaster write is a *signed message*: the client builds it with the app
 * key this device already holds for the account (the one-time "Issue app key"
 * step on Advanced), signs it locally, and hands the bytes to a node at
 * `POST /v1/submitMessage`. The node gossips it to validators. So the same
 * three builders the Advanced screen's own composer uses
 * (`buildReactionAddMessage`, `buildLinkAddMessage`, `buildCastAddMessage`)
 * are what every surface in the app now goes through:
 *
 *     client write (PUT /v2/cast-likes, POST /v2/casts, …)
 *       → this device signs it            (the app key, never a server)
 *       → POST {node}/v1/submitMessage    (the live provider's node)
 *       → READ IT BACK from that node     (see below)
 *       → the hosted API's own answer shape (pages and hooks untouched)
 *
 * WHY THE READ-BACK IS NOT OPTIONAL
 *
 * MEASURED (2026-10-21, both a public read node and Neynar's node): a message
 * signed by a key that was never registered for the FID it claims passes
 * `/v1/validateMessage` — the node says `{"valid":true}` — and is rejected only
 * when it is *merged*, with
 *
 *     bad_request.validation_failure/invalid signer
 *
 * A node's ack is therefore not evidence that anything happened, and this file
 * refuses to treat it as evidence: after a successful submit it asks the same
 * node for the resulting *state* (the cast's reactions, the follow edge, the
 * cast itself) and only calls the write done when the state shows it. A write
 * the node accepted but is not showing is answered as exactly that, in those
 * words, rather than as a success the reader would find was not there.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never reports success from the node's 200 alone (above).
 * - It never invents a target: a reaction or a reply needs the *author* of the
 *   cast it is about, because a node addresses a cast by author + hash. The
 *   author comes from `~/snapchain/nodeApi/reads`' shared index (every cast the
 *   client has served) or from the resolver the provider supplies (Neynar's
 *   index can look a hash up); when neither knows it, the refusal says which
 *   page would make it work instead of guessing a FID.
 * - It never signs with anything but this device's own app key: no key is
 *   generated here, no custody key is touched, and nothing is sent when there
 *   is no key — it says which one-time step is missing.
 */

import type { ApiCast } from 'farcaster-client-data';
import {
  buildCastAddMessage,
  buildLinkAddMessage,
  buildLinkRemoveMessage,
  buildReactionAddMessage,
  buildReactionRemoveMessage,
  type FetchLike,
  hexToBytes,
  isMissingOnNode,
  isNodeApiError,
  isNodeUnreachableError,
  type NodeMessage,
  SnapchainNodeClient,
} from 'farcaster-node-client';

/** The hosted API's error envelope, same as every other layer's. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** What the client asked for, once it is read as a protocol write. */
export type WriteIntent =
  | {
      kind: 'reaction';
      /** `add` is a like/recast; anything else undoes it. */
      add: boolean;
      reaction: 'like' | 'recast';
      /** The cast the reaction is about, by hash — its author is resolved later. */
      castHash: string;
    }
  | { kind: 'link'; add: boolean; targetFid: number }
  | {
      kind: 'cast';
      text: string;
      /** A reply: the parent, by hash, with its author when the client knows it. */
      parentHash?: string;
      parentFid?: number;
      /** A channel cast: the client's channel key, e.g. `farcaster`. */
      channelKey?: string;
      /** A channel cast addressed by its parent URL directly. */
      parentUrl?: string;
      embeds: string[];
    };

/**
 * What the client wants done, read from the request it made — pure, so the
 * mapping is a test rather than a promise.
 *
 * The paths are the fork's own data layer's (`farcaster-client-data`), which is
 * what every component in this app calls; nothing else in Fiddy speaks this
 * vocabulary, and each of these is the write the UI says it is:
 *
 *   PUT    /v2/cast-likes   the heart, pressed on       → REACTION_ADD  (like)
 *   DELETE /v2/cast-likes   the heart, pressed again    → REACTION_REMOVE
 *   PUT    /v2/recasts      the recast action           → REACTION_ADD  (recast)
 *   DELETE /v2/recasts      undo a recast               → REACTION_REMOVE
 *   PUT    /v2/follows      Follow                     → LINK_ADD
 *   DELETE /v2/follows      Unfollow                    → LINK_REMOVE
 *   POST   /v2/casts        the composer's Cast         → CAST_ADD
 */
export const writeIntentFor = ({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body: unknown;
}): WriteIntent | null => {
  const record = (body ?? {}) as Record<string, unknown>;
  const castHash = typeof record.castHash === 'string' ? record.castHash : '';
  const targetFid =
    typeof record.targetFid === 'number' ? record.targetFid : undefined;
  const add = method.toUpperCase() === 'PUT';

  switch (path) {
    case '/v2/cast-likes':
    case '/v2/recasts': {
      if (castHash.length === 0) {
        return null;
      }
      return {
        kind: 'reaction',
        add,
        reaction: path === '/v2/recasts' ? 'recast' : 'like',
        castHash,
      };
    }

    case '/v2/follows': {
      if (targetFid === undefined) {
        return null;
      }
      return { kind: 'link', add, targetFid };
    }

    case '/v2/casts': {
      const text = typeof record.text === 'string' ? record.text : '';
      const parent = (record.parent ?? null) as { hash?: unknown } | null;
      const parentHash =
        parent && typeof parent.hash === 'string' ? parent.hash : undefined;
      const parentFid =
        parent && typeof (parent as { fid?: unknown }).fid === 'number'
          ? ((parent as { fid: number }).fid as number)
          : undefined;
      const parentUrl =
        typeof record.parentUrl === 'string' ? record.parentUrl : undefined;
      const channelKey =
        typeof record.channelKey === 'string' ? record.channelKey : undefined;
      const embeds = Array.isArray(record.embeds)
        ? record.embeds.filter(
            (embed): embed is string => typeof embed === 'string',
          )
        : [];
      return {
        kind: 'cast',
        text,
        embeds,
        ...(parentHash === undefined ? {} : { parentHash }),
        ...(parentFid === undefined ? {} : { parentFid }),
        ...(parentUrl === undefined ? {} : { parentUrl }),
        ...(channelKey === undefined ? {} : { channelKey }),
      };
    }

    default:
      return null;
  }
};

/**
 * What happened to one write, kept on the adapter's own request log so a probe
 * (or a person reading the debug overlay) can see it: the message that was
 * signed, the node that was asked, and whether the node's own state showed it
 * afterwards. Never sent anywhere.
 */
export interface WriteEvidence {
  /** The server that was asked to carry the message, in plain words. */
  node: string;
  /** The URL it was submitted to. */
  nodeBaseUrl: string;
  /** `MESSAGE_TYPE_REACTION_ADD`, … as the node itself echoed it back. */
  messageType?: string;
  /** The signed message's hash, as submitted. */
  messageHash?: string;
  /** Did the node accept the message (`submitMessage` answered)? */
  accepted: boolean;
  /**
   * Did the node's own state show it afterwards? `null` when the read-back
   * could not be made at all (the write was refused before it was submitted).
   */
  landed: boolean | null;
  /** What the read-back looked at, so "landed" is checkable. */
  readbackPath?: string;
  /** The node's own words, when it refused or when the read-back disagreed. */
  refusal?: string;
}

/**
 * The other way a write can be carried: by the posting key the person granted
 * Fiddy in their own Farcaster app ("Connect your Farcaster account").
 *
 * When that exists, this device holds no key at all — the service that does
 * holds it — and this interface is the whole of what this file knows about it:
 * whether a connection exists *for this account*, and how to hand over one
 * write. It is defined here, rather than imported from the accounts surface, so
 * this module depends on nothing but the shape (and a test can pass three lines
 * of fake).
 */
export interface ManagedWrite {
  kind: 'cast' | 'reaction' | 'link';
  text?: string;
  /** The cast a reaction is about, by hash. */
  castHash?: string;
  reaction?: 'like' | 'recast';
  /** `add` is a like/recast/follow; false undoes it. */
  add?: boolean;
  targetFid?: number;
  parentHash?: string;
  parentUrl?: string;
  embeds?: string[];
}

export interface ManagedPoster {
  /** Is there a granted posting key for *this* account, right now? */
  available: (fid: number) => Promise<boolean>;
  /** Hand one write over. A cast's hash comes back; other writes have none. */
  post: (
    write: ManagedWrite,
  ) => Promise<
    | { ok: true; hash: string | null }
    | { ok: false; status: number; message: string }
  >;
}

/**
 * What a write is, in the words a person would use for it. The writer derives
 * it from the intent it already classified, so the screen that asks for a key
 * can say what the person was doing ("your like") without knowing the protocol
 * — and `change` is the honest name for undoing something.
 */
export type WriteApprovalLabel =
  | 'like'
  | 'recast'
  | 'follow'
  | 'post'
  | 'change';

/**
 * The third way a write with no key can be answered: ask the person to approve
 * a posting key *where they are*, and — if they do — carry the very same write.
 *
 * Defined here, as a shape, for the same reason `ManagedWrite` is: this module
 * depends on nothing but what it needs, and the implementation
 * (`~/snapchain/accounts/postingKeyApproval`, which puts the approval screen up)
 * satisfies it structurally. A test can therefore pass three lines of fake and
 * assert the writer's half without a browser or a service.
 */
export interface WriteApprovalRequest {
  /** The signed-in account the write belongs to. */
  fid: number;
  /** What the person was doing, for the sentence that asks them. */
  label: WriteApprovalLabel;
  /**
   * Carry the write that has been waiting. Called *only* after the approval
   * really happened; its answer is the answer the original request gets, so a
   * like that is approved here reports what a like reports when a key was
   * already present — including a refusal, if the node refuses it.
   */
  carry: () => Promise<Response>;
}

/**
 * The asker. `null` means the person did not approve (they said not now, the
 * screen went away, or they took longer than the asker was willing to wait), and
 * the write keeps the sentence it has always had.
 */
export type WriteApproval = (
  request: WriteApprovalRequest,
) => Promise<Response | null>;

export interface NodeBackedWritesOptions {
  /** The node that will carry the message — the live provider's own address. */
  nodeBaseUrl: string;
  /** That server's plain name, for the sentences a person reads. */
  nodeLabel: string;
  /** Extra headers that server needs (Neynar's own node wants `x-api-key`). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** How long one write may take end to end. Defaults to 20 s. */
  timeoutMs?: number;
  /**
   * The app key this device signs with, per account. Returns null when this
   * device has none — which is a state the reader can fix, and the refusal says
   * where.
   */
  getAppKeyHex: (fid: number) => Promise<string | null>;
  /** The author of a cast this client has already seen (shared index). */
  castAuthor: (hash: string) => number | undefined;
  /**
   * A provider that can look a cast up by hash alone. Neynar's index can; a
   * node cannot. Optional, and never the only path — see the refusal.
   */
  resolveCastAuthor?: (hash: string) => Promise<number | undefined>;
  /** A channel key as the parent URL the protocol wants. */
  channelParentUrl?: (key: string) => string;
  /** The hosted cast shape, from the message the node stored. */
  apiCastFor?: (message: NodeMessage) => Promise<ApiCast | undefined>;
  /** How many times the state read-back is attempted before it is called absent. */
  readbackAttempts?: number;
  /** How long between those attempts. */
  readbackIntervalMs?: number;
  /** Sleep seam, for tests that must not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Where evidence of the write is recorded (the adapter's request log). */
  onEvidence?: (evidence: WriteEvidence) => void;
  /**
   * The granted posting key, when this account has one. Checked *before* the
   * device's own key, because a person who connected their account never had to
   * make one — and the sentence they would otherwise read ("issue an app key in
   * Advanced") would be about a step they do not need.
   */
  managedPoster?: ManagedPoster;
  /**
   * Asked when a write arrives with no key to sign it — and only then.
   *
   * With this wired, a reader who presses the heart before they have ever
   * approved a posting key is not sent to Advanced: the pending write is handed
   * to this asker, which puts one friendly approval screen in front of them
   * (`~/components/session/SignerApprovalGate`) and answers with the carried
   * write. A null answer, or no asker at all, leaves the refusal exactly as it
   * was — see `withoutAKey`.
   *
   * Asked **once** per write: the carried write is answered with `allowAsk:
   * false`, so a retry that still has no key cannot loop back into the screen.
   */
  askForPostingKey?: WriteApproval | null;
}

/** Default deadline for one write, end to end (submit + read-back). */
export const WRITE_TIMEOUT_MS = 20_000;

/**
 * How long to wait for a write to become visible in the node's own state.
 *
 * MEASURED (2026-10-21): a node merges a message it accepts as part of the
 * submit call, so the read-back for a reaction or a follow answers on the first
 * ask. Eight attempts at 400 ms is 3.2 s — room for a node under load, and far
 * short of the point where a reader believes nothing happened.
 */
const READBACK_ATTEMPTS = 8;
const READBACK_INTERVAL_MS = 400;

/**
 * How far a reaction read-back will walk.
 *
 * MEASURED (2026-10-21, live, Neynar's own node *and* the public relay): a node
 * hands back **at most 200 reactions per page** whatever `pageSize` asks for
 * (pageSize=100 returned 200), and a page is in the node's own index order —
 * *not* newest-first (page 1 of a 215-like cast ran from timestamp 182745086 to
 * 182872702). A one-page read-back therefore could not see this device's own
 * like on a popular cast, and would answer "the node is not showing it" for a
 * like that really landed — or, worse, answer that an *undo* had landed while
 * the reaction was still sitting on page 3.
 *
 * So the read-back pages until it finds the answer, hits the end of the list, or
 * runs out of the pages it is willing to walk — and a state it could not reach
 * the end of is `unknown`, which is never reported as a success.
 */
const REACTION_READBACK_PAGE_SIZE = 200;
const REACTION_READBACK_PAGES = 5;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The sentence for "this device has no key it may sign with, yet". */
export const NO_APP_KEY =
  'This device has no key it may sign for you with yet, so nothing was signed and nothing was sent. Open Advanced → Your own setup and press “Issue app key” once; after that your likes, casts and follows are signed here rather than by a server.';

/** The sentence for a write whose target's author this client has never seen. */
export const UNKNOWN_CAST_AUTHOR =
  'A node addresses a cast by its author and its hash, and this client has not read who wrote this one. Open the cast from your feed or a profile first, then try again.';

/**
 * What the person was doing, in their own words — from the intent the writer
 * already classified.
 *
 * A unit test pins this mapping, because it is the one thing the approval
 * screen's sentence depends on: asking somebody to approve posting for a
 * *like* when they pressed Follow would be a small lie in the wrong place.
 */
export const approvalLabelFor = (intent: WriteIntent): WriteApprovalLabel => {
  if (intent.kind === 'cast') {
    return 'post';
  }
  if (intent.kind === 'link') {
    return intent.add ? 'follow' : 'change';
  }
  return intent.add ? intent.reaction : 'change';
};

/**
 * How a write carried by a *granted* posting key is named, in the evidence log
 * and in the sentences a person reads. It is named as what it is to them — the
 * thing they switched on — rather than as the endpoint it happens to be.
 */
const MANAGED_LABEL = 'The posting key you granted Fiddy';
const MANAGED_BASE_URL = '/api/fiddy/connect/write';

export class NodeBackedWrites {
  private readonly node: SnapchainNodeClient;
  private readonly nodeBaseUrl: string;
  private readonly nodeLabel: string;
  private readonly options: NodeBackedWritesOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NodeBackedWritesOptions) {
    this.options = options;
    this.nodeBaseUrl = options.nodeBaseUrl.replace(/\/+$/, '');
    this.nodeLabel = options.nodeLabel;
    this.sleep = options.sleep ?? defaultSleep;
    this.node = new SnapchainNodeClient({
      baseUrl: this.nodeBaseUrl,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetchImpl
        ? { fetch: options.fetchImpl as unknown as FetchLike }
        : {}),
      timeoutMs: options.timeoutMs ?? WRITE_TIMEOUT_MS,
    });
  }

  /**
   * Answer a write, or explain why it cannot be answered. `fid` is the
   * signed-in account; a write is always *somebody's*, and a write with nobody
   * signed in has no author to sign it.
   */
  async answer({
    method,
    path,
    body,
    fid,
  }: {
    method: string;
    path: string;
    body: unknown;
    fid: number | undefined;
  }): Promise<Response> {
    return this.answerWith({ method, path, body, fid }, true);
  }

  /**
   * The write, and who may be asked about it.
   *
   * `allowAsk` is the loop breaker. The first attempt at a write may put the
   * approval screen up; the attempt that runs *after* an approval may not. If
   * that second attempt still finds no key — an approval that was not really
   * there, a service that lost the connection — it is refused in the sentence
   * it has always been refused in, rather than asking the same person again.
   */
  private async answerWith(
    {
      method,
      path,
      body,
      fid,
    }: {
      method: string;
      path: string;
      body: unknown;
      fid: number | undefined;
    },
    allowAsk: boolean,
  ): Promise<Response> {
    const intent = writeIntentFor({ method, path, body });
    if (intent === null) {
      return errorResponse(
        501,
        `No node-backed writer has been written for ${method} ${path} yet.`,
      );
    }

    if (fid === undefined) {
      return errorResponse(
        501,
        'No account is signed in on this device, so there is nobody to write as.',
      );
    }

    // A key THIS DEVICE holds is used first: it is signed here, so the write
    // does not depend on any service being reachable — and a copy of Fiddy a
    // person runs themselves hands its key to the browser for exactly this
    // (`server/instance/connect.mjs`, adopted in `ConnectSheet`), so the same
    // press on the same account must not go back out over the wire to be signed
    // by a process on the same box.
    const appKeyHex = await this.appKeyFor(fid);
    if (appKeyHex === null || appKeyHex.length === 0) {
      // Then a granted posting key: a person who connected their account on
      // fiddy.fun holds no key here, and never needs to.
      const managed = this.options.managedPoster;
      if (managed !== undefined && (await managed.available(fid))) {
        return this.viaManaged({ intent, fid, managed });
      }

      return this.withoutAKey({ intent, fid, method, path, body, allowAsk });
    }
    const signerPrivateKey = hexToBytes(appKeyHex);

    try {
      switch (intent.kind) {
        case 'reaction':
          return await this.reaction({ intent, fid, signerPrivateKey });
        case 'link':
          return await this.link({ intent, fid, signerPrivateKey });
        case 'cast':
          return await this.cast({ intent, fid, signerPrivateKey });
      }
    } catch (error) {
      return this.failureResponse(intent, error);
    }
  }

  /**
   * A write this device has no key for — the one place the reader is offered a
   * way forward instead of a sentence about Advanced.
   *
   * MEASURED (2026-10-21, the live client, signed in, no pass): the composer
   * reaches `POST /v2/casts` and the heart reaches `PUT /v2/cast-likes`; both
   * were answered `501` with `NO_APP_KEY`, which names a screen two taps away
   * from where the person is standing. So, when an asker is wired (it is, in the
   * app — `~/snapchain/accounts/postingKeyApproval`), the pending write is
   * handed over *whole*: the asker puts one approval screen up, and the same
   * request is answered again once the person has approved it. The reader gets
   * the like they pressed, and the caller gets the answer a like always gets.
   *
   * Everything else is unchanged, on purpose: with nobody to ask, an asker that
   * cannot be reached, a person who says not now, or an approval that did not
   * really happen, this answers exactly what it answered before — the same
   * status, the same sentence, the same evidence entry, and nothing signed.
   */
  private async withoutAKey({
    intent,
    fid,
    method,
    path,
    body,
    allowAsk,
  }: {
    intent: WriteIntent;
    fid: number;
    method: string;
    path: string;
    body: unknown;
    allowAsk: boolean;
  }): Promise<Response> {
    const ask = this.options.askForPostingKey;
    if (allowAsk && ask !== undefined && ask !== null) {
      let carried: Response | null;
      try {
        carried = await ask({
          fid,
          label: approvalLabelFor(intent),
          // The same request, answered again — and this time it may not ask.
          carry: () => this.answerWith({ method, path, body, fid }, false),
        });
      } catch (error) {
        // The approval screen itself failed. That is a write that could not be
        // carried, in the node's own words where there are any.
        return this.failureResponse(intent, error);
      }
      if (carried !== null) {
        return carried;
      }
    }

    this.evidence({
      node: this.nodeLabel,
      nodeBaseUrl: this.nodeBaseUrl,
      accepted: false,
      landed: null,
      refusal: NO_APP_KEY,
    });
    return errorResponse(501, NO_APP_KEY);
  }

  // ------------------------------------------------------------- the writes

  /**
   * A write carried by the granted posting key.
   *
   * The three intents keep the same shapes, the same refusals and — the part
   * that matters — the same read-back: after the service says the network took
   * it, this client still asks the *node* whether the account's own state shows
   * it, and says "accepted, not showing it yet" rather than "posted" when it
   * does not. The one thing that changes is who signs: this device does not.
   */
  private async viaManaged({
    intent,
    fid,
    managed,
  }: {
    intent: WriteIntent;
    fid: number;
    managed: ManagedPoster;
  }): Promise<Response> {
    try {
      switch (intent.kind) {
        case 'reaction':
          return await this.reactionViaManaged({ intent, fid, managed });
        case 'link':
          return await this.linkViaManaged({ intent, fid, managed });
        case 'cast':
          return await this.castViaManaged({ intent, fid, managed });
      }
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      this.evidence({
        node: MANAGED_LABEL,
        nodeBaseUrl: MANAGED_BASE_URL,
        accepted: false,
        landed: null,
        refusal,
      });
      return errorResponse(
        502,
        `${MANAGED_LABEL} failed on this write: ${refusal}`,
      );
    }
  }

  // -------------------------------------------------- writes: through the key
  //                                                     the person granted us

  private async reactionViaManaged({
    intent,
    fid,
    managed,
  }: {
    intent: Extract<WriteIntent, { kind: 'reaction' }>;
    fid: number;
    managed: ManagedPoster;
  }): Promise<Response> {
    // The service addresses a cast by its hash alone, but the read-back below
    // does not: a node addresses a cast by its author and its hash. So the
    // author is still resolved *before* the write — never posted and then found
    // unverifiable.
    const targetFid = await this.authorOf(intent.castHash);
    if (targetFid === undefined) {
      return errorResponse(501, UNKNOWN_CAST_AUTHOR);
    }

    const answer = await managed.post({
      kind: 'reaction',
      castHash: intent.castHash,
      reaction: intent.reaction,
      add: intent.add,
    });
    if (!answer.ok) {
      this.evidence({
        node: MANAGED_LABEL,
        nodeBaseUrl: MANAGED_BASE_URL,
        accepted: false,
        landed: null,
        refusal: answer.message,
      });
      return errorResponse(answer.status, answer.message);
    }

    const readbackPath = '/v1/reactionsByCast';
    const landed = await this.readBack(async () => {
      const state = await this.reactionState({
        targetFid,
        castHash: intent.castHash,
        reaction: intent.reaction,
        fid,
      });
      if (state === 'unknown') {
        return false;
      }
      return intent.add ? state === 'shown' : state === 'absent';
    });

    this.evidence({
      node: MANAGED_LABEL,
      nodeBaseUrl: MANAGED_BASE_URL,
      messageType: intent.add
        ? 'MESSAGE_TYPE_REACTION_ADD'
        : 'MESSAGE_TYPE_REACTION_REMOVE',
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${MANAGED_LABEL} took ${intent.add ? 'this' : 'the undo of this'} ${intent.reaction}, but a node is not showing it on that cast yet — so this client cannot say it landed.`,
      );
    }

    if (!intent.add) {
      return jsonResponse({ result: { success: true } });
    }

    return jsonResponse({
      result: {
        like: {
          type: intent.reaction,
          reactor: await this.reactorShape(fid),
          timestamp: Date.now(),
          castHash: intent.castHash,
        },
      },
    });
  }

  private async linkViaManaged({
    intent,
    fid,
    managed,
  }: {
    intent: Extract<WriteIntent, { kind: 'link' }>;
    fid: number;
    managed: ManagedPoster;
  }): Promise<Response> {
    const answer = await managed.post({
      kind: 'link',
      targetFid: intent.targetFid,
      add: intent.add,
    });
    if (!answer.ok) {
      this.evidence({
        node: MANAGED_LABEL,
        nodeBaseUrl: MANAGED_BASE_URL,
        accepted: false,
        landed: null,
        refusal: answer.message,
      });
      return errorResponse(answer.status, answer.message);
    }

    const readbackPath = '/v1/linkById';
    const landed = await this.readBack(async () => {
      try {
        await this.node.linkById({
          fid,
          targetFid: intent.targetFid,
          linkType: 'follow',
        });
        return intent.add;
      } catch (error) {
        if (isMissingOnNode(error)) {
          return !intent.add;
        }
        throw error;
      }
    });

    this.evidence({
      node: MANAGED_LABEL,
      nodeBaseUrl: MANAGED_BASE_URL,
      messageType: intent.add
        ? 'MESSAGE_TYPE_LINK_ADD'
        : 'MESSAGE_TYPE_LINK_REMOVE',
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${MANAGED_LABEL} took ${intent.add ? 'this follow' : 'this unfollow'}, but a node is not showing it yet — so this client cannot say it landed.`,
      );
    }

    return jsonResponse({
      result: { success: true, userAppContext: { canAddLinks: true } },
    });
  }

  private async castViaManaged({
    intent,
    fid,
    managed,
  }: {
    intent: Extract<WriteIntent, { kind: 'cast' }>;
    fid: number;
    managed: ManagedPoster;
  }): Promise<Response> {
    if (intent.text.trim().length === 0) {
      return errorResponse(400, 'A cast needs some text.');
    }

    let parentUrl = intent.parentUrl;
    if (parentUrl === undefined && intent.channelKey !== undefined) {
      parentUrl = this.options.channelParentUrl?.(intent.channelKey);
      if (parentUrl === undefined) {
        return errorResponse(
          501,
          `This build cannot work out which channel “${intent.channelKey}” is, so it did not post a cast to it. Posting it without the channel would put it somewhere else.`,
        );
      }
    }

    const answer = await managed.post({
      kind: 'cast',
      text: intent.text,
      ...(intent.parentHash === undefined
        ? {}
        : { parentHash: intent.parentHash }),
      ...(parentUrl === undefined ? {} : { parentUrl }),
      embeds: intent.embeds,
    });
    if (!answer.ok) {
      this.evidence({
        node: MANAGED_LABEL,
        nodeBaseUrl: MANAGED_BASE_URL,
        accepted: false,
        landed: null,
        refusal: answer.message,
      });
      return errorResponse(answer.status, answer.message);
    }

    if (answer.hash === null) {
      // Without the hash there is no read-back and no shape to render: the
      // network took it, and this client cannot point at what it took.
      this.evidence({
        node: MANAGED_LABEL,
        nodeBaseUrl: MANAGED_BASE_URL,
        accepted: true,
        landed: null,
      });
      return errorResponse(
        502,
        `${MANAGED_LABEL} took this cast but did not say which cast it is, so this client cannot confirm it is there. Open your profile to see it.`,
      );
    }

    const readbackPath = '/v1/castById';
    let stored: NodeMessage | undefined;
    const landed = await this.readBack(async () => {
      try {
        stored = await this.node.castById({ fid, hash: answer.hash as string });
        return true;
      } catch (error) {
        if (isMissingOnNode(error)) {
          return false;
        }
        throw error;
      }
    });

    this.evidence({
      node: MANAGED_LABEL,
      nodeBaseUrl: MANAGED_BASE_URL,
      messageType: stored?.type ?? 'MESSAGE_TYPE_CAST_ADD',
      messageHash: answer.hash,
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${MANAGED_LABEL} accepted this cast, but a node is not showing it yet — so this client cannot say it posted.`,
      );
    }

    const cast =
      this.options.apiCastFor && stored !== undefined
        ? await this.options.apiCastFor(stored)
        : undefined;
    if (cast === undefined) {
      return errorResponse(
        502,
        `${MANAGED_LABEL} accepted this cast — but this build could not turn the stored message back into a cast to show you. Reload to see it.`,
      );
    }

    return jsonResponse({ result: { cast } });
  }

  // ------------------------------------------------------------- the writes

  private async reaction({
    intent,
    fid,
    signerPrivateKey,
  }: {
    intent: Extract<WriteIntent, { kind: 'reaction' }>;
    fid: number;
    signerPrivateKey: Uint8Array;
  }): Promise<Response> {
    const targetFid = await this.authorOf(intent.castHash);
    if (targetFid === undefined) {
      return errorResponse(501, UNKNOWN_CAST_AUTHOR);
    }

    const options = {
      fid,
      signerPrivateKey,
      reactionType: intent.reaction,
      targetCastId: { fid: targetFid, hash: intent.castHash },
    };
    const built = intent.add
      ? await buildReactionAddMessage(options)
      : await buildReactionRemoveMessage(options);

    const accepted = await this.submit(built.bytes, built.hash);
    if ('response' in accepted) {
      return accepted.response;
    }

    const readbackPath = '/v1/reactionsByCast';
    const landed = await this.readBack(async () => {
      const state = await this.reactionState({
        targetFid,
        castHash: intent.castHash,
        reaction: intent.reaction,
        fid,
      });
      // A like is landed when the account's reaction is in the merged state; an
      // undo is landed when it is gone from it. `unknown` — a list this client
      // could not search to the end — is neither, so it is never a success.
      if (state === 'unknown') {
        return false;
      }
      return intent.add ? state === 'shown' : state === 'absent';
    });

    this.evidence({
      node: this.nodeLabel,
      nodeBaseUrl: this.nodeBaseUrl,
      messageType: accepted.message.type,
      messageHash: accepted.message.hash ?? built.hash,
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${this.nodeLabel} accepted ${intent.add ? 'this' : 'the undo of this'} ${intent.reaction}, but is not showing it on that cast yet — so this client cannot say it landed.`,
      );
    }

    if (!intent.add) {
      return jsonResponse({ result: { success: true } });
    }

    return jsonResponse({
      result: {
        like: {
          type: intent.reaction,
          hash: accepted.message.hash ?? built.hash,
          reactor: await this.reactorShape(fid),
          timestamp: accepted.message.timestampMs ?? Date.now(),
          castHash: intent.castHash,
        },
      },
    });
  }

  private async link({
    intent,
    fid,
    signerPrivateKey,
  }: {
    intent: Extract<WriteIntent, { kind: 'link' }>;
    fid: number;
    signerPrivateKey: Uint8Array;
  }): Promise<Response> {
    const options = {
      fid,
      signerPrivateKey,
      targetFid: intent.targetFid,
      linkType: 'follow',
    };
    const built = intent.add
      ? await buildLinkAddMessage(options)
      : await buildLinkRemoveMessage(options);

    const accepted = await this.submit(built.bytes, built.hash);
    if ('response' in accepted) {
      return accepted.response;
    }

    const readbackPath = '/v1/linkById';
    const landed = await this.readBack(async () => {
      try {
        await this.node.linkById({
          fid,
          targetFid: intent.targetFid,
          linkType: 'follow',
        });
        return intent.add;
      } catch (error) {
        // A node answers 400 `NotFound` for an edge that is not in its merged
        // state — see `isMissingOnNode`. Anything else is a real failure.
        if (isMissingOnNode(error)) {
          return !intent.add;
        }
        throw error;
      }
    });

    this.evidence({
      node: this.nodeLabel,
      nodeBaseUrl: this.nodeBaseUrl,
      messageType: accepted.message.type,
      messageHash: accepted.message.hash ?? built.hash,
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${this.nodeLabel} accepted ${intent.add ? 'this follow' : 'this unfollow'}, but is not showing it yet — so this client cannot say it landed.`,
      );
    }

    // The same shape the hosted API answers both calls with, including the
    // capability flag the client's own hook reads back.
    return jsonResponse({
      result: { success: true, userAppContext: { canAddLinks: true } },
    });
  }

  private async cast({
    intent,
    fid,
    signerPrivateKey,
  }: {
    intent: Extract<WriteIntent, { kind: 'cast' }>;
    fid: number;
    signerPrivateKey: Uint8Array;
  }): Promise<Response> {
    if (intent.text.trim().length === 0) {
      return errorResponse(400, 'A cast needs some text.');
    }

    const parentCastId = await this.parentCastId(intent);
    if (parentCastId === 'unknown') {
      return errorResponse(501, UNKNOWN_CAST_AUTHOR);
    }

    // A channel cast is a cast *to a parent URL*; the client addresses channels
    // by key (`farcaster`), which is a URL on the protocol. Without a way to
    // work that URL out, a channel cast would be posted as a plain top-level
    // cast instead — a different post, so it is refused rather than reshaped.
    let parentUrl = intent.parentUrl;
    if (parentUrl === undefined && intent.channelKey !== undefined) {
      parentUrl = this.options.channelParentUrl?.(intent.channelKey);
      if (parentUrl === undefined) {
        return errorResponse(
          501,
          `This build cannot work out which channel “${intent.channelKey}” is, so it did not post a cast to it. Posting it without the channel would put it somewhere else.`,
        );
      }
    }

    const built = await buildCastAddMessage({
      fid,
      signerPrivateKey,
      text: intent.text,
      ...(parentCastId === undefined ? {} : { parentCastId }),
      ...(parentUrl === undefined ? {} : { parentUrl }),
      embeds: intent.embeds.map((url) => ({ url })),
    });

    const accepted = await this.submit(built.bytes, built.hash);
    if ('response' in accepted) {
      return accepted.response;
    }

    const readbackPath = '/v1/castById';
    const landed = await this.readBack(async () => {
      try {
        await this.node.castById({ fid, hash: built.hash });
        return true;
      } catch (error) {
        if (isMissingOnNode(error)) {
          return false;
        }
        throw error;
      }
    });

    this.evidence({
      node: this.nodeLabel,
      nodeBaseUrl: this.nodeBaseUrl,
      messageType: accepted.message.type,
      messageHash: accepted.message.hash ?? built.hash,
      accepted: true,
      landed,
      readbackPath,
    });

    if (!landed) {
      return errorResponse(
        502,
        `${this.nodeLabel} accepted this cast, but is not showing it yet — so this client cannot say it posted.`,
      );
    }

    const cast = this.options.apiCastFor
      ? await this.options.apiCastFor(accepted.message)
      : undefined;
    if (cast === undefined) {
      // Without the hosted shape there is nothing the composer can render, and
      // an empty object would read as "the cast is blank" rather than as the
      // truth: it posted, and this build could not describe it.
      return errorResponse(
        502,
        `${this.nodeLabel} accepted this cast — but this build could not turn the stored message back into a cast to show you. Reload to see it.`,
      );
    }

    return jsonResponse({ result: { cast } });
  }

  // ------------------------------------------------------------- the plumbing

  /**
   * This device's app key for the account, or null when there is none.
   *
   * A store that cannot be read at all (no storage in this browser, a runner
   * with none) is answered as "no key yet" in plain words rather than thrown:
   * the reader gets the sentence that names the one-time step, and the write
   * fails the way it would have if the key had never been made.
   */
  private async appKeyFor(fid: number): Promise<string | null> {
    try {
      return await this.options.getAppKeyHex(fid);
    } catch (error) {
      this.evidence({
        node: this.nodeLabel,
        nodeBaseUrl: this.nodeBaseUrl,
        accepted: false,
        landed: null,
        refusal: `the app key could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return null;
    }
  }

  /**
   * The author of the cast a write is about: the client's own index first (it
   * is free and it is what the page was rendered from), then the provider's
   * resolver, then nothing — which becomes a sentence, never a guess.
   */
  private async authorOf(hash: string): Promise<number | undefined> {
    const known = this.options.castAuthor(hash);
    if (known !== undefined) {
      return known;
    }
    if (this.options.resolveCastAuthor) {
      return this.options.resolveCastAuthor(hash);
    }
    return undefined;
  }

  private async parentCastId(
    intent: Extract<WriteIntent, { kind: 'cast' }>,
  ): Promise<{ fid: number; hash: string } | undefined | 'unknown'> {
    if (intent.parentHash === undefined && intent.parentFid === undefined) {
      return undefined;
    }
    const fid =
      intent.parentFid ?? (await this.authorOf(intent.parentHash as string));
    if (fid === undefined || intent.parentHash === undefined) {
      return 'unknown';
    }
    return { fid, hash: intent.parentHash };
  }

  /**
   * Hand the signed bytes to the node. A refusal here is the node's own — the
   * caller turns it into a sentence that keeps the node's words.
   */
  private async submit(
    bytes: Uint8Array,
    hash: string,
  ): Promise<{ message: NodeMessage } | { response: Response }> {
    try {
      const message = await this.node.submitMessage(bytes);
      return { message };
    } catch (error) {
      this.evidence({
        node: this.nodeLabel,
        nodeBaseUrl: this.nodeBaseUrl,
        messageHash: hash,
        accepted: false,
        landed: null,
        refusal: error instanceof Error ? error.message : String(error),
      });

      if (isNodeUnreachableError(error)) {
        return {
          response: errorResponse(
            502,
            `${this.nodeLabel} did not answer: ${error.message}`,
          ),
        };
      }
      if (isNodeApiError(error)) {
        // A refused message is this client's problem, not the server's: the
        // node answered, and what it said is what the reader gets, followed by
        // what it usually means when it is a signer problem.
        const meaning = /invalid signer|signer/i.test(`${error.message}`)
          ? ' — the key this device signs with is not one this account has authorised (issue one in Advanced → your setup).'
          : '';
        return {
          response: errorResponse(
            501,
            `${this.nodeLabel} would not accept this write: ${error.message}${meaning}`,
          ),
        };
      }
      return {
        response: errorResponse(
          502,
          `${this.nodeLabel} failed on this write: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
  }

  /**
   * Ask the node's own state whether the write is there, a bounded number of
   * times. `check` returns true when the state shows what was asked for; a
   * thrown error is a real failure and is not retried away.
   */
  private async readBack(check: () => Promise<boolean>): Promise<boolean> {
    const attempts = this.options.readbackAttempts ?? READBACK_ATTEMPTS;
    const interval = this.options.readbackIntervalMs ?? READBACK_INTERVAL_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await check()) {
        return true;
      }
      if (attempt < attempts - 1) {
        await this.sleep(interval);
      }
    }
    return false;
  }

  /**
   * Is this account's reaction on that cast in the node's own state?
   *
   * Three answers, because two would be a lie: `shown`, `absent` (the list was
   * searched to its end and the reaction is not in it) and `unknown` (this
   * client stopped looking before the end). See
   * {@link REACTION_READBACK_PAGE_SIZE} for the measurement behind that.
   */
  private async reactionState({
    targetFid,
    castHash,
    reaction,
    fid,
  }: {
    targetFid: number;
    castHash: string;
    reaction: 'like' | 'recast';
    fid: number;
  }): Promise<'shown' | 'absent' | 'unknown'> {
    let pageToken: string | undefined;

    for (let page = 0; page < REACTION_READBACK_PAGES; page += 1) {
      const messages = await this.node.reactionsByCast({
        targetFid,
        targetHash: castHash,
        reactionType: reaction === 'recast' ? 'Recast' : 'Like',
        pageSize: REACTION_READBACK_PAGE_SIZE,
        ...(pageToken === undefined ? {} : { pageToken }),
      });

      const mine = messages.messages.some(
        (message) => message.fid === fid && message.reaction !== undefined,
      );
      if (mine) {
        return 'shown';
      }

      const next = messages.nextPageToken;
      if (next === undefined || next.length === 0) {
        return 'absent';
      }
      pageToken = next;
    }

    return 'unknown';
  }

  /** The signed-in account, as the reaction's `reactor`. */
  private async reactorShape(fid: number): Promise<unknown> {
    return {
      fid,
      displayName: `fid ${fid}`,
      followerCount: 0,
      followingCount: 0,
      profile: { bio: { text: '', mentions: [] } },
    };
  }

  private evidence(evidence: WriteEvidence): void {
    this.options.onEvidence?.(evidence);
  }

  /** A write that threw: the node's words when there are any, ours when not. */
  private failureResponse(intent: WriteIntent, error: unknown): Response {
    const what =
      intent.kind === 'cast'
        ? 'this cast'
        : intent.kind === 'link'
          ? 'this follow'
          : `this ${intent.reaction}`;
    if (isNodeUnreachableError(error)) {
      return errorResponse(
        502,
        `${this.nodeLabel} did not answer, so ${what} was not sent: ${error.message}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    this.evidence({
      node: this.nodeLabel,
      nodeBaseUrl: this.nodeBaseUrl,
      accepted: false,
      landed: null,
      refusal: message,
    });
    return errorResponse(
      501,
      `This client could not build ${what}: ${message}`,
    );
  }
}
