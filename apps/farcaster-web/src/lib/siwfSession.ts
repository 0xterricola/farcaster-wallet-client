import {
  ApiGetOnboardingState200Response,
  AuthToken,
} from 'farcaster-client-data';
import { isAddressEqual, recoverMessageAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

/**
 * Sign In With Farcaster (SIWF) — the login that actually completes.
 *
 * WHY THIS EXISTS
 * The fork's original QR was a Warpcast "sync channel" device link: the code
 * displayed `https://farcaster.xyz/login-web?channel-id=<uuid>`, the phone posted
 * an encrypted auth token to `/v2/sync-channel`, and the web client polled it out.
 * Farcaster has since removed that flow. Measured on 2026-10-19:
 *
 *   - `POST https://farcaster.xyz/~api/v2/sync-channel` → 200 {"success":true}
 *   - `GET  https://farcaster.xyz/~api/v2/sync-channel` → 200 {"messages":[]}, forever
 *   - `https://farcaster.xyz/login-web?channel-id=…` now redirects to
 *     `/~/mobile?…&path=login-web` and renders only "Copy link" — no handshake.
 *   - The live front door is "Log in with email / Log in with phone" (Neynar-run).
 *
 * So the channel was healthy and simply never received anything: the phone app no
 * longer knows how to answer that link. The QR was a dead end, which is exactly
 * what the user saw.
 *
 * WHAT THIS DOES INSTEAD
 * Talks to the SIWF relay directly. Four fetch calls and viem's own SIWE parsing —
 * deliberately, rather than adding `@farcaster/auth-client`, which would mean a
 * monorepo-wide lockfile change for the same handful of requests. The wire format
 * below was read off `@farcaster/auth-client@0.7.1`'s own types.
 *
 * HONEST LIMIT — read this before "improving" the session below.
 * SIWF proves *who signed a message*. It does not mint a farcaster.xyz API token.
 * `useAuth().signIn()` wants precisely such a token (an `AuthToken` that `/v2/me`
 * can validate), and minting one is a server-side exchange this client has no
 * backend for. So a completed SIWF handshake produces a LOCAL-ONLY session: the
 * app enters a real signed-in state carrying the user's real FID, handle and
 * avatar, and makes no privileged Farcaster API call with it. `isLocalSessionToken`
 * is the marker that stops AuthProvider from probing `/v2/me` on cold start and
 * booting the user straight back out of the session they just completed.
 *
 * Replacing this with a real session means adding a backend that exchanges a
 * verified SIWE signature for an API token. That is a product decision, not a bug
 * fix, and it is deliberately not made here.
 */

const SIWF_RELAY_URL = 'https://relay.farcaster.xyz';

/** How long the QR stays live before we show an error and offer a retry. */
const SIWF_CHANNEL_TIMEOUT_MS = 120_000;

/** Relay poll cadence. The relay rate-limits, so don't go below a second. */
const SIWF_POLL_INTERVAL_MS = 1_500;

/**
 * Marks an AuthToken as a local SIWF session rather than a farcaster.xyz token.
 * AuthProvider keys its "don't validate this one against the server" branch off
 * this prefix, so it must stay a prefix of the `secret` field.
 */
const LOCAL_SESSION_SECRET_PREFIX = 'siwf-local:';

/** Local sessions are a dev/v1 affordance; they expire rather than pretend. */
const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SiwfRelayChannel = {
  channelToken: string;
  url: string;
  nonce: string;
};

type SiwfRelayStatusPending = {
  state: 'pending';
  nonce: string;
  signatureParams: { siweUri: string; domain: string; nonce?: string };
};

type SiwfRelayStatusCompleted = {
  state: 'completed';
  nonce: string;
  message: string;
  signature: `0x${string}`;
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
  custody?: `0x${string}`;
  authMethod?: 'custody' | 'authAddress';
  verifications?: string[];
};

type SiwfRelayStatus = SiwfRelayStatusPending | SiwfRelayStatusCompleted;

/** Raised when the QR was never scanned/approved inside the timeout. */
class SiwfTimeoutError extends Error {
  constructor() {
    super('Nobody approved the request in time');
    this.name = 'SiwfTimeoutError';
  }
}

/** Raised when the relay itself is unreachable or answers with an error. */
class SiwfRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiwfRelayError';
  }
}

type SiwfVerified = {
  /** True when the signature provably belongs to the address in the SIWE message. */
  verified: boolean;
  address?: `0x${string}`;
  /** Populated when `verified` is false, for logs and the honest UI copy. */
  reason?: string;
};

type SiwfCompletion = SiwfRelayStatusCompleted & {
  verification: SiwfVerified;
};

const createSiwfChannel = async ({
  siweUri,
  domain,
}: {
  siweUri: string;
  domain: string;
}): Promise<SiwfRelayChannel> => {
  let response: Response;

  try {
    response = await fetch(`${SIWF_RELAY_URL}/v1/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siweUri, domain }),
    });
  } catch (error) {
    throw new SiwfRelayError(`Farcaster's sign-in service is unreachable`);
  }

  if (!response.ok) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service refused the request (${response.status})`,
    );
  }

  const body = (await response.json()) as SiwfRelayChannel;

  if (!body?.channelToken || !body?.url) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service sent back no request`,
    );
  }

  return body;
};

/**
 * One poll of the relay channel. `Authorization: Bearer <channelToken>` is
 * required — without it the relay answers 401 and the poll would look like a
 * network problem forever.
 */
const getSiwfChannelStatus = async ({
  channelToken,
}: {
  channelToken: string;
}): Promise<SiwfRelayStatus | undefined> => {
  let response: Response;

  try {
    response = await fetch(
      `${SIWF_RELAY_URL}/v1/channel/status?channelToken=${encodeURIComponent(channelToken)}`,
      { headers: { authorization: `Bearer ${channelToken}` } },
    );
  } catch (error) {
    // Offline or blocked: not fatal, the next poll may succeed.
    return undefined;
  }

  // 202 is the documented "still waiting" status.
  if (response.status === 202 || response.ok) {
    return (await response.json()) as SiwfRelayStatus;
  }

  if (response.status === 404 || response.status === 401) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service no longer recognises this request (${response.status})`,
    );
  }

  return undefined;
};

/**
 * Polls until the user approves in the Farcaster app, or the timeout fires.
 * Throws `SiwfTimeoutError` on timeout so the caller can offer a retry rather
 * than leaving a modal that will never resolve.
 */
const watchSiwfChannel = async ({
  channelToken,
  timeoutMs = SIWF_CHANNEL_TIMEOUT_MS,
  pollIntervalMs = SIWF_POLL_INTERVAL_MS,
  isCancelled,
}: {
  channelToken: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isCancelled?: () => boolean;
}): Promise<SiwfRelayStatusCompleted> => {
  const startedAt = Date.now();

  for (;;) {
    if (isCancelled?.()) {
      throw new SiwfTimeoutError();
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new SiwfTimeoutError();
    }

    const status = await getSiwfChannelStatus({ channelToken });

    if (status?.state === 'completed') {
      return status;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
};

/**
 * Verifies a completed handshake locally.
 *
 * Three checks, in order, cheapest and most conclusive first:
 *   1. the SIWE message parses at all;
 *   2. its `nonce` and `domain` are the ones we asked for — this is what stops a
 *      signature harvested from another app or another session being replayed here;
 *   3. the signature recovers to the address the message claims (pure ECDSA, no RPC).
 *
 * What this does NOT prove on its own: that the signing address actually controls
 * the FID the relay reports. The relay is only a carrier — it decides nothing —
 * and that binding lives in Farcaster's own ID registry, which is exactly what
 * `confirmFidOnNode` below asks the reader's OWN server about. A node that names
 * the same FID makes the identity proven rather than relayed; a node that names
 * a different one is refused; a node that cannot answer leaves the session
 * device-only, with the UI saying so rather than implying more.
 */
const verifySiwfCompletion = async ({
  message,
  signature,
  nonce,
  domain,
}: {
  message: string;
  signature: `0x${string}`;
  nonce: string;
  domain: string;
}): Promise<SiwfVerified> => {
  let parsed: ReturnType<typeof parseSiweMessage>;

  try {
    parsed = parseSiweMessage(message);
  } catch (error) {
    return { verified: false, reason: 'the sign-in message did not parse' };
  }

  if (parsed.domain !== domain) {
    return {
      verified: false,
      reason: `the message was signed for ${parsed.domain}, not ${domain}`,
    };
  }

  if (parsed.nonce !== nonce) {
    return { verified: false, reason: 'the message carried the wrong nonce' };
  }

  if (!parsed.address) {
    return { verified: false, reason: 'the message carried no address' };
  }

  let recovered: `0x${string}`;

  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (error) {
    return { verified: false, reason: 'the signature could not be recovered' };
  }

  if (!isAddressEqual(recovered, parsed.address)) {
    return {
      verified: false,
      reason: 'the signature does not match the address it claims',
    };
  }

  return { verified: true, address: recovered };
};

/**
 * Who this account is, according to the server this copy of Fiddy reads from.
 *
 * THE POINT OF THE WHOLE FLOW (fatline's step 4, and the reason the relay is not
 * trusted here): a signed SIWE message proves somebody controls an address; it
 * does NOT say which FID that address owns — the relay says that, and the relay
 * only carries messages. The ID registry says it, and every Snapchain server
 * serves exactly that one lookup: `/v1/onChainIdRegistryEventByAddress`. So the
 * FID is taken from the reader's own server, and the account is only treated as
 * confirmed when that server names the same address's FID.
 *
 * Three answers, and each one is used as it is:
 *   - `confirmed`  the server names this FID for this address. The sign-in is
 *                  proven, not merely relayed.
 *   - `mismatch`   the server names a DIFFERENT FID for this address. Something
 *                  is wrong about the request itself, and the sign-in is refused
 *                  rather than quietly accepted as another account.
 *   - `none` / `unavailable`  the address owns no account this server knows, or
 *                  the server could not answer. The session stays device-only
 *                  (that is what it was before this existed) and the screen says
 *                  which of the two it was.
 *
 * The two candidates are tried in order: the address the client is pointed at,
 * then this app's own `/snapchain-api` relay path, which is what a dev or
 * preview server proxies to the node it was configured with.
 */
type FidConfirmation =
  | { state: 'confirmed'; fid: number; nodeUrl: string }
  | { state: 'mismatch'; fid: number; nodeUrl: string }
  | { state: 'none'; nodeUrl: string }
  | { state: 'unavailable'; nodeUrl: string | null; reason: string };

/** How long the reader's own server gets to answer before it counts as silent. */
const FID_CONFIRMATION_TIMEOUT_MS = 8_000;

const confirmFidOnNode = async ({
  address,
  nodeUrl,
  expectedFid,
  fetchImpl = fetch,
}: {
  address: `0x${string}`;
  nodeUrl: string | null;
  expectedFid: number;
  fetchImpl?: typeof fetch;
}): Promise<FidConfirmation> => {
  const candidates = [nodeUrl, '/snapchain-api'].filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  );

  if (candidates.length === 0) {
    return {
      state: 'unavailable',
      nodeUrl: null,
      reason: 'this copy of Fiddy is not pointed at any server yet',
    };
  }

  let lastReason = 'the server did not answer';
  for (const base of candidates) {
    try {
      const response = await fetchImpl(
        `${base}/v1/onChainIdRegistryEventByAddress?address=${address.toLowerCase()}`,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(FID_CONFIRMATION_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        lastReason = `it answered ${response.status}`;
        continue;
      }

      const body = (await response.json()) as {
        fid?: unknown;
        idRegisterEventBody?: { to?: unknown };
      };
      const fid = Number(body?.fid);
      const owner = body?.idRegisterEventBody?.to;

      if (
        !Number.isInteger(fid) ||
        fid <= 0 ||
        typeof owner !== 'string' ||
        owner.toLowerCase() !== address.toLowerCase()
      ) {
        // The address owns no account this server knows about — a test key, or
        // an account that moved. Not an accusation; simply not confirmed.
        return { state: 'none', nodeUrl: base };
      }

      if (fid !== expectedFid) {
        return { state: 'mismatch', fid, nodeUrl: base };
      }

      return { state: 'confirmed', fid, nodeUrl: base };
    } catch (error) {
      lastReason =
        error instanceof Error && error.message
          ? error.message
          : 'the server did not answer';
    }
  }

  return {
    state: 'unavailable',
    nodeUrl: candidates[0] ?? null,
    reason: lastReason,
  };
};

/**
 * True when a token is a local SIWF session rather than an API token. Takes the
 * bare `{ secret }` shape so callers holding only a secret string (AuthProvider
 * has one in a few places) don't have to fabricate an AuthToken to ask.
 */
const isLocalSessionToken = (
  authToken: { secret?: string } | undefined,
): boolean =>
  typeof authToken?.secret === 'string' &&
  authToken.secret.startsWith(LOCAL_SESSION_SECRET_PREFIX);

/**
 * The AuthToken shape the app stores, carrying a marker that says "local".
 * `expiresAt` is a real expiry: a local session should age out like any other.
 */
const buildLocalAuthToken = ({
  fid,
  now = Date.now(),
}: {
  fid: number;
  now?: number;
}): AuthToken => ({
  secret: `${LOCAL_SESSION_SECRET_PREFIX}${fid}:${now.toString(36)}`,
  expiresAt: now + LOCAL_SESSION_TTL_MS,
});

/**
 * Builds the onboarding-state object the app's signed-in gate reads
 * (`useIsSignedIn` → `state.user && state.hasCompletedRegistration`), filled in
 * from what SIWF actually returned.
 *
 * This is a local synthesis, not a server payload — the counts are honestly zero
 * because we did not fetch them, and the /v2/me-derived fields are false because
 * we did not ask the server. Every field the UI reads as "yours" (fid, handle,
 * display name, avatar) is real, straight from the signed handshake.
 */
const buildLocalOnboardingState = ({
  fid,
  username,
  displayName,
  bio,
  pfpUrl,
}: {
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
}): ApiGetOnboardingState200Response => ({
  result: {
    state: {
      id: `siwf-local-${fid}`,
      user: {
        fid,
        username,
        displayName: displayName ?? username ?? `fid ${fid}`,
        pfp: pfpUrl ? { url: pfpUrl, verified: false } : undefined,
        profile: { bio: { text: bio ?? '', mentions: [] } },
        followerCount: 0,
        followingCount: 0,
      },
      hasOnboarding: true,
      hasConfirmedEmail: false,
      needsRegistrationPayment: false,
      hasFid: true,
      hasFname: Boolean(username),
      hasDelegatedSigner: false,
      hasSetupProfile: Boolean(username),
      hasCompletedRegistration: true,
      hasStorage: false,
      hasWarpcastWalletAddress: false,
      hasWarpcastSolanaWalletAddress: false,
      geoRestricted: false,
    },
  },
});

/** Where a sign-in leaves its proof for the one thing that needs it after. */
const SIWF_PROOF_KEY = 'fiddy.siwf.proof';

/** Long enough to finish signing in, short enough that a stale proof ages out. */
export const SIWF_PROOF_TTL_MS = 30 * 60 * 1000;

export interface SiwfProof {
  fid: number;
  message: string;
  signature: string;
  /**
   * The nonce the handshake asked for. Kept so a reader can show the proof was
   * made for THIS session and not harvested from another one (the connect flow
   * passes it on; a proof without one is still checked by its signature).
   */
  nonce?: string;
  at: number;
}

/**
 * The proof a sign-in leaves behind.
 *
 * A completed SIWF handshake produces a SIWE message and a signature from the
 * owner's own Farcaster client. That pair is evidence of who signed in — and it
 * is replayable by anyone who reads it, so it is kept the way it deserves:
 * `sessionStorage` only (gone when the tab closes), a thirty-minute life, and
 * consumed once. Its readers are the two surfaces that must prove the same
 * thing the sign-in just proved: `~/pages/agent` (which forwards it to the agent
 * service and deletes it) and the connect flow (`managedConnect`, which hands it
 * to Fiddy's own service so a posting key is issued FOR this account and no
 * other). Nothing else in the app reads it, and it grants nothing on its own.
 *
 * It is kept for a real reason rather than convenience: the service that runs
 * your agent proves ownership by verifying precisely this signature against
 * Farcaster's own contracts, so asking the owner to sign again — or to paste a
 * session token — would be asking them to redo work they have already done.
 * Nothing else in the app reads it, and it grants nothing on its own.
 */
export const saveSiwfProof = (
  {
    fid,
    message,
    signature,
    nonce,
  }: { fid: number; message: string; signature: string; nonce?: string },
  now = Date.now(),
): void => {
  if (!Number.isSafeInteger(fid) || fid <= 0 || !message) {
    return;
  }
  if (!/^0x[\da-fA-F]{130}$/.test(signature)) {
    return;
  }
  try {
    window.sessionStorage.setItem(
      SIWF_PROOF_KEY,
      JSON.stringify({
        fid,
        message,
        signature,
        ...(typeof nonce === 'string' && nonce.length > 0 ? { nonce } : {}),
        at: now,
      }),
    );
  } catch {
    // A browser that refuses storage simply signs in again — never a broken login.
  }
};

/** Read the proof back. Never throws; a half-written or stale entry is `null`. */
export const loadSiwfProof = (now = Date.now()): SiwfProof | null => {
  try {
    const raw = window.sessionStorage.getItem(SIWF_PROOF_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SiwfProof> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const fid = Number(parsed.fid);
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const signature =
      typeof parsed.signature === 'string' ? parsed.signature : '';
    const at = typeof parsed.at === 'number' ? parsed.at : 0;
    const nonce = typeof parsed.nonce === 'string' ? parsed.nonce : undefined;
    if (!Number.isSafeInteger(fid) || fid <= 0 || !message || !at) {
      return null;
    }
    if (!/^0x[\da-fA-F]{130}$/.test(signature)) {
      return null;
    }
    if (now - at > SIWF_PROOF_TTL_MS || now < at - 60_000) {
      return null;
    }
    return { fid, message, signature, ...(nonce ? { nonce } : {}), at };
  } catch {
    return null;
  }
};

/** Delete the proof. Called the moment it has been spent. */
export const clearSiwfProof = (): void => {
  try {
    window.sessionStorage.removeItem(SIWF_PROOF_KEY);
  } catch {
    // nothing to clean up
  }
};

export {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  confirmFidOnNode,
  createSiwfChannel,
  getSiwfChannelStatus,
  isLocalSessionToken,
  LOCAL_SESSION_SECRET_PREFIX,
  SIWF_CHANNEL_TIMEOUT_MS,
  SIWF_POLL_INTERVAL_MS,
  SIWF_RELAY_URL,
  SiwfRelayError,
  SiwfTimeoutError,
  verifySiwfCompletion,
  watchSiwfChannel,
};
export type {
  FidConfirmation,
  SiwfCompletion,
  SiwfRelayChannel,
  SiwfRelayStatus,
  SiwfRelayStatusCompleted,
  SiwfVerified,
};
