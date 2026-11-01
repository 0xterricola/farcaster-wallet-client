/**
 * "Connect your Farcaster account" — one tap, no fee, and no passphrase.
 *
 * WHAT THIS IS
 *
 * A person who already has a Farcaster account can let Fiddy post for them
 * without paying anything and without ever handling a recovery phrase. The
 * browser asks Fiddy's own service for a *posting key* the protocol has been
 * asked to grant; the service answers with a link to open in the Farcaster app;
 * the person approves it there; and from then on Fiddy writes as them — and only
 * for the things they asked it to do. Their account, its custody key and its
 * phrase stay exactly where they were: in their own Farcaster app.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * Nowhere near here. The Neynar key, the app account's signing key and the
 * signer's own identifier are all held by the service
 * (`lib/fiddy-connect.ts` on fiddy.fun's control plane — the same endpoints the
 * plugin's first-run setup uses, so there is one implementation, not two). What
 * this browser holds is an opaque handle inside an **HttpOnly cookie**: no
 * script can read it, and nothing here ever sees a secret.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never reports "connected" from anything but the service's own answer
 *   (`state: 'connected'`), and it reads an answer it does not recognise as
 *   `unknown` rather than as success.
 * - It never posts as one account for another: a write goes through only when
 *   the connected account's FID *is* the signed-in FID.
 * - It never leaves the person with a dead button: every failure names what
 *   happened, in a sentence, and the caller can offer the slower path instead.
 */

/** Where the service lives. Same origin, so the cookie rides along on its own. */
const CONNECT_ENDPOINT = '/api/fiddy/connect';
const WRITE_ENDPOINT = `${CONNECT_ENDPOINT}/write`;

/** How long a remembered answer is trusted before the service is asked again. */
const STATUS_TTL_MS = 30_000;

export type ConnectState =
  | 'none'
  | 'waiting'
  | 'connected'
  | 'revoked'
  /** The approval belonged to somebody else — never a connection, ever. */
  | 'wrong_account'
  | 'unknown';

/** Why a connection was refused. `app_account` carries no name with it. */
export type ConnectRefusal = 'app_account' | 'other_account' | null;

export interface ConnectStatus {
  state: ConnectState;
  /** The link the person opens in their Farcaster app, while there is one. */
  approvalUrl: string | null;
  /**
   * The account the posting key belongs to, once it has been approved. This is
   * an identity only while `state` is `connected`; a refusal echoes it at most.
   */
  fid: number | null;
  username: string | null;
  /** The FID this request was started for, when this device proved one. */
  forFid: number | null;
  /** Set when the approval belonged to somebody other than the person. */
  refused: ConnectRefusal;
  /**
   * True when the request was started from THIS tab. The one thing that lets a
   * signed-out device adopt an identity: a connection this browser did not ask
   * for is somebody else's, however it got into the cookie jar.
   */
  startedHere: boolean;
  /**
   * A posting key this device is being handed, for a copy of Fiddy that minted
   * it itself (`server/instance/connect.mjs`): the client stores it and signs
   * its own writes with it, which is the same path Advanced uses. Null on
   * fiddy.fun, where the key never leaves the service.
   */
  postingKey: string | null;
}

export const NO_CONNECTION: ConnectStatus = {
  state: 'none',
  approvalUrl: null,
  fid: null,
  username: null,
  forFid: null,
  refused: null,
  startedHere: false,
  postingKey: null,
};

/**
 * What a signed-in browser hands over so the connection is *theirs*: the FID it
 * is signed in as, and the SIWF proof of that (`~/lib/siwfSession` keeps the
 * message and signature for exactly this kind of use). The service checks the
 * proof against Farcaster's own answer; a claim without one is refused there.
 */
export interface ConnectBinding {
  forFid: number;
  proof: { message: string; signature: string; nonce: string };
}

/** What went wrong, in words a screen can show as they are. */
export class ConnectUnavailableError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ConnectUnavailableError';
    this.code = code;
    this.status = status;
  }
}

const UNAVAILABLE_SENTENCE =
  "we couldn't reach the part of Fiddy that sets this up - nothing was connected.";

/**
 * Did the service fail to ANSWER, or did it answer and refuse?
 *
 * The difference decides whether a screen may offer the slow path. A refusal
 * (`CONNECT_ORIGIN`, `CONNECT_DAILY_CEILING`, a name that is already taken) is
 * the service talking, and the person can press again; a request that never
 * reached anything — a network failure, or an address that serves no service at
 * all, which is every self-hosted copy of Fiddy — means the one-tap approval
 * cannot happen HERE, and the screen has to say what can.
 */
export const isServiceUnreachable = (error: unknown): boolean =>
  error instanceof ConnectUnavailableError &&
  (error.code === 'CONNECT_UNREACHABLE' ||
    error.code === 'CONNECT_UNAVAILABLE');

/**
 * The service's answer, read defensively. An unknown state, a missing field or
 * an answer that is not an object all come back as `unknown`; the one thing this
 * never does is guess "connected".
 */
const readStatus = (payload: unknown): ConnectStatus => {
  if (typeof payload !== 'object' || payload === null) {
    return { ...NO_CONNECTION, state: 'unknown' };
  }
  const raw = payload as Record<string, unknown>;
  const state = raw.state;
  const known: ConnectState[] = [
    'none',
    'waiting',
    'connected',
    'revoked',
    'wrong_account',
  ];
  const refused = raw.refused;
  return {
    state:
      typeof state === 'string' && (known as string[]).includes(state)
        ? (state as ConnectState)
        : 'unknown',
    approvalUrl:
      typeof raw.approvalUrl === 'string' && raw.approvalUrl.startsWith('http')
        ? raw.approvalUrl
        : null,
    fid: typeof raw.fid === 'number' && raw.fid > 0 ? raw.fid : null,
    username:
      typeof raw.username === 'string' && raw.username.length > 0
        ? raw.username
        : null,
    forFid:
      typeof raw.forFid === 'number' && raw.forFid > 0 ? raw.forFid : null,
    refused:
      refused === 'app_account' || refused === 'other_account' ? refused : null,
    // A key arrives only when the state that carries it is `connected` — read
    // strictly, so an answer that fiddles with the fields cannot hand this
    // browser a key for a connection that is not the person's.
    postingKey:
      state === 'connected' &&
      typeof raw.postingKey === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(raw.postingKey)
        ? raw.postingKey
        : null,
    // Filled in by the caller-side reader below: the answer alone never proves
    // this tab asked.
    startedHere: false,
  };
};

// ------------------------------------------------------- this tab's own attempt

/**
 * The label THIS tab puts on its own request.
 *
 * `sessionStorage`, so it dies with the tab: the question it answers is "did
 * this tab start the connection the cookie is now holding?", and a label that
 * outlived the tab would answer yes for a browser that never asked. A device
 * with no label can still use a connection — by proving an identity of its own
 * (signing in with Farcaster), which is the honest way to become somebody.
 */
const ATTEMPT_KEY = 'fiddy:connect-attempt';

const newAttempt = (): string => {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

const currentAttempt = (): string | null => {
  try {
    return window.sessionStorage.getItem(ATTEMPT_KEY);
  } catch {
    return null;
  }
};

const rememberAttempt = (attempt: string): void => {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, attempt);
  } catch {
    // A browser that refuses storage simply cannot adopt an identity from a
    // connection it started: it signs in with Farcaster instead.
  }
};

/** Forget this tab's request — called when it is adopted or turned off. */
export const forgetConnectAttempt = (): void => {
  try {
    window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* nothing to forget */
  }
};

const failureFor = (
  status: number,
  payload: unknown,
): ConnectUnavailableError => {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const message =
    typeof raw.message === 'string' && raw.message.trim().length > 0
      ? raw.message
      : UNAVAILABLE_SENTENCE;
  const code = typeof raw.code === 'string' ? raw.code : 'CONNECT_UNAVAILABLE';
  return new ConnectUnavailableError(code, status, message);
};

const postJson = async (
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ status: number; payload: unknown }> => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The handle is in an HttpOnly cookie, so a cross-origin send would drop it.
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
};

// ------------------------------------------------------------------ the states

/** Is this answer one this tab asked for? The service echoes the label back. */
const startedHere = (payload: unknown): boolean => {
  const attempt = currentAttempt();
  if (attempt === null) {
    return false;
  }
  const echoed = (payload as Record<string, unknown> | null)?.attempt;
  return typeof echoed === 'string' && echoed === attempt;
};

/** What the connection is, asked of the service. */
export const connectStatus = async ({
  fetchImpl = fetch,
}: { fetchImpl?: typeof fetch } = {}): Promise<ConnectStatus> => {
  let response: Response;
  try {
    response = await fetchImpl(CONNECT_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw failureFor(response.status, payload);
  }
  return { ...readStatus(payload), startedHere: startedHere(payload) };
};

/**
 * One tap: the service creates the posting key and hands back the link the
 * person opens. A second press while a link is still waiting is answered with
 * *that same link* (`reused`) rather than a second, costly request.
 *
 * `binding` is who is asking: a signed-in browser passes the FID it is signed in
 * as together with the SIWF proof of it, and the service checks that against
 * Farcaster's own answer before the request is tied to anybody. Without a
 * binding the request is nobody's until somebody approves it in their own
 * Farcaster app — and then only this tab may adopt that identity.
 */
export const startConnect = async ({
  binding = null,
  fetchImpl = fetch,
}: {
  binding?: ConnectBinding | null;
  fetchImpl?: typeof fetch;
} = {}): Promise<{
  status: ConnectStatus;
  reused: boolean;
}> => {
  // This tab's own label, minted before the request and shown to nobody but the
  // service — it is what makes the answer recognisably ours later.
  const attempt = newAttempt();
  let answered: { status: number; payload: unknown };
  try {
    answered = await postJson(
      CONNECT_ENDPOINT,
      {
        attempt,
        ...(binding === null
          ? {}
          : { forFid: binding.forFid, proof: binding.proof }),
      },
      fetchImpl,
    );
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw failureFor(answered.status, answered.payload);
  }
  // Remembered only once the service has taken it: a request that never started
  // must not make this tab the owner of somebody else's connection.
  rememberAttempt(attempt);
  return {
    status: { ...readStatus(answered.payload), startedHere: true },
    reused: Boolean(
      (answered.payload as Record<string, unknown> | null)?.reused,
    ),
  };
};

/** Turn it off here: the key is removed, not merely forgotten. */
export const stopConnect = async ({
  fetchImpl = fetch,
}: { fetchImpl?: typeof fetch } = {}): Promise<ConnectStatus> => {
  let response: Response;
  try {
    response = await fetchImpl(CONNECT_ENDPOINT, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw failureFor(response.status, payload);
  }
  forgetConnectAttempt();
  return readStatus(payload);
};

// ------------------------------------------------------- the write path's seam

let remembered: { at: number; status: ConnectStatus } | null = null;

/** The last answer the service gave, if it is still fresh enough to use. */
const freshStatus = (): ConnectStatus | null =>
  remembered !== null && Date.now() - remembered.at < STATUS_TTL_MS
    ? remembered.status
    : null;

const remember = (status: ConnectStatus): ConnectStatus => {
  remembered = { at: Date.now(), status };
  return status;
};

/** Called by the screens whenever they learn a state, so the writer agrees. */
export const rememberConnectStatus = (status: ConnectStatus): void => {
  remember(status);
};

/** Called when the person signs out or switches accounts. */
export const forgetRememberedConnect = (): void => {
  remembered = null;
};

/**
 * May a write for this account go through the granted posting key?
 *
 * Asked once per half-minute at most, and answered *only* for the account the
 * connection belongs to: a connection for one FID is never used to write as
 * another. A service that cannot be reached answers "no" here — the caller then
 * says what is missing rather than pretending the write went somewhere.
 */
export const canWriteThroughConnect = async (
  fid: number | undefined,
): Promise<boolean> => {
  if (fid === undefined) {
    return false;
  }
  try {
    const status = freshStatus() ?? remember(await connectStatus());
    return status.state === 'connected' && status.fid === fid;
  } catch {
    return false;
  }
};

export interface ConnectWrite {
  kind: 'cast' | 'reaction' | 'link';
  text?: string;
  castHash?: string;
  reaction?: 'like' | 'recast';
  add?: boolean;
  targetFid?: number;
  parentHash?: string;
  parentUrl?: string;
  embeds?: string[];
}

export type ConnectWriteAnswer =
  | { ok: true; hash: string | null }
  | { ok: false; status: number; message: string };

/**
 * Hand one write to the service that holds the key. This is the *submit* half
 * only: whether it landed is read back from the node, exactly as a
 * device-signed write is.
 */
export const writeThroughConnect = async (
  write: ConnectWrite,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<ConnectWriteAnswer> => {
  let answered: { status: number; payload: unknown };
  try {
    answered = await postJson(WRITE_ENDPOINT, write, fetchImpl);
  } catch {
    return { ok: false, status: 0, message: UNAVAILABLE_SENTENCE };
  }
  const raw = (answered.payload ?? {}) as Record<string, unknown>;
  if (answered.status < 200 || answered.status >= 300) {
    return {
      ok: false,
      status: answered.status,
      message:
        typeof raw.message === 'string' && raw.message.trim().length > 0
          ? raw.message
          : UNAVAILABLE_SENTENCE,
    };
  }
  return {
    ok: true,
    hash: typeof raw.hash === 'string' && raw.hash.length > 0 ? raw.hash : null,
  };
};

/** The poster `~/snapchain/nodeApi/nodeWrites` uses when a connection exists. */
export const managedPoster = {
  available: canWriteThroughConnect,
  post: writeThroughConnect,
};
