/**
 * The ask card's own store: one decision in front of the reader, and the honest
 * end of every wait.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §4 (the card, one ask
 * at a time, five minutes, the mute) and §6 (the sentences). This is S2's half
 * of the bridge: a third-party mini app has asked this reader's agent for
 * something, and the reader is the only one who may say yes.
 *
 * WHY IT IS SHAPED LIKE `postingKeyApproval`
 *
 * The client already has exactly one store for "something wants the reader's
 * decision" (`~/snapchain/accounts/postingKeyApproval`), and this is the same
 * shape on purpose: one ask in front of the person, a second ask **joins** the
 * decision already being made instead of stacking a second card (it is one
 * decision to the person), five minutes of silence ends the wait with the
 * honest refusal, and the store is React-free with `getState`/`subscribe` so the
 * card renders it through `useSyncExternalStore` and a test drives it with no
 * browser.
 *
 * TWO PLACES IT DIFFERS, BOTH BECAUSE THE ASK IS SOMEBODY ELSE'S
 *
 * 1. **A join is same-origin only.** A write's approval is the reader's own
 *    device doing the reader's own thing, so every write waiting shares one tap.
 *    An ask is a *foreign page's* request: an ask from another origin is another
 *    window's ask, and it must never be carried by a card that named a different
 *    origin. So a second ask from the window already on screen joins it, and an
 *    ask from anywhere else waits its turn and gets its own card, with its own
 *    origin on it (§7 row 10).
 * 2. **The work happens after the decision, and it has its own states.** What
 *    the reader approved is a chat message (S2's `draft`) or their own composer
 *    (S2's `post`), so a ticket can say `working` while the shell does it and
 *    `end` when there is a line the reader must read (an agent that could not be
 *    reached). Every one of those is scoped to the ask it belongs to, so a slow
 *    handler cannot draw on a card that has already moved on.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never says yes by itself: `ask` answers `approved` only when the reader
 *   pressed the card's own control, and `declined` for a dismissal, a mute, a
 *   close, and five minutes of silence.
 * - It never carries an ask nobody approved — the caller gets the decision and
 *   nothing else, and there is no method here that performs an effect.
 * - It never stacks: one card on screen, ever, whatever arrives.
 */

import type { AgentAskKind } from '~/components/miniApp/agentAskChannel';

/**
 * How long a reader may take. The same five minutes the posting-key approval
 * gives: long enough for a person to read a sentence and press a button, far
 * shorter than forever, and it ends in a refusal rather than in a promise that
 * never resolves.
 */
export const AGENT_ASK_APPROVAL_DEADLINE_MS = 5 * 60_000;

/** The ask in front of the reader, as the card needs to know it. */
export interface PendingAgentAsk {
  /** The app's own id for the ask (§3.1): the answer is addressed with it. */
  id: string;
  /**
   * The origin the window was launched with — the *only* name the shell can
   * verify, and therefore the one the card's heading uses (§4).
   */
  origin: string;
  /** What the app asked for. S2 answers `draft` and `post`; `remind` is S3's. */
  kind: AgentAskKind;
  /** The app's own words. Rendered quoted and inert, never as shell chrome. */
  text: string;
  /** The app's own links, when it sent any (§3.1: `draft` only, ≤ 2, https). */
  embeds?: string[];
  /** The app's manifest name, when the shell read one: an aside, not a heading. */
  name?: string;
}

export type AgentAskDecision = 'approved' | 'declined';

/**
 * `asking` is the card in front of the reader; `working` is the shell doing what
 * they approved (one line, no controls); `ended` is one sentence the reader must
 * read before the card goes.
 */
export type AgentAskApprovalPhase = 'idle' | 'asking' | 'working' | 'ended';

export interface AgentAskApprovalState {
  phase: AgentAskApprovalPhase;
  /** The ask the card is about, or null when nothing is in front of anyone. */
  pending: PendingAgentAsk | null;
  /** The one line `working` or `ended` is drawn with, when there is one. */
  note?: string;
}

/**
 * One ask's handle, handed to whatever answers it. Every method is scoped to
 * that ask: a handler that finishes after its card has gone does nothing.
 */
export interface AgentAskTicket {
  /** `approved` only on the reader's own press; `declined` for everything else. */
  decision: Promise<AgentAskDecision>;
  /** The reader approved and the shell is doing the work — one line, no controls. */
  working: (note?: string) => void;
  /** Done: nothing more to show, and the next ask (if any) takes the window. */
  settle: () => void;
  /** A sentence the reader must read before this card goes. */
  end: (note: string) => void;
}

export interface AgentAskApproval {
  /**
   * Put one ask in front of the reader. A second ask from the same origin joins
   * the decision already being made; an ask from another origin waits its turn.
   */
  ask: (ask: PendingAgentAsk) => AgentAskTicket;
  getState: () => AgentAskApprovalState;
  subscribe: (listener: () => void) => () => void;
  /** The reader pressed `Ask Fiddy`. */
  approve: () => void;
  /** The reader pressed `Not now` — or dismissed, or muted, the ask in front of them. */
  decline: () => void;
  /** The reader has read the ended card and it may go. */
  close: () => void;
}

export interface AgentAskApprovalOptions {
  /** How long the reader has before the wait ends. Injectable for tests. */
  deadlineMs?: number;
}

/** One ask, in front of the reader or queued behind the one that is. */
interface Presented {
  ask: PendingAgentAsk;
  decision: Promise<AgentAskDecision>;
  settleDecision: (decision: AgentAskDecision) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const IDLE: AgentAskApprovalState = { phase: 'idle', pending: null };

export const createAgentAskApproval = ({
  deadlineMs = AGENT_ASK_APPROVAL_DEADLINE_MS,
}: AgentAskApprovalOptions = {}): AgentAskApproval => {
  /** The card on screen. One, ever. */
  let current: Presented | null = null;
  /** Asks waiting their turn, in the order they arrived. */
  const waiting: Presented[] = [];
  let phase: AgentAskApprovalPhase = 'idle';
  let note: string | undefined;
  let snapshot: AgentAskApprovalState = IDLE;
  const listeners = new Set<() => void>();

  const publish = (): void => {
    snapshot = {
      phase,
      pending: phase === 'idle' ? null : (current?.ask ?? null),
      ...(note === undefined ? {} : { note }),
    };
    for (const listener of listeners) {
      listener();
    }
  };

  const clearTimer = (presented: Presented): void => {
    if (presented.timer !== null) {
      clearTimeout(presented.timer);
      presented.timer = null;
    }
  };

  const startTimer = (presented: Presented): void => {
    presented.timer = setTimeout(() => {
      // Five minutes of silence. The honest refusal, for the ask in front of the
      // reader — the one they did not decide — and nothing for the ones behind
      // it, which have not been asked yet and get their own clock when they are.
      if (current === presented && phase === 'asking') {
        presented.settleDecision('declined');
        release();
      }
    }, deadlineMs);
    // A pending deadline must not hold a test runner (or a closing tab) open.
    if (
      typeof (presented.timer as { unref?: () => void }).unref === 'function'
    ) {
      (presented.timer as unknown as { unref: () => void }).unref();
    }
  };

  /** The card on screen is done: the next ask, if any, takes its place. */
  const release = (): void => {
    if (current !== null) {
      clearTimer(current);
    }
    current = waiting.shift() ?? null;
    note = undefined;
    if (current === null) {
      phase = 'idle';
    } else {
      phase = 'asking';
      startTimer(current);
    }
    publish();
  };

  const presented = (ask: PendingAgentAsk): Presented => {
    let settleDecision: (decision: AgentAskDecision) => void = () => undefined;
    const decision = new Promise<AgentAskDecision>((resolve) => {
      settleDecision = resolve;
    });
    return { ask, decision, settleDecision, timer: null };
  };

  const ticketFor = (one: Presented): AgentAskTicket => ({
    decision: one.decision,
    working: (line) => {
      if (current !== one) {
        return;
      }
      phase = 'working';
      note = line;
      publish();
    },
    settle: () => {
      if (current !== one) {
        return;
      }
      release();
    },
    end: (line) => {
      if (current !== one) {
        return;
      }
      phase = 'ended';
      note = line;
      publish();
    },
  });

  return {
    ask: (ask) => {
      // One decision at a time, and a join only while the reader is *deciding*
      // — plus only where the card already names this ask's own origin. A second
      // send of the same ask is the same decision for the person; an ask that
      // arrives after the reader already answered is not (its text has been
      // read by nobody), and somebody else's window is somebody else's (§7 rows
      // 1, 7 and 10).
      if (
        current !== null &&
        phase === 'asking' &&
        current.ask.origin === ask.origin
      ) {
        return ticketFor(current);
      }
      const one = presented(ask);
      if (current === null && waiting.length === 0) {
        current = one;
        phase = 'asking';
        note = undefined;
        startTimer(one);
        publish();
      } else {
        waiting.push(one);
      }
      return ticketFor(one);
    },

    getState: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    approve: () => {
      if (current === null || phase !== 'asking') {
        return;
      }
      current.settleDecision('approved');
      phase = 'working';
      note = undefined;
      publish();
    },

    decline: () => {
      if (current === null) {
        return;
      }
      current.settleDecision('declined');
      release();
    },

    close: () => {
      if (current === null || phase !== 'ended') {
        return;
      }
      release();
    },
  };
};
