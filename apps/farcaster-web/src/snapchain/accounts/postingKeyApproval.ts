/**
 * "Let Fiddy post for you?" — asked at the moment a write needs it, not before.
 *
 * WHY THIS EXISTS
 *
 * `~/snapchain/nodeApi/nodeWrites` answers a like, a recast, a follow or a cast
 * by signing it with the posting key this device holds for the signed-in
 * account. When there is no such key, the write is refused — correctly — with a
 * sentence that sends the reader to Advanced → their setup → "Issue app key".
 *
 * That sentence is true and it is not where the reader is standing: they just
 * pressed the heart on a cast. This module is what happens instead. The writer
 * hands the *pending write itself* to `ask` below; this store puts one friendly
 * screen in front of the person (the approval sheet, `ConnectSheet`, which is
 * the same screen `/connect-farcaster` shows); and once the service says the
 * posting key exists, the very same write is carried out and its real answer is
 * returned to the code that asked for it — so nothing has to be pressed twice,
 * and the heart fills exactly as it would have if the key had been there all
 * along.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never carries a write nobody approved: `ask` returns the carried write
 *   only after the service's own answer said `connected`, and returns `null`
 *   (which the writer turns back into the unchanged NO_APP_KEY sentence) on a
 *   decline, on a timeout, and on a screen that went away.
 * - It never claims a key exists: the proof is the same one every granted-key
 *   write already uses (`~/snapchain/accounts/managedConnect`), checked by the
 *   writer itself on the retry — if the approval did not really happen, the
 *   retry is refused again and the person reads the honest sentence.
 * - It holds one write at a time in front of the person. A second write that
 *   needs the same approval joins the decision already being made (it is the
 *   same tap) and carries itself afterwards.
 * - It gives up. Five minutes of silence ends the wait: a request that hangs
 *   forever in a mutation is a dead spinner on a page nobody can fix.
 *
 * This file is React-free (`getState`/`subscribe` are exactly what
 * `useSyncExternalStore` wants) so the writer's tests can drive it with no
 * browser, and the screen can render it with no protocol knowledge.
 */

import type {
  WriteApproval,
  WriteApprovalLabel,
  WriteApprovalRequest,
} from '~/snapchain/nodeApi/nodeWrites';

/**
 * How long a person may take. Approving happens in their own Farcaster app: a
 * phone in hand, an unlock, a tap, and a screen that polls every 2.5 s. Five
 * minutes is longer than that takes and far shorter than forever — and the
 * refusal it ends in is the honest one, not a silent nothing.
 */
export const APPROVAL_DEADLINE_MS = 5 * 60_000;

/** The write waiting for a decision, as a screen needs to know it. */
export interface PendingWriteApproval {
  fid: number;
  label: WriteApprovalLabel;
}

export type ApprovalPhase = 'idle' | 'asking' | 'finishing';

export interface PostingKeyApprovalState {
  /** `asking` while the person is being asked, `finishing` while a write runs. */
  phase: ApprovalPhase;
  /** The write in front of the person, or null when there is none. */
  pending: PendingWriteApproval | null;
}

export interface PostingKeyApproval {
  /**
   * The writer's own option (`WriteApproval`): ask for a posting key and answer
   * with the carried write, or with nothing when the person did not approve.
   */
  ask: WriteApproval;
  getState: () => PostingKeyApprovalState;
  subscribe: (listener: () => void) => () => void;
  /** The service said the posting key exists. Carries the write that waited. */
  approved: () => void;
  /** The person said not now — or closed the screen that was asking. */
  declined: () => void;
}

export interface PostingKeyApprovalOptions {
  /** How long a person has before the wait ends. Injectable for tests. */
  deadlineMs?: number;
}

/** One approval in flight: the write in front of the person, and its decision. */
interface ApprovalInFlight {
  pending: PendingWriteApproval;
  decision: Promise<boolean>;
  settle: (approved: boolean) => void;
}

const IDLE: PostingKeyApprovalState = { phase: 'idle', pending: null };

export const createPostingKeyApproval = ({
  deadlineMs = APPROVAL_DEADLINE_MS,
}: PostingKeyApprovalOptions = {}): PostingKeyApproval => {
  let current: ApprovalInFlight | null = null;
  /**
   * The write the screen is about — while it is being asked about *and* while it
   * is being carried out. The two are one story to the person ("your like"), so
   * the screen does not lose the name in between; it is only forgotten when the
   * last write has been answered.
   */
  let pending: PendingWriteApproval | null = null;
  /** How many writes are being carried right now (an approval can carry more). */
  let carrying = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  let snapshot: PostingKeyApprovalState = IDLE;

  const publish = (): void => {
    const phase: ApprovalPhase =
      carrying > 0 ? 'finishing' : current !== null ? 'asking' : 'idle';
    if (phase === 'idle') {
      pending = null;
    }
    snapshot = { phase, pending };
    for (const listener of listeners) {
      listener();
    }
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /**
   * The person decided: no more waiting, and no more screen *for the ask* — the
   * write that was waiting takes over from here.
   *
   * The clear happens in `ask`, at the point the write starts being carried,
   * rather than in the decision itself: `approved` and the carried write are one
   * moment to the person, and a screen that blinked out and back in between them
   * would be a flicker nobody could explain.
   */
  const approved = (): void => {
    current?.settle(true);
  };

  const declined = (): void => {
    current?.settle(false);
  };

  const ask = async (
    request: WriteApprovalRequest,
  ): Promise<Response | null> => {
    const lead = current === null;
    if (current === null) {
      let settle: (approved: boolean) => void = () => undefined;
      const decision = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      current = {
        pending: { fid: request.fid, label: request.label },
        decision,
        settle,
      };
      pending = current.pending;
      // The clock starts when the person is first asked, and it must not keep
      // the process alive in a test runner.
      timer = setTimeout(() => declined(), deadlineMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      publish();
    }

    // Join the decision already being made: it is one tap for the person, so
    // it is one wait for every write standing behind it.
    const inFlight = current;
    const decided = await inFlight.decision;
    if (lead) {
      clearTimer();
    }
    if (!decided) {
      if (lead) {
        current = null;
      }
      publish();
      return null;
    }

    carrying += 1;
    if (lead) {
      // The screen stops asking and says what is happening instead.
      current = null;
    }
    if (pending === null) {
      // A write joining a carry that has already started still names itself.
      pending = { fid: request.fid, label: request.label };
    }
    publish();
    try {
      return await request.carry();
    } finally {
      carrying -= 1;
      publish();
    }
  };

  return {
    ask,
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    approved,
    declined,
  };
};

/**
 * The one the client uses: the seam reaches it through
 * `~/contexts/WebFarcasterApiClientProvider`, and the screen through
 * `~/components/session/SignerApprovalGate`.
 */
export const postingKeyApproval = createPostingKeyApproval();

/**
 * The writer's option, bound. Passing this into the seam is the whole wiring:
 * nothing else about a write changes.
 */
export const askForPostingKey: WriteApproval = (request) =>
  postingKeyApproval.ask(request);
