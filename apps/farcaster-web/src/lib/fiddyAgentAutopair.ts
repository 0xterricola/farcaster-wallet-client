/**
 * Turning your agent on, without asking you for a URL and a token.
 *
 * WHY THIS EXISTS
 * `/~/agent` used to open on a pairing form for everybody: the address of the
 * service that runs your agent, and a session token for it. That form is exactly
 * right for the person who runs their own control plane and exactly wrong for
 * the person who just signed in with Farcaster and picked the built-in brain —
 * they have no address to paste and no token to copy, and the identity they
 * signed in with is the only thing the service actually needs.
 *
 * So when the browser is signed in (`fid`), the setup names the built-in Fiddy
 * brain or the Surp preset, and no session is paired yet, the surface asks the
 * service for an owner session and lands straight in Chat under the name the
 * owner chose. The pairing form stays available, one disclosure down, for
 * anybody who does run their own agent service.
 *
 * WHAT THIS MODULE MAY NOT DO
 * It never invents a session and never invents a sentence. Every failure is the
 * service's own message when it sent one, and otherwise a plain sentence from
 * the table below — there is no state where the surface shows a form, a spinner
 * forever, or a claim that something was started.
 *
 * WHERE THE PROOF COMES FROM: `~/lib/siwfSession` kept the SIWE message and
 * signature from the sign-in handshake this browser just completed. That pair is
 * what the service verifies against Farcaster's own contracts; this module
 * forwards it once and forgets it (`clearSiwfProof`).
 *
 * WHERE THE REQUEST GOES: this browser's own origin (`/api/fiddy/owner-session`),
 * which the host proxies to the agent service — the same shape `~/lib/trialChat`
 * uses, and for the same measured reason: the service sends a browser no CORS
 * headers, so a cross-origin call could not be read even when it succeeds.
 * `VITE_FIDDY_OWNER_SESSION_URL` overrides it for a deployment that wants an
 * absolute address.
 */

import {
  DEFAULT_AGENT_SERVICE_URL,
  isValidServiceToken,
  normaliseServiceUrl,
} from '~/lib/agentService';
import type { BrainId, FiddySetup } from '~/lib/fiddySetup';

/** The brains that come with Fiddy. Everything else is the owner's own service. */
export const AUTOPAIR_BRAINS: readonly BrainId[] = ['fiddy', 'surp'];

/** Where the session is asked for, on this origin. */
export const OWNER_SESSION_PATH = '/api/fiddy/owner-session';

export const AUTOPAIR_TIMEOUT_MS = 20_000;

/**
 * One sentence per failure, for somebody who is not a developer. The service's
 * own message wins when it sent one; these are the fallbacks, and the two that
 * matter most are the ones that say *nothing was changed*.
 */
export const AUTOPAIR_SENTENCES: Record<string, string> = {
  NO_PROOF:
    'Your agent needs one more sign-in before it can be turned on. Sign in again and it is offered automatically.',
  OWNER_SESSION_NOT_OPEN:
    'This service cannot start your agent yet. Nothing was changed.',
  IDENTITY_UNPROVEN:
    'That Farcaster sign-in could not be matched to the account it names, so no agent was started.',
  IDENTITY_CHAIN_UNREACHABLE:
    'Farcaster’s own registry could not be reached, so your agent was not started.',
  PROOF_EXPIRED:
    'That sign-in proof has expired. Sign in again and it is offered once more.',
  INVALID_PROOF:
    'That sign-in proof could not be read. Sign in again and it is offered once more.',
  INVALID_AGENT: 'That agent name is not one we can store.',
  RATE_LIMITED: 'Too many attempts just now. Try again in a few minutes.',
  UNREACHABLE:
    'The agent service did not answer. Nothing was changed — you can try again, or pair your own.',
  MALFORMED:
    'The agent service answered with something we could not use. Nothing was changed.',
};

export interface SiwfProofInput {
  fid: number;
  message: string;
  signature: string;
}

export type AutopairBrain =
  | { kind: 'default' }
  | { kind: 'preset'; presetId: string };

export interface AutopairSession {
  baseUrl: string;
  token: string;
  /** The name the service stored, which is the name the owner chose. */
  name: string;
  expiresAt: number | null;
}

export interface AutopairProvisioning {
  open: boolean;
  code: string;
  message: string;
}

export type AutopairOutcome =
  | { ok: true; session: AutopairSession; provisioning: AutopairProvisioning }
  | { ok: false; code: string; sentence: string };

/** Which brain the setup chose, described the way the route takes it. */
export const autopairBrain = (setup: FiddySetup): AutopairBrain =>
  setup.brain === 'surp'
    ? { kind: 'preset', presetId: 'surp' }
    : { kind: 'default' };

/**
 * Should this browser be paired automatically at all? Only a signed-in session
 * with one of the brains Fiddy itself provides: somebody who brought their own
 * service keeps the pairing form, because their agent runs somewhere we have
 * never heard of.
 */
export const shouldAutopair = ({
  setup,
  fid,
}: {
  setup: FiddySetup;
  fid: number | null | undefined;
}): boolean =>
  typeof fid === 'number' && fid > 0 && AUTOPAIR_BRAINS.includes(setup.brain);

/** The absolute address the session is asked for at, on this origin. */
export const ownerSessionUrl = (
  env: Record<string, unknown> = import.meta.env as unknown as Record<
    string,
    unknown
  >,
  origin: string = typeof window === 'undefined'
    ? 'https://fiddy.fun'
    : window.location.origin,
): string => {
  const configured =
    typeof env.VITE_FIDDY_OWNER_SESSION_URL === 'string'
      ? (env.VITE_FIDDY_OWNER_SESSION_URL as string).trim()
      : '';
  if (configured) {
    return configured;
  }
  try {
    return new URL(OWNER_SESSION_PATH, origin).toString();
  } catch {
    return OWNER_SESSION_PATH;
  }
};

const shownText = (value: unknown, limit = 240): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, limit)
    : null;

/** The sentence to show for a failure: the service's own, else the fallback. */
export const autopairSentence = (
  code: string,
  serviceMessage?: string | null,
): string =>
  shownText(serviceMessage) ??
  AUTOPAIR_SENTENCES[code] ??
  AUTOPAIR_SENTENCES.UNREACHABLE;

const timeoutSignal = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;

const parseProvisioning = (value: unknown): AutopairProvisioning => {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const code = shownText(input.code, 64) ?? 'UNKNOWN';
  return {
    open: input.open === true,
    code,
    // No sentence from the service means no claim about it.
    message:
      shownText(input.message) ??
      'Your agent is not awake on this service yet.',
  };
};

/**
 * Ask the agent service for this browser's owner session.
 *
 * One request, one answer. A successful answer must carry a usable token and a
 * usable service address, or the whole thing counts as malformed — a session
 * that cannot be used is not a session, and pairing one would put the surface in
 * a state where every later call fails with a worse error.
 */
export const openOwnerSession = async ({
  proof,
  setup,
  fetchImpl = fetch,
  url,
}: {
  proof: SiwfProofInput | null;
  setup: FiddySetup;
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<AutopairOutcome> => {
  if (!proof || !proof.message || !proof.signature || !(proof.fid > 0)) {
    return {
      ok: false,
      code: 'NO_PROOF',
      sentence: autopairSentence('NO_PROOF'),
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(url ?? ownerSessionUrl(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        proof,
        agent: { name: setup.agentName, brain: autopairBrain(setup) },
      }),
      signal: timeoutSignal(AUTOPAIR_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      code: 'UNREACHABLE',
      sentence: autopairSentence('UNREACHABLE'),
    };
  }

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = (await response.json()) as unknown;
    payload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok !== true) {
    const code =
      shownText(payload?.code, 64) ??
      (response.ok ? 'MALFORMED' : `HTTP_${response.status}`);
    return {
      ok: false,
      code,
      sentence: autopairSentence(code, shownText(payload?.message)),
    };
  }

  const rawSession =
    payload.session && typeof payload.session === 'object'
      ? (payload.session as Record<string, unknown>)
      : null;
  const token = rawSession ? String(rawSession.token ?? '') : '';
  if (!rawSession || !isValidServiceToken(token)) {
    return {
      ok: false,
      code: 'MALFORMED',
      sentence: autopairSentence('MALFORMED'),
    };
  }

  // The address the service was reached on when it named one; the built-in
  // service otherwise. Never an address this client cannot validate.
  const baseUrl =
    normaliseServiceUrl(String(rawSession.baseUrl ?? '')) ??
    normaliseServiceUrl(DEFAULT_AGENT_SERVICE_URL);
  if (!baseUrl) {
    return {
      ok: false,
      code: 'MALFORMED',
      sentence: autopairSentence('MALFORMED'),
    };
  }

  const agent =
    payload.agent && typeof payload.agent === 'object'
      ? (payload.agent as Record<string, unknown>)
      : null;

  return {
    ok: true,
    session: {
      baseUrl,
      token,
      name: shownText(agent?.name, 24) ?? setup.agentName,
      expiresAt:
        rawSession.expiresAt && typeof rawSession.expiresAt === 'number'
          ? rawSession.expiresAt
          : null,
    },
    provisioning: parseProvisioning(payload.provisioning),
  };
};
