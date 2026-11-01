/**
 * Cast drafts: this device's own state, kept on this device.
 *
 * DECIDED (t_44070b80): a draft is not Farcaster's data. It is what someone
 * typed and has not sent yet — the same kind of thing as `/v2/feed-seen` and
 * `/v2/snap/blocklist`, both of which this adapter already answers locally.
 * The hosted API's `/v2/draft-caststorms` and `/v2/draft-casts` keep a copy on
 * Warpcast's servers so drafts follow you between Warpcast apps; a client that
 * holds no Warpcast session cannot have that, and inventing a "saved" answer
 * while storing nothing would be a lie at the exact moment a person is trying
 * to send something. So the routes are `local` in `hostedRoutes.ts`, and this
 * is the real store behind them: `localStorage`, one list of drafts per signed
 * in FID (a different account on the same browser must not read yours).
 *
 * MEASURED before this (2026-10-21, headless Chrome, the real composer):
 * `POST /v2/draft-caststorms` came back `501`, the client retried it twice
 * (its own mutation retry limit), and the composer only then reached
 * `POST /v2/casts` — which is `hosted` and says a cast has to be signed, so
 * nothing was posted. The cheap half of that was a draft write that could
 * never succeed in front of every submit; it now succeeds, and the refusal is
 * left to the one endpoint that genuinely cannot work without an app key.
 *
 * The shapes are the hosted API's shapes (`ApiCaststormDraft`, `ApiCastDraft`)
 * because the hooks and the Drafts tab already read those, and nothing about
 * them is server-specific: casts (text + embeds), the parent, the channel, the
 * schedule.
 *
 * Honest failures, all of them:
 *   - no signed-in FID       → 400, said out loud. A draft belongs to an
 *                              account; an anonymous pile of drafts is how one
 *                              person reads another's half-written cast.
 *   - no usable storage      → 501. Private-mode browsers refuse `localStorage`;
 *                              "nothing was saved" is the truth, and the
 *                              composer treats a failed draft save as
 *                              non-fatal and still tries to post.
 *   - a body with no cast     → 400, rather than storing an empty shell.
 */

import type {
  ApiCastBody,
  ApiCastDraft,
  ApiCaststormBody,
  ApiCaststormDraft,
} from 'farcaster-client-data';

/** One list per account, in the browser that person is using. */
const STORAGE_PREFIX = 'fiddy:node-drafts';

/**
 * How many drafts to keep. The hosted API pages these (15 at a time); a device
 * copy is small on purpose — beyond this the oldest is dropped, because a
 * silently growing key in one browser's storage is its own kind of bug.
 */
export const LOCAL_DRAFT_LIMIT = 50;

interface StoredDrafts {
  caststorms: ApiCaststormDraft[];
  casts: ApiCastDraft[];
}

const EMPTY: StoredDrafts = { caststorms: [], casts: [] };

/** This browser's own storage, or nothing when there is none to use. */
export const draftStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Some browsers throw on the property itself, not only on a get.
    return undefined;
  }
};

const newDraftId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCaststormDraft = (value: unknown): value is ApiCaststormDraft =>
  isObject(value) &&
  typeof value.draftId === 'string' &&
  Array.isArray(value.casts) &&
  value.casts.every((cast) => isObject(cast) && typeof cast.text === 'string');

const isCastDraft = (value: unknown): value is ApiCastDraft =>
  isObject(value) &&
  typeof value.draftId === 'string' &&
  isObject(value.cast) &&
  typeof value.cast.text === 'string';

/**
 * The device's drafts for one account.
 *
 * Every method is best-effort in the same way `reads.ts`'s seen-watermark is:
 * unreadable or unwritable storage must never take a page down. What differs
 * is that a *write* which could not happen is reported (`undefined`), because
 * a composer that says "saved" must have saved something.
 */
export class LocalDraftStore {
  private readonly storage: Storage | undefined;

  constructor({
    storage = draftStorage(),
  }: { storage?: Storage | undefined } = {}) {
    this.storage = storage;
  }

  /** Can this device keep a draft at all? */
  get canStore(): boolean {
    return this.storage !== undefined;
  }

  private key(fid: number): string {
    return `${STORAGE_PREFIX}:${fid}`;
  }

  read(fid: number): StoredDrafts {
    const storage = this.storage;
    if (!storage) {
      return EMPTY;
    }
    try {
      const raw = storage.getItem(this.key(fid));
      if (raw === null) {
        return EMPTY;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) {
        storage.removeItem(this.key(fid));
        return EMPTY;
      }
      // Anything that does not read back as a draft is dropped rather than
      // rendered: a stale schema must not become a broken row in the Drafts tab.
      return {
        caststorms: (Array.isArray(parsed.caststorms)
          ? parsed.caststorms
          : []
        ).filter(isCaststormDraft),
        casts: (Array.isArray(parsed.casts) ? parsed.casts : []).filter(
          isCastDraft,
        ),
      };
    } catch {
      return EMPTY;
    }
  }

  private write(fid: number, drafts: StoredDrafts): boolean {
    const storage = this.storage;
    if (!storage) {
      return false;
    }
    try {
      storage.setItem(
        this.key(fid),
        JSON.stringify({
          caststorms: drafts.caststorms.slice(0, LOCAL_DRAFT_LIMIT),
          casts: drafts.casts.slice(0, LOCAL_DRAFT_LIMIT),
        }),
      );
      return true;
    } catch {
      // Quota, private mode, storage disabled — say so by returning nothing.
      return false;
    }
  }

  /** Newest first, matching the hosted API's own ordering. */
  caststorms(fid: number): ApiCaststormDraft[] {
    return this.read(fid).caststorms;
  }

  casts(fid: number): ApiCastDraft[] {
    return this.read(fid).casts;
  }

  /**
   * Store a composer draft. A body carrying a `draftId` this device still has
   * updates it in place (the composer does that while you type); anything else
   * is a new draft. `undefined` means the write did not happen.
   */
  storeCaststorm({
    fid,
    caststorm,
    scheduledAt,
  }: {
    fid: number;
    caststorm: ApiCaststormBody;
    scheduledAt?: number;
  }): ApiCaststormDraft | undefined {
    const drafts = this.read(fid);
    const existing =
      typeof caststorm.draftId === 'string'
        ? drafts.caststorms.find((draft) => draft.draftId === caststorm.draftId)
        : undefined;

    const stored: ApiCaststormDraft = {
      draftId: existing?.draftId ?? caststorm.draftId ?? newDraftId(),
      // A copy, so a later edit of the composer's own arrays cannot mutate what
      // is already on disk.
      casts: caststorm.casts.map((cast) => ({
        text: cast.text,
        ...(cast.embeds ? { embeds: [...cast.embeds] } : {}),
      })),
      ...(caststorm.parent ? { parent: { hash: caststorm.parent.hash } } : {}),
      ...(caststorm.channelKey !== undefined
        ? { channelKey: caststorm.channelKey }
        : {}),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    };

    const others = drafts.caststorms.filter(
      (draft) => draft.draftId !== stored.draftId,
    );
    const ok = this.write(fid, {
      caststorms: [stored, ...others],
      casts: drafts.casts,
    });
    return ok ? stored : undefined;
  }

  /** Store a single ritual/scheduled draft (`POST /v2/draft-casts`). */
  storeCast({
    fid,
    cast,
    cron,
    scheduledAt,
  }: {
    fid: number;
    cast: ApiCastBody;
    cron?: string;
    scheduledAt?: number;
  }): ApiCastDraft | undefined {
    const drafts = this.read(fid);
    const stored: ApiCastDraft = {
      draftId: newDraftId(),
      cast,
      ...(cron !== undefined ? { cron } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    };
    const ok = this.write(fid, {
      caststorms: drafts.caststorms,
      casts: [stored, ...drafts.casts],
    });
    return ok ? stored : undefined;
  }

  /**
   * Forget one draft. The composer discards the pre-publish copy on a
   * successful cast, and drops the previous auto-save each time it saves a new
   * one, so this is called on the happy path too — it must never throw.
   */
  discard(fid: number, draftId: string): boolean {
    const drafts = this.read(fid);
    const caststorms = drafts.caststorms.filter(
      (draft) => draft.draftId !== draftId,
    );
    const casts = drafts.casts.filter((draft) => draft.draftId !== draftId);
    if (
      caststorms.length === drafts.caststorms.length &&
      casts.length === drafts.casts.length
    ) {
      // Nothing by that id: not an error (a draft may already be gone), but not
      // a success either.
      return false;
    }
    return this.write(fid, { caststorms, casts });
  }
}

/** The hosted API's error envelope, so the client turns this into a HandledFetchError. */
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

/** The sentences a draft request can be refused with. Exported for the probe. */
export const NO_ACCOUNT_SENTENCE =
  'No account is signed in on this device, so there is nowhere to keep a draft.';
export const NO_STORAGE_SENTENCE =
  'This browser will not let Fiddy keep anything on this device, so no draft could be saved.';
export const NO_CAST_SENTENCE =
  'That draft carried no cast, so nothing was saved.';

/** The draft endpoints this store owns. `hostedRoutes` classifies all of them `local`. */
export const LOCAL_DRAFT_ROUTES = [
  'GET /v2/draft-caststorms',
  'POST /v2/draft-caststorms',
  'GET /v2/draft-casts',
  'POST /v2/draft-casts',
  'DELETE /v2/draft-casts',
];

const isDraftPath = (path: string): boolean =>
  path === '/v2/draft-caststorms' || path === '/v2/draft-casts';

export interface LocalDraftRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** The endpoint path, already normalised by `hostedApiPath`. */
  path: string;
  /** The parsed JSON body, when there was one. */
  body?: unknown;
  /** The query string, for the list endpoints' `limit`. */
  searchParams?: URLSearchParams;
  /** The signed-in account, or undefined when this device has no identity. */
  fid: number | undefined;
}

/**
 * Answer one draft request from this device, or `undefined` when the request is
 * not a draft endpoint at all.
 *
 * Both layers that can answer a hosted-API request call this — the node-backed
 * adapter, and the provider seam above it — for the same reason the media mint
 * is answered in one place: a draft is this device's state, not a node's and
 * not a provider's, so the answer must not depend on which machine happens to
 * be answering today's feed.
 */
export const answerLocalDraftRequest = (
  { method, path, body, searchParams, fid }: LocalDraftRequest,
  store: LocalDraftStore = new LocalDraftStore(),
): Response | undefined => {
  if (!isDraftPath(path)) {
    return undefined;
  }
  if (fid === undefined) {
    return errorResponse(400, NO_ACCOUNT_SENTENCE);
  }
  if (!store.canStore) {
    return errorResponse(501, NO_STORAGE_SENTENCE);
  }

  const limit = Number(searchParams?.get('limit') ?? LOCAL_DRAFT_LIMIT);
  const take = Number.isFinite(limit) && limit > 0 ? limit : LOCAL_DRAFT_LIMIT;

  if (path === '/v2/draft-caststorms') {
    if (method === 'GET') {
      return jsonResponse({
        result: { drafts: store.caststorms(fid).slice(0, take) },
        next: {},
      });
    }
    if (method === 'POST') {
      const payload = isObject(body) ? body : {};
      const caststorm = payload.caststorm;
      if (
        !isObject(caststorm) ||
        !Array.isArray(caststorm.casts) ||
        caststorm.casts.length === 0
      ) {
        return errorResponse(400, NO_CAST_SENTENCE);
      }
      const stored = store.storeCaststorm({
        fid,
        caststorm: caststorm as ApiCaststormBody,
        ...(typeof payload.scheduledAt === 'number'
          ? { scheduledAt: payload.scheduledAt }
          : {}),
      });
      if (!stored) {
        return errorResponse(501, NO_STORAGE_SENTENCE);
      }
      return jsonResponse({ result: { draft: stored } });
    }
    return undefined;
  }

  // /v2/draft-casts — the single-cast drafts (rituals and scheduled casts).
  if (method === 'GET') {
    return jsonResponse({
      result: { drafts: store.casts(fid).slice(0, take) },
      next: {},
    });
  }
  if (method === 'POST') {
    const payload = isObject(body) ? body : {};
    const cast = payload.cast;
    if (!isObject(cast)) {
      return errorResponse(400, NO_CAST_SENTENCE);
    }
    const stored = store.storeCast({
      fid,
      cast: cast as ApiCastBody,
      ...(typeof payload.cron === 'string' ? { cron: payload.cron } : {}),
      ...(typeof payload.scheduledAt === 'number'
        ? { scheduledAt: payload.scheduledAt }
        : {}),
    });
    if (!stored) {
      return errorResponse(501, NO_STORAGE_SENTENCE);
    }
    return jsonResponse({ result: { draft: stored } });
  }
  if (method === 'DELETE') {
    const payload = isObject(body) ? body : {};
    const draftId = payload.draftId;
    if (typeof draftId !== 'string' || draftId.length === 0) {
      return errorResponse(400, 'That request named no draft to discard.');
    }
    return jsonResponse({ result: { success: store.discard(fid, draftId) } });
  }
  return undefined;
};
