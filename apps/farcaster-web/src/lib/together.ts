/**
 * Together — the client half of Farcaster spaces.
 *
 * WHAT "TOGETHER" IS
 * One project, one board, your people. You sign in with Farcaster (the same
 * sign-in the rest of fiddy.fun uses), create a space, and hand out a link.
 * Whoever opens that link signs in with Farcaster too and lands on the same
 * board — cards, columns and all. Nobody creates an account, because membership
 * is the Farcaster identity you already have.
 *
 * WHERE THE DATA LIVES
 * A collaboration service (`/spaces/*`), not this app. The alpha runs one on
 * your machine; a hosted one is where this goes next. Everything below is plain
 * fetch against that service's origin, so a self-hosted space and a hosted one
 * are the same code path.
 *
 * WHO DOES THE WORK
 * The board is shared; the thinking is not. A card is a card — each member's own
 * Hermes picks it up with that member's own keys and provider. This client never
 * holds an inference key, and neither does the service.
 *
 * SIGNING IN
 * SIWF is the same relay handshake `lib/siwfSession.ts` already performs, with
 * one difference: the challenge is created by the *service*, so the nonce it
 * gets back can be bound to the request it started. This module only carries the
 * channel URL to the screen and polls for the answer.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

/** Where the collaboration service listens when you run the alpha locally. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8766';

/** How long the caller waits before giving up on an unanswered QR. */
export const TOGETHER_SIGN_IN_TIMEOUT_MS = 120_000;

/** Relay-safe poll cadence for the service's sign-in request. */
export const TOGETHER_POLL_INTERVAL_MS = 1_500;

const SESSION_KEY = 'together-space-session';

export type TogetherSpace = {
  id: string;
  name: string;
  channel: string;
  owner_fid: number;
  about?: string;
  role?: string;
};

export type TogetherCard = {
  id: string;
  space_id: string;
  title: string;
  note: string;
  status: TogetherCardStatus;
  assignee_fid: number | null;
  created_by_fid: number;
  version: number;
  created_at: number;
  updated_at: number;
};

export type TogetherCardStatus = 'todo' | 'doing' | 'review' | 'done';

export type TogetherMember = {
  space_id: string;
  fid: number;
  username: string | null;
  pfp_url: string | null;
  role: string;
  joined_at: number;
};

export type TogetherEvent = {
  seq: number;
  kind: string;
  actor_fid: number;
  actor_name: string | null;
  created_at: number;
  card_id?: string;
  title?: string;
  status?: string;
  name?: string;
};

export type TogetherState = {
  space: TogetherSpace;
  me: {
    fid: number;
    username: string | null;
    pfp_url: string | null;
    role: string | null;
  };
  members: TogetherMember[];
  cards: TogetherCard[];
  cursor: number;
  /** Casts the space wants to make, waiting for a member's Hermes to send them. */
  pending_announcements: number;
  /** Present only when the service was started with its offline verifier. */
  identity?: string;
};

export type TogetherAnnouncement = {
  id: string;
  space_id: string;
  card_id: string | null;
  channel: string;
  text: string;
  created_at: number;
};

export type TogetherSession = {
  token: string;
  fid: number;
  username: string | null;
  pfp_url: string | null;
  space_id: string | null;
  /** 'unverified-dev' when the service is running its offline verifier. */
  identity?: string;
};

/** What the service answers once the phone has approved (wire shape). */
export type TogetherSignInResult = {
  state: 'completed';
  session_token: string;
  fid: number;
  username: string | null;
  pfp_url: string | null;
  space_id: string | null;
  /** 'unverified-dev' when the service is running its offline verifier. */
  identity?: string;
};

export type TogetherSignInChallenge = {
  request_id: string;
  url: string;
  expires_at: number;
  verifier?: string;
  identity?: string;
};

export class TogetherError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TogetherError';
    this.status = status;
  }
}

/**
 * Where the space service answers.
 *
 * Unset → the local alpha on this machine. Set to an origin for a hosted
 * service. Set to `''` → the same origin as this app, which is what a deploy
 * that rewrites `/spaces` onto the service (and the dev probe's proxy) needs.
 */
const configuredBaseUrl = import.meta.env.VITE_TOGETHER_API_URL as
  | string
  | undefined;
const baseUrl = (): string =>
  configuredBaseUrl === undefined
    ? DEFAULT_BASE_URL
    : configuredBaseUrl.replace(/\/+$/, '');

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string | null;
  body?: unknown;
  /** Non-2xx answers we expect and want to read (a dead invite, a stale card). */
  allow?: number[];
};

const describe = (status: number, payload: unknown): string => {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail;

    if (typeof detail === 'string' && detail) {
      return detail;
    }
  }

  return `The space service answered ${status}`;
};

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', token, body, allow = [] } = options;
  let response: Response;

  try {
    response = await fetch(baseUrl() + '/spaces' + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new TogetherError(
      0,
      'We could not reach the space service. Is it running?',
    );
  }

  const text = await response.text();
  let payload: unknown = undefined;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = undefined;
    }
  }

  if (!response.ok && !allow.includes(response.status)) {
    throw new TogetherError(
      response.status,
      describe(response.status, payload),
    );
  }

  return payload as T;
}

/** Reads the stored session, or null when this device has not signed in. */
export const readTogetherSession = async (): Promise<TogetherSession | null> =>
  (await getItem<TogetherSession | null>({
    key: SESSION_KEY,
    fallback: null,
  })) ?? null;

export const storeTogetherSession = async (
  session: TogetherSession,
): Promise<void> => {
  await setItem({ key: SESSION_KEY, value: session });
};

export const clearTogetherSession = async (): Promise<void> => {
  await deleteItem(SESSION_KEY);
};

/** Step one of signing in: ask the service for a challenge. */
export const startTogetherSignIn = async (): Promise<TogetherSignInChallenge> =>
  request<TogetherSignInChallenge>('/auth', {
    method: 'POST',
    body: {
      // The service binds the signed message to this exact origin, so a
      // signature harvested for another app cannot be replayed here.
      siwe_uri: `${window.location.origin}/~/together`,
      domain: window.location.hostname,
    },
  });

export type TogetherSignInPoll =
  | { state: 'pending' }
  | { state: 'expired' }
  | TogetherSignInResult;

/** Step two: ask again until the phone has approved, then keep the session. */
export const pollTogetherSignIn = async (
  requestId: string,
): Promise<TogetherSignInPoll> =>
  request<TogetherSignInPoll>('/auth/' + encodeURIComponent(requestId));

export type TogetherInvite = {
  token: string;
  url: string;
  space: { id: string; name: string; channel: string };
  max_uses: number;
  expires_at: number;
};

export type TogetherInvitePreview = {
  space: { id: string; name: string; channel: string };
  invited_by_fid: number;
  invited_by_username: string | null;
  expires_at: number;
  uses_left: number;
};

export const previewInvite = async (
  token: string,
): Promise<TogetherInvitePreview | null> => {
  try {
    return await request<TogetherInvitePreview>(
      '/invites/' + encodeURIComponent(token),
    );
  } catch (error) {
    // A dead link is a normal thing to meet, not an exception to bubble up: the
    // landing page says so plainly instead of showing a stack trace.
    if (error instanceof TogetherError && [404, 410].includes(error.status)) {
      return null;
    }

    throw error;
  }
};

export const joinInvite = async (
  token: string,
  sessionToken: string,
): Promise<{
  space: TogetherSpace;
  already_member: boolean;
  session_token: string;
}> =>
  request('/invites/' + encodeURIComponent(token) + '/join', {
    method: 'POST',
    token: sessionToken,
  });

export const listSpaces = async (
  token: string,
): Promise<{ fid: number; space_id: string | null; spaces: TogetherSpace[] }> =>
  request('/mine', { token });

export const createSpace = async (
  token: string,
  input: { name: string; channel: string; about?: string },
): Promise<{ space: TogetherSpace; space_id: string; session_token: string }> =>
  request('', { method: 'POST', token, body: input });

export const openSpace = async (
  token: string,
  spaceId: string,
): Promise<{ space: TogetherSpace; session_token: string }> =>
  request('/open', { method: 'POST', token, body: { space_id: spaceId } });

export const readState = async (token: string): Promise<TogetherState> =>
  request('/state', { token });

export const readEvents = async (
  token: string,
  since: number,
): Promise<{ cursor: number; latest: number; events: TogetherEvent[] }> =>
  request(`/events?since=${Math.max(0, Math.floor(since))}`, { token });

export const createCard = async (
  token: string,
  input: { title: string; note?: string },
): Promise<TogetherCard> =>
  request('/cards', { method: 'POST', token, body: input });

export const updateCard = async (
  token: string,
  cardId: string,
  input: { status: TogetherCardStatus; version: number },
): Promise<TogetherCard> =>
  request('/cards/' + encodeURIComponent(cardId), {
    method: 'PATCH',
    token,
    body: input,
  });

export const createInvite = async (token: string): Promise<TogetherInvite> =>
  request('/invites', { method: 'POST', token, body: {} });

/** Queue a cast for the space's channel. A member's own Hermes sends it. */
export const announce = async (
  token: string,
  input: { card_id?: string; text?: string },
): Promise<{
  id: string;
  channel: string;
  text: string;
  card_id: string | null;
  posted: boolean;
}> => request('/announce', { method: 'POST', token, body: input });

export const pendingAnnouncements = async (
  token: string,
): Promise<{ pending: TogetherAnnouncement[] }> =>
  request('/announcements', { token });

export const markAnnouncementPosted = async (
  token: string,
  announcementId: string,
  castHash?: string,
): Promise<{ already_posted: boolean; cast_hash?: string }> =>
  request('/announcements/' + encodeURIComponent(announcementId) + '/posted', {
    method: 'POST',
    token,
    body: castHash ? { cast_hash: castHash } : {},
  });

export { baseUrl as togetherBaseUrl, request as togetherRequest };
