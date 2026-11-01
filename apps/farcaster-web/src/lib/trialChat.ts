/**
 * One real message, before sign-in.
 *
 * `/welcome` promises "No account needed for this part", and `/welcome/ready`
 * asks for a Farcaster sign-in. Between those two sentences is the moment the
 * flow was missing: the visitor has just named an agent and picked what thinks
 * for it, and has never heard it speak. So the ready sheet carries one message
 * and one answer.
 *
 * WHERE THE ANSWER COMES FROM: the same origin, one route
 * (`/api/fiddy/trial-chat`). Not a model provider — a browser holds no key and
 * the big services refuse a page's cross-origin call anyway (`~/lib/surp` says
 * the same thing about Surp). The server picks the brain: the visitor's own if
 * step 1 left a usable one behind, otherwise Fiddy's.
 *
 * WHAT THIS MODULE MUST NEVER DO: invent a reply. When the trial is not open on
 * this service, or the brain refuses, the visitor gets the server's own sentence
 * and an unchanged path to sign in. A canned "hello, I'm your agent!" would be
 * the one thing an onboarding must not do — it would be discovered on the second
 * message, by someone who had just been told the first one was real.
 *
 * THE BUDGET IS THE BROWSER'S, AND IT IS ONE. A trial turn is a spend on our
 * side, so the count lives in `sessionStorage`: one per browser session, gone
 * when the tab closes, and the server holds a second, stricter wall behind it
 * (three an hour per caller, one message per request). One is the product
 * decision — the second thing the visitor sends should go to the agent they
 * signed in to, not to a demo.
 *
 * THE EXCHANGE IS KEPT for the signed-in chat to pick up (`fiddy.trial`), so the
 * first thing the owner sees on `/~/agent` is the conversation they already
 * started rather than an empty room. `~/lib/fiddySetup` deliberately holds no
 * message text, so this is its own entry.
 */

import type { FiddySetup } from '~/lib/fiddySetup';
import { readSurpKey } from '~/lib/surp/keys';

/**
 * The route, on this origin. It is proxied to the agent service by the host, so
 * the browser never makes a cross-origin request and never needs a CORS grant.
 */
export const TRIAL_CHAT_PATH = '/api/fiddy/trial-chat';

/** Where the exchange waits for the signed-in chat. */
export const TRIAL_STORAGE_KEY = 'fiddy.trial';

/** One message per browser session. */
export const TRIAL_TURNS_PER_SESSION = 1;

/** The same bound the route enforces, so a message is refused here first. */
export const TRIAL_MESSAGE_MAX = 400;

/** The three one-tap openers, in the order they are offered. */
export const TRIAL_STARTERS: readonly string[] = [
  'What can you do for me on Farcaster?',
  'Draft a morning intro cast',
  'Watch my mentions',
];

export interface TrialExchange {
  agentName: string;
  message: string;
  reply: string;
  /** What the server said about the brain that answered, when it said anything. */
  note: string | null;
  at: number;
}

export interface TrialState {
  turns: number;
  exchange: TrialExchange | null;
}

export type TrialFailureCode =
  | 'NOT_OPEN'
  | 'REFUSED'
  | 'BUSY'
  | 'UNREACHABLE'
  | 'MALFORMED';

export class TrialUnavailableError extends Error {
  constructor(
    public code: TrialFailureCode,
    /** What the visitor can do about it, in their words. */
    public ownerLine: string,
    public status?: number,
  ) {
    super(code);
    this.name = 'TrialUnavailableError';
  }
}

const TURNS_KEY = `${TRIAL_STORAGE_KEY}.turns`;

/** The session count, read defensively: a browser may refuse storage. */
export const trialTurnsUsed = (): number => {
  try {
    const raw = window.sessionStorage.getItem(TURNS_KEY);
    const turns = Number.parseInt(raw ?? '0', 10);
    return Number.isFinite(turns) && turns > 0
      ? Math.min(turns, TRIAL_TURNS_PER_SESSION)
      : 0;
  } catch {
    return 0;
  }
};

export const trialTurnsRemaining = (): number =>
  Math.max(0, TRIAL_TURNS_PER_SESSION - trialTurnsUsed());

const recordTurn = (): void => {
  try {
    window.sessionStorage.setItem(TURNS_KEY, String(trialTurnsUsed() + 1));
  } catch {
    // A browser that refuses storage does not get a second free message: the
    // server's own limit is the one that holds.
  }
};

/** Only a string we would show: one line-bounded, printable, non-empty. */
const shownText = (value: unknown, limit: number): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, limit)
    : null;

/**
 * The exchange as it is stored. Read never throws: a half-written entry, an
 * older shape or a disabled storage API all read as "no exchange yet" rather
 * than as an error the visitor cannot act on.
 */
export const loadTrialExchange = (): TrialExchange | null => {
  try {
    const raw = window.localStorage.getItem(TRIAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<TrialExchange> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const message = shownText(parsed.message, TRIAL_MESSAGE_MAX);
    const reply = shownText(parsed.reply, 4000);
    if (!message || !reply) {
      return null;
    }
    return {
      agentName: shownText(parsed.agentName, 24) ?? 'Fiddy',
      message,
      reply,
      note: shownText(parsed.note, 64),
      at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
    };
  } catch {
    return null;
  }
};

export const saveTrialExchange = (exchange: TrialExchange): void => {
  try {
    window.localStorage.setItem(TRIAL_STORAGE_KEY, JSON.stringify(exchange));
  } catch {
    // The reply on screen is still true; it just will not be there next time.
  }
};

export const clearTrialExchange = (): void => {
  try {
    window.localStorage.removeItem(TRIAL_STORAGE_KEY);
  } catch {
    // nothing to clean up
  }
};

/** The whole session state, for a surface that renders both halves. */
export const loadTrialState = (): TrialState => ({
  turns: trialTurnsUsed(),
  exchange: loadTrialExchange(),
});

/**
 * The brain the visitor chose in step 1, described the way the route takes it.
 *
 * Only the brain the client can actually hand over is sent: Surp's key is the
 * one credential this browser holds (a prepaid key made in the brain sheet), and
 * the others were component state that is gone by this screen. Undefined means
 * "you choose" — the route then answers with Fiddy's own brain, which is the
 * default choice and the one most visitors made.
 */
export const trialBrain = (
  setup: FiddySetup,
): Record<string, unknown> | undefined => {
  if (setup.brain !== 'surp') {
    return undefined;
  }
  const key = readSurpKey();
  if (!key) {
    return undefined;
  }
  return {
    kind: 'preset',
    presetId: 'surp',
    model: setup.brainModel ?? 'surp/chat',
    key: key.key,
  };
};

const refusalFor = (
  status: number,
  code: string | null,
  message: string | null,
): TrialUnavailableError => {
  // The server's own sentence wins when it sent one: it knows why, and its copy
  // is written for the visitor.
  if (message) {
    return new TrialUnavailableError('REFUSED', message, status);
  }
  if (status === 429) {
    return new TrialUnavailableError(
      'BUSY',
      'That is a lot of messages at once. Try again in a minute, or sign in — your agent is waiting.',
      status,
    );
  }
  if (code === 'TRIAL_NOT_OPEN') {
    return new TrialUnavailableError(
      'NOT_OPEN',
      'The live trial is not open on this service yet. Sign in and your first message goes straight to your agent.',
      status,
    );
  }
  return new TrialUnavailableError(
    'REFUSED',
    'The trial could not answer just now. Signing in still works.',
    status,
  );
};

/**
 * Send the one message. Resolves with the real reply and keeps it; throws a
 * sentence when there is no real reply to show.
 *
 * A reply is accepted only when the route says `ok` AND carries text, so an
 * empty 200 can never render as an empty bubble that looks like a model with
 * nothing to say.
 */
export const askTrialAgent = async ({
  message,
  agentName,
  setup,
  fetchImpl = fetch,
}: {
  message: string;
  agentName: string;
  setup: FiddySetup;
  fetchImpl?: typeof fetch;
}): Promise<TrialExchange> => {
  const text = message.trim().slice(0, TRIAL_MESSAGE_MAX);
  if (!text) {
    throw new TrialUnavailableError('REFUSED', 'Write a message first.');
  }
  if (trialTurnsRemaining() <= 0) {
    throw new TrialUnavailableError(
      'BUSY',
      'You have used your one trial message. Sign in to keep talking.',
    );
  }

  const brain = trialBrain(setup);
  let response: Response;
  try {
    response = await fetchImpl(TRIAL_CHAT_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        message: text,
        agentName,
        ...(brain ? { brain } : {}),
      }),
    });
  } catch {
    throw new TrialUnavailableError(
      'UNREACHABLE',
      'The trial could not be reached just now. Signing in still works.',
    );
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // A host that answers an unknown route with its own page is not an answer.
    throw new TrialUnavailableError(
      'MALFORMED',
      response.ok
        ? 'The trial answered with something this page could not read. Signing in still works.'
        : 'The live trial is not open on this service yet. Sign in and your first message goes straight to your agent.',
      response.status,
    );
  }

  if (!response.ok || payload?.ok !== true) {
    throw refusalFor(
      response.status,
      typeof payload?.code === 'string' ? payload.code : null,
      typeof payload?.message === 'string' ? payload.message : null,
    );
  }

  const reply = shownText(payload.reply, 4000);
  if (!reply) {
    throw new TrialUnavailableError(
      'MALFORMED',
      'The reply arrived empty. Try once more, or sign in — your agent is waiting.',
      response.status,
    );
  }

  const exchange: TrialExchange = {
    agentName,
    message: text,
    reply,
    note: shownText(payload.note, 64),
    at: Date.now(),
  };
  recordTurn();
  saveTrialExchange(exchange);
  return exchange;
};
