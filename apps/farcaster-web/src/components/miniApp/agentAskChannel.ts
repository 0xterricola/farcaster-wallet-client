/**
 * The agent ask channel: what a mini app may ask this reader's agent for, and
 * every honest answer when it may not.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` — §3.1 the envelope,
 * §4 where consent lives, §5 identity, §6 the sentences and the order that
 * decides between them. This file is S1 of the four slices that doc cards: the
 * channel, the budget, the mute, and every refusal. It raises no UI and calls
 * nothing. A well-formed ask from a real app is answered `unavailable` here when
 * no slice has a path for it; the slices that *can* do the work answer behind
 * their own approval instead (S2 `draft`/`post`, S3 `remind`), and the ask they
 * refuse to take is answered `unavailable` — the honest state for a shell that
 * has no path for something, instead of a pretend success. Those slices reach
 * this channel through the one optional seam below, `answerAsk`: the ask arrives
 * validated, counted and addressed, and the answer comes back in their own
 * time. Every rule of this file still holds for it — the pin, the envelope, the
 * one-shot id, the duplicate window, the budget, the mute and the sentences.
 *
 * Why a channel of Fiddy's own rather than a member on the spec's wire: the host
 * answers a message only through a closed `switch` over the spec's own members
 * (`@farcaster/miniapp-host@0.3.0` `dist/comlink/comlink.js:99-164`), so a
 * bridge member would mean patching a third-party file that sits on the wallet,
 * sign-in and compose traffic. §3.1 rejects that; a Fiddy-only extension gets a
 * Fiddy-only channel.
 *
 * The module is pure and React-free on purpose: every decision below is a
 * function of (the raw message event's `source`/`origin`/`data`, the frame's own
 * window object, the launched URL, the session, the budget and the mute), so
 * every refusal is proved by a unit test with no browser.
 *
 * Two properties are the point of the file, and both are absences.
 *
 *  1. **Silence wherever a reply would be an oracle.** An ask is answered only
 *     when it arrives from this iframe's own window object AND from the origin
 *     the window was launched with AND it is our own envelope. Anything else
 *     gets nothing at all — not even `invalid`, because a reply is itself an
 *     oracle: a frame that is not the app must not be able to tell "refused"
 *     from "nobody is listening". A replayed id gets no answer either, for the
 *     same reason.
 *  2. **Nothing is echoed.** An answer is a state word from one fixed table and
 *     that state's own sentence. The app's text never comes back, and no answer
 *     carries a fid, an agent, a cast, a hash or anything else reader-derived —
 *     the envelope has nothing in it worth forging (§5).
 *
 * Everything the app *does* send from the frame is refused by name, never with
 * a silent nothing and never with a fake.
 */

/** The ask, app → shell. Posted to `window.parent` by the app. */
export const AGENT_ASK_MESSAGE = 'fiddy:agent-ask';

/** The answer, shell → app. Posted to the iframe with its own origin as target. */
export const AGENT_ASK_RESULT_MESSAGE = 'fiddy:agent-ask-result';

export const AGENT_ASK_VERSION = 1;

/**
 * Fiddy's own capability string, declared in `getCapabilities` so a well-behaved
 * app can find out before asking. Namespaced: it is not a member of the mini app
 * spec, and every string in that list has to be backed by something real.
 */
export const AGENT_ASK_CAPABILITY = 'fiddy.agent.ask';

/** §3.1: plain text, ≤ 500 characters. */
export const AGENT_ASK_MAX_TEXT_LENGTH = 500;

/** §3.1: at most two embeds, https only, and only on a `draft`. */
export const AGENT_ASK_MAX_EMBEDS = 2;

/** §3.1: the app's own id, 1..64 characters, unique per window. */
export const AGENT_ASK_MAX_ID_LENGTH = 64;

/** §4: three asks per origin per window, mirroring the three `addMiniApp`. */
export const AGENT_ASK_BUDGET = 3;

/** §4: an identical ask inside this window is answered from the last answer. */
export const AGENT_ASK_DEDUPE_MS = 30_000;

const ASK_KINDS = ['draft', 'post', 'remind'] as const;

export type AgentAskKind = (typeof ASK_KINDS)[number];

/**
 * Every state of the bridge (§6). S1 can only emit five of them — `invalid`,
 * `no_agent`, `muted`, `budget`, `unavailable` — and the rest are the vocabulary
 * the later slices answer with, kept in one place so the sentences never fork.
 */
export type AgentAskState =
  | 'invalid'
  | 'no_agent'
  | 'muted'
  | 'budget'
  | 'unavailable'
  | 'declined'
  | 'not_permitted'
  | 'drafted'
  | 'posted'
  | 'unknown'
  | 'asked'
  | 'failed';

/**
 * §6, copied exactly, with one word settled by S2: §6's `posted` sentence says
 * "node", and this product's jargon ban keeps that word out of anything a reader
 * or an app author sees. The card that owns the state settled it as "network",
 * which keeps §6's fact (the owner approved it and the write is visible) and
 * drops the banned word. Everything else is §6's own wording.
 */
export const AGENT_ASK_SENTENCES: Record<AgentAskState, string> = {
  invalid: 'That ask was not something Fiddy can do.',
  no_agent: 'No agent is paired in this browser, so there is nobody to ask.',
  muted: 'The person using Fiddy told this app to stop asking.',
  budget: 'This app has asked Fiddy as often as it may in this window.',
  unavailable: 'Fiddy cannot do that here yet.',
  declined: 'The person said not now.',
  not_permitted: 'Fiddy does not hand what your agent says to an app.',
  drafted: 'A draft is open in the composer.',
  posted: "Fiddy's owner approved it, and the network shows the cast.",
  unknown:
    "Fiddy's owner approved it, but nothing on the network shows it yet, so Fiddy will not say it went out.",
  asked: 'Your agent was asked; the answer stays with its owner.',
  failed: 'Fiddy tried, and could not — the person using Fiddy has been told.',
};

/** A validated ask: only the fields §3.1 defines, nothing the app added. */
export interface AgentAskEnvelope {
  id: string;
  ask: AgentAskKind;
  text: string;
  embeds?: string[];
}

export interface AgentAskAnswer {
  type: typeof AGENT_ASK_RESULT_MESSAGE;
  v: typeof AGENT_ASK_VERSION;
  id: string;
  state: AgentAskState;
  message: string;
}

/** The raw pieces of a `MessageEvent`, so the decision needs no browser. */
export interface AgentAskMessageEvent {
  /** `event.source` — the window object that sent it, compared by identity. */
  source: unknown;
  /** `event.origin`. */
  origin: string;
  /** `event.data`. */
  data: unknown;
}

export function agentAskAnswer(
  id: string,
  state: AgentAskState,
): AgentAskAnswer {
  return {
    type: AGENT_ASK_RESULT_MESSAGE,
    v: AGENT_ASK_VERSION,
    id,
    state,
    message: AGENT_ASK_SENTENCES[state],
  };
}

/** Where the reader's mute lives: session storage in the client, injected in tests. */
export interface AgentAskMuteStore {
  read(origin: string): boolean;
  write(origin: string, muted: boolean): void;
}

export interface AgentAskChannelOptions {
  /**
   * Whether this browser holds a paired agent session *right now*, read at
   * message time. A session that arrives while the app is open is answered by
   * the listener already running. A session still loading is not yet paired:
   * §6's promise is that the app is told the same thing until there is one.
   */
  hasPairedSession: () => boolean;
  /** Defaults to session storage, keyed by the app's origin. */
  mutes?: AgentAskMuteStore;
  /** Injectable clock, for the 30 s duplicate window. */
  now?: () => number;
  /**
   * The seam the slices that *do* something answer through (S2's `draft` and
   * `post`, S3's `remind`). Everything above stays this channel's: the pin on
   * the frame's window and origin, the envelope, the one-shot ids, the 30 s
   * duplicate window, the 3-ask budget, the reader's mute and the sentences.
   *
   * An ask that reaches here has already been validated, counted and addressed.
   * Return `true` when this handler will answer it (the channel then says
   * nothing, and nothing else is answered for that id), and answer *later* with
   * `agentAskAnswer(envelope.id, state)` — the effect is a reader's decision, a
   * chat message and a composer, so it cannot be this file's synchronous return.
   * Return `false`, or leave this out entirely, and a well-formed ask is
   * `unavailable` exactly as it is today: a shell with no path for something
   * says so instead of pretending.
   */
  answerAsk?: (
    envelope: AgentAskEnvelope,
    deferral: AgentAskDeferral,
  ) => boolean;
}

/**
 * What a deferred answer is given: the ask itself, the origin the answer must
 * be addressed to, and the one line back the channel needs so §4's 30 s
 * duplicate window can replay the truth rather than a placeholder.
 */
export interface AgentAskDeferral {
  /** The origin the window on screen was launched with. */
  origin: string;
  /** The frame's own window object, as `handle` received it. */
  frameWindow: unknown;
  /**
   * What the ask ended as. Optional to call and harmless to call twice: until
   * it is called, a duplicate of this ask is handed to the handler again (a
   * second send while the reader is deciding is the same decision), and after
   * it is called, an identical ask inside 30 s is answered from it.
   */
  settled: (state: AgentAskState) => void;
}

export interface AgentAskChannel {
  /**
   * Point the channel at the window on screen. A changed URL is a new window, so
   * the one-shot ids, the budget and the duplicate window all start over; the
   * reader's mute does not, because it is the reader's and not the app's (§7
   * row 7). Anything that cannot be parsed as a real URL leaves the channel with
   * no origin, and it answers nobody.
   */
  setLaunchedUrl(url: string | undefined): void;
  /** The origin of the window on screen, or undefined when no app is framed. */
  currentOrigin(): string | undefined;
  /**
   * One raw message, and the frame's own window object. Returns the envelope to
   * post back to that frame, or `undefined` for silence. The frame window is only
   * ever compared by identity — never touched, never messaged from here.
   */
  handle(
    event: AgentAskMessageEvent,
    frameWindow: unknown,
  ): AgentAskAnswer | undefined;
  /** Mute one origin's app for the rest of the browser session. */
  setMuted(origin: string, muted: boolean): void;
  /** Whether that origin's app is muted right now. */
  isMuted(origin: string): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True for the bridge's own envelope at all, whatever state it is in. It splits
 * "some other library's message" (silence) from "our message, badly formed"
 * (`invalid`): this window carries comlink traffic, wallet events and the SDK's
 * own messages, and none of them may be answered.
 */
export const isAgentAskMessage = (data: unknown): boolean =>
  isRecord(data) && data.type === AGENT_ASK_MESSAGE;

const ENVELOPE_FIELDS = ['type', 'v', 'id', 'ask', 'text', 'embeds'];

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The ask §3.1 defines, or `undefined`. Every rule of §3.6 that lands in the
 * envelope's own shape is enforced here and reported as one wordless `invalid`:
 *
 *  - an unknown field is refused, because a field Fiddy does not have is an ask
 *    for something Fiddy does not have — a wallet, a recipient, a signature, a
 *    specific agent;
 *  - the envelope cannot name an identity at all: an ask carries no fid and no
 *    agent id, and the shell decides both from its own session (§5);
 *  - `text` is required for every ask, and `remind` is no exception: §3.4's own
 *    template puts the app's words in the message the agent is asked.
 *
 * What is *not* done here, deliberately: the app's free text is never scanned
 * for forbidden nouns. A "draft a cast about my wallet" is a legitimate ask, and
 * §7 row 4 defangs injection by building the agent's message from a fixed
 * template with the text quoted and labelled untrusted — not by a word filter.
 *
 * All that is returned is a copy of the known fields, so nothing the app added
 * can ride along to whatever composes a message later.
 */
export const readAgentAsk = (data: unknown): AgentAskEnvelope | undefined => {
  if (!isRecord(data) || data.v !== AGENT_ASK_VERSION) {
    return undefined;
  }

  const id = data.id;
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > AGENT_ASK_MAX_ID_LENGTH
  ) {
    return undefined;
  }

  const ask = data.ask;
  if (!ASK_KINDS.includes(ask as AgentAskKind)) {
    return undefined;
  }

  const text = data.text;
  if (
    typeof text !== 'string' ||
    text.length > AGENT_ASK_MAX_TEXT_LENGTH ||
    text.trim().length === 0
  ) {
    return undefined;
  }

  if (Object.keys(data).some((key) => !ENVELOPE_FIELDS.includes(key))) {
    return undefined;
  }

  if (data.embeds === undefined) {
    return { id, ask: ask as AgentAskKind, text };
  }

  const embeds = data.embeds;
  if (ask !== 'draft' || !Array.isArray(embeds)) {
    return undefined;
  }
  if (embeds.length > AGENT_ASK_MAX_EMBEDS) {
    return undefined;
  }
  if (embeds.some((embed) => typeof embed !== 'string' || !isHttpsUrl(embed))) {
    return undefined;
  }

  return {
    id,
    ask: ask as AgentAskKind,
    text,
    embeds: [...embeds] as string[],
  };
};

const MUTE_KEY_PREFIX = 'fiddy.agent-ask.muted:';

/**
 * Where the mute lives: session storage, keyed by the app's origin (§4). It
 * survives a new window on the same origin and dies with the tab, and it is the
 * only thing this bridge stores about an app. Nothing here throws: a browser
 * with storage switched off (private mode, a blocked origin) keeps the same
 * answer in memory for the life of the page.
 */
export const createSessionMuteStore = (): AgentAskMuteStore => {
  const memory = new Map<string, boolean>();

  const storage = (): Storage | undefined => {
    try {
      return typeof window === 'undefined' ? undefined : window.sessionStorage;
    } catch {
      return undefined;
    }
  };

  return {
    read: (origin) => {
      const store = storage();
      if (store) {
        try {
          return store.getItem(MUTE_KEY_PREFIX + origin) === '1';
        } catch {
          return memory.get(origin) === true;
        }
      }
      return memory.get(origin) === true;
    },
    write: (origin, muted) => {
      memory.set(origin, muted);
      const store = storage();
      if (!store) {
        return;
      }
      try {
        if (muted) {
          store.setItem(MUTE_KEY_PREFIX + origin, '1');
        } else {
          store.removeItem(MUTE_KEY_PREFIX + origin);
        }
      } catch {
        // The in-memory answer above is still the reader's.
      }
    },
  };
};

/** The origin of a launched URL, or undefined when there is none to trust. */
const originOf = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
};

interface AgentAskWindowState {
  /** Ids spent in this window. One-shot: a replay is walked past in silence. */
  usedIds: Set<string>;
  /** Asks that got their own fresh answer and would have raised something. */
  asksUsed: number;
  /** The last such ask, for §4's 30 s duplicate window. */
  lastAsked?: {
    ask: AgentAskKind;
    text: string;
    at: number;
    /**
     * What that ask was answered. Absent while the slices that do the work are
     * still deciding it (a deferred ask): a duplicate then joins the decision
     * already in front of the reader instead of being told a placeholder.
     */
    state?: AgentAskState;
  };
}

/**
 * The context a deferred answer is given, built in one place so the two call
 * sites (a fresh ask, and a duplicate of one still being decided) cannot drift.
 *
 * `settled` writes the ask's own outcome back into §4's duplicate window, and
 * only for the entry it was built for: an ask that arrived after this one has
 * its own record and its own answer, and a late verdict must not overwrite it.
 */
const deferralFor = (
  envelope: AgentAskEnvelope,
  origin: string,
  frameWindow: unknown,
  state: AgentAskWindowState,
  at: number,
): AgentAskDeferral => ({
  origin,
  frameWindow,
  settled: (settled: AgentAskState) => {
    const last = state.lastAsked;
    if (
      last &&
      last.ask === envelope.ask &&
      last.text === envelope.text &&
      last.at === at
    ) {
      state.lastAsked = {
        ...last,
        ask: last.ask,
        text: last.text,
        at,
        state: settled,
      };
    }
  },
});

/**
 * The order that decides which answer wins (§6), with §4's two flood controls
 * slotted where they belong. Silence is not on the list because it is not an
 * answer: a frame that is not the app, a message that is not ours, and a replayed
 * id are all walked past without one.
 *
 * ```
 * invalid → no_agent → muted → duplicate → budget → unavailable → the ask
 * ```
 *
 * Validation first (a malformed ask is refused before anything else is
 * considered), then the environment (`no_agent` is about the session, not about
 * the app), then the app's standing with this reader (mute outranks budget: a
 * muted app is not told how many asks it has left), then §4's duplicate window
 * (an identical ask inside 30 s costs nothing and raises nothing), then the
 * ceiling, and only then the ask's own route — which, in this slice, nothing can
 * reach yet.
 *
 * The budget counts asks that got their own fresh answer, so what it caps is
 * exactly what §4 means by a flood: asks that would put something in front of
 * the reader. A malformed ask is not one, an ask already answered from the
 * duplicate window is not a new one, `no_agent` is the app being told to come
 * back when the reader has a session, and a muted app is not being counted at
 * all. The answer to the ask that crosses the ceiling is `budget`, for the life
 * of the window.
 */
export const createAgentAskChannel = (
  options: AgentAskChannelOptions,
): AgentAskChannel => {
  const mutes = options.mutes ?? createSessionMuteStore();
  const now = options.now ?? (() => Date.now());

  let launchedUrl: string | undefined;
  let stateOrigin: string | undefined;
  let windowState: AgentAskWindowState | undefined;

  const freshState = (): AgentAskWindowState => ({
    usedIds: new Set<string>(),
    asksUsed: 0,
  });

  return {
    setLaunchedUrl(url) {
      if (url !== launchedUrl) {
        launchedUrl = url;
        windowState = undefined;
      }
      stateOrigin = originOf(url);
    },

    currentOrigin: () => stateOrigin,

    handle(event, frameWindow) {
      // The pin, twice over: this iframe's own window object *and* the origin
      // the window was launched with. A sibling frame, a frame inside the app,
      // an ad iframe, or the app's own origin answering from somewhere else all
      // fail one or both and are never answered (§7 rows 5 and 10).
      if (!stateOrigin) {
        return undefined;
      }
      if (!frameWindow || event.source !== frameWindow) {
        return undefined;
      }
      if (event.origin !== stateOrigin) {
        return undefined;
      }

      // Not our envelope at all (comlink, the wallet, the SDK): not ours to
      // answer. A reply here would be this window telling every other library's
      // traffic what it thinks of it.
      if (!isAgentAskMessage(event.data)) {
        return undefined;
      }

      const raw = event.data as Record<string, unknown>;
      // The answer is addressed with the id we were given, when it is one we can
      // use. An ask with an unusable id still gets its refusal, with an empty
      // id, because refusing by name beats a silent nothing — it just cannot be
      // matched to the app's own promise.
      const rawId = raw.id;
      const replyId =
        typeof rawId === 'string' && rawId.length <= AGENT_ASK_MAX_ID_LENGTH
          ? rawId
          : '';

      const envelope = readAgentAsk(raw);
      if (!envelope) {
        // Never says which field failed: a diagnosis is a specification for the
        // next attempt (§3.6).
        return agentAskAnswer(replyId, 'invalid');
      }

      const state = (windowState ??= freshState());

      // One-shot, and burned even by a refusal: an app that re-uses an id is
      // replaying, and the first answer already told it what it needed.
      if (state.usedIds.has(envelope.id)) {
        return undefined;
      }
      state.usedIds.add(envelope.id);

      if (!options.hasPairedSession()) {
        return agentAskAnswer(envelope.id, 'no_agent');
      }

      if (mutes.read(stateOrigin)) {
        return agentAskAnswer(envelope.id, 'muted');
      }

      const at = now();
      const last = state.lastAsked;
      if (
        last &&
        last.ask === envelope.ask &&
        last.text === envelope.text &&
        at - last.at <= AGENT_ASK_DEDUPE_MS
      ) {
        // The same answer again, under the app's new id. A courtesy for a
        // double-send or a retry, not a ceiling: an app that varies one
        // character is a new ask and spends budget like one.
        if (last.state !== undefined) {
          return agentAskAnswer(envelope.id, last.state);
        }
        // That ask is still in front of the reader (a deferred one, whose
        // answer is not known yet). A second send of it is the same decision,
        // so it goes to the same handler — which joins it (S2's store) — and
        // spends nothing, because it raises nothing.
        if (
          options.answerAsk?.(
            envelope,
            deferralFor(envelope, stateOrigin, frameWindow, state, last.at),
          )
        ) {
          return undefined;
        }
        // No handler for it left the first one unanswered; the honest word for
        // an ask this shell cannot answer is still `unavailable`.
        return agentAskAnswer(envelope.id, 'unavailable');
      }

      if (state.asksUsed >= AGENT_ASK_BUDGET) {
        return agentAskAnswer(envelope.id, 'budget');
      }

      state.asksUsed += 1;

      // The ask is real, counted and addressed. If a slice has a path for it
      // (S2's `draft`/`post`, S3's `remind`), it takes the ask and answers in
      // its own time, with its own state word; otherwise this slice's whole
      // answer stands — `unavailable`, the honest state for a shell that has no
      // path for something yet.
      //
      // The record is written *before* the handler is handed the ask, with no
      // state: §4's duplicate window then treats a second send of it as the
      // same decision rather than as a placeholder nobody ever gave.
      if (options.answerAsk !== undefined) {
        state.lastAsked = { ask: envelope.ask, text: envelope.text, at };
        if (
          options.answerAsk(
            envelope,
            deferralFor(envelope, stateOrigin, frameWindow, state, at),
          )
        ) {
          return undefined;
        }
      }

      const answer = agentAskAnswer(envelope.id, 'unavailable');
      state.lastAsked = {
        ask: envelope.ask,
        text: envelope.text,
        at,
        state: answer.state,
      };
      return answer;
    },

    setMuted: (origin, muted) => mutes.write(origin, muted),

    isMuted: (origin) => mutes.read(origin),
  };
};
