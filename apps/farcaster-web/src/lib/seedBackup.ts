/**
 * Whether to ask someone to back their account up, and when to stop asking.
 *
 * THE RULE THIS ENCODES. Signing up with Google or X must never end with a
 * person being handed twelve words and told that losing them loses everything —
 * that is not a seamless way in, and it is how a phrase ends up in a screenshot.
 * So an account is made with its words held for it, and the asking happens
 * afterwards, in plain words, as a reminder that can be put off:
 *
 *   unseen    — ask on the account screen, once per visit at most;
 *   deferred  — "not now" is a real answer: ask again after `DEFER_MS`;
 *   saved     — the person said they had written it down. Never ask again.
 *
 * WHY A GAP, AND WHY THREE DAYS. Asking on every navigation is nagging, and a
 * nag is what gets a notice dismissed for good; a gap of days is what makes the
 * third ask land as "this one is actually important". Three days is chosen to be
 * long enough to be an interruption and short enough that a person who signed up
 * on Monday still remembers why the notice is there on Thursday.
 *
 * WHAT A VISIT IS, EXACTLY. The ask is recorded here as it is asked, which is
 * what stops a reload from being a fresh ask. A screen that is built again
 * *inside the same page load* is not a second visit either: it must not hide a
 * notice the person has not answered — see `asksOnScreenThisPageLoad` in
 * `~/components/fiddy/seedBackup/SeedBackupNotice`.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never reads, stores or compares
 * the words themselves. It stores four facts — when it last asked, how many
 * times, when to ask again, and whether the person said it was done — under one
 * key, and nothing else. The words stay where they were: on the device that made
 * them, or in the sign-up provider's own custody.
 */

import { getItem, setItem } from '~/utils/storageUtils';

export type SeedBackupStatus = 'unseen' | 'deferred' | 'saved';

export type SeedBackupState = {
  status: SeedBackupStatus;
  /** How many times the person has been asked and said "not now". */
  reminders: number;
  /** When the notice was last on screen (ms). */
  lastShownAt?: number;
  /** Don't ask again before this moment (ms). */
  remindAfter?: number;
  /** When the person said they had written the words down (ms). */
  savedAt?: number;
};

/** One key for the whole answer: which account's backup this state is about. */
const SEED_BACKUP_KEY_PREFIX = 'fiddy:seed-backup:';

export const seedBackupKeyFor = (accountId: string): string =>
  `${SEED_BACKUP_KEY_PREFIX}${accountId.trim().toLowerCase()}`;

/** How long "not now" lasts. */
export const DEFER_MS = 3 * 24 * 60 * 60 * 1000;

/** The shortest gap between two asks, so a visit or a reload is not a new ask. */
export const MIN_GAP_BETWEEN_ASKS_MS = 20 * 60 * 60 * 1000;

export const initialSeedBackupState = (): SeedBackupState => ({
  status: 'unseen',
  reminders: 0,
});

/**
 * Should the notice be on screen right now?
 *
 * A saved account is never asked about again — that is the promise the confirm
 * step makes. An unseen one is asked about once per gap. A deferred one waits
 * for its moment, which passes on its own without anything having to happen.
 */
export const shouldAskForBackup = (
  state: SeedBackupState,
  now: number,
): boolean => {
  if (state.status === 'saved') {
    return false;
  }

  if (
    state.lastShownAt !== undefined &&
    now - state.lastShownAt < MIN_GAP_BETWEEN_ASKS_MS
  ) {
    return false;
  }

  if (state.status === 'deferred' && state.remindAfter !== undefined) {
    return now >= state.remindAfter;
  }

  return true;
};

/** The notice went on screen. Recorded so the gap above can be enforced. */
export const noteBackupAsked = (
  state: SeedBackupState,
  now: number,
): SeedBackupState => ({ ...state, lastShownAt: now });

/** "Not now" — a real answer, with a date attached. */
export const deferBackup = (
  state: SeedBackupState,
  now: number,
): SeedBackupState => ({
  ...state,
  status: 'deferred',
  reminders: state.reminders + 1,
  lastShownAt: now,
  remindAfter: now + DEFER_MS,
});

/** "I've written them down." The asking is over, for this account. */
export const markBackupSaved = (
  state: SeedBackupState,
  now: number,
): SeedBackupState => ({
  ...state,
  status: 'saved',
  lastShownAt: now,
  savedAt: now,
});

export const loadSeedBackupState = async (
  accountId: string,
): Promise<SeedBackupState> => {
  const stored = await getItem<SeedBackupState | null>({
    key: seedBackupKeyFor(accountId),
    fallback: null,
  });

  if (!stored || typeof stored !== 'object') {
    return initialSeedBackupState();
  }

  const status = stored.status;

  if (status !== 'unseen' && status !== 'deferred' && status !== 'saved') {
    return initialSeedBackupState();
  }

  return {
    status,
    reminders: typeof stored.reminders === 'number' ? stored.reminders : 0,
    lastShownAt: stored.lastShownAt,
    remindAfter: stored.remindAfter,
    savedAt: stored.savedAt,
  };
};

export const saveSeedBackupState = async (
  accountId: string,
  state: SeedBackupState,
): Promise<void> => {
  await setItem({ key: seedBackupKeyFor(accountId), value: state });
};
