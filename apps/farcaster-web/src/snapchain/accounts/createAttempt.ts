/**
 * Where a started setup actually is, and what it was written down as.
 *
 * Two jobs, both about the fact that an account now exists on this device
 * before it is finished:
 *
 *   1. `startedSetupAccount` is the entry written at the end of the phrase step
 *      — before a single wei moves. It carries the twelve words (already here,
 *      see `./localAccounts`) and the one device signing key this attempt will
 *      ever install, so a retry does not mint a second one.
 *   2. `setupStepFrom` answers the only question a resume may not guess: where
 *      the facts have got to. The answer comes from the chain this client
 *      already reads — a FID means the fee already bought the account, so the
 *      setup finishes rather than registering a second time; enough ETH and no
 *      FID means registration is still the next step.
 *
 * Nothing here remembers progress as "done". A step written down is a hint for
 * the copy on screen; the step acted on is the one the chain says.
 */

import type { FundingState } from './createAccount';
import type { LocalAccount } from './localAccounts';
import { MAX_REGISTRATION_PRICE_WEI } from './optimism';

/** Identifies one setup attempt. A write carrying a stale id is refused. */
export const newAttemptId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `attempt-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Attempts somebody has walked away from, by id.
 *
 * Kept for the life of the tab, on purpose: the whole point is that a message
 * which lands MINUTES after the person pressed start over — a signature coming
 * back from a wallet, a registration confirming — is refused. Forgetting the id
 * when the entry is deleted is exactly the race this set exists to close.
 */
const startedOverIds = new Set<string>();

/** Mark an attempt as left behind. Nothing it does afterwards is kept. */
export const markAttemptStartedOver = (attemptId: string): void => {
  startedOverIds.add(attemptId);
};

/** Was this attempt left behind? */
export const attemptWasStartedOver = (attemptId: string): boolean =>
  startedOverIds.has(attemptId);

/**
 * The entry this device keeps while an account is being made.
 *
 * `select` is deliberate in the caller: the person making this account is
 * holding it, so every surface from here on means this account when it says
 * "the current one".
 */
export const startedSetupAccount = ({
  account,
  attemptId,
  signingKeyHex,
  startedAt = Date.now(),
}: {
  account: Omit<LocalAccount, 'setup' | 'createdAt'> & {
    createdAt?: number;
  };
  attemptId: string;
  signingKeyHex: string;
  startedAt?: number;
}): LocalAccount => ({
  ...account,
  createdAt: account.createdAt ?? startedAt,
  setup: { attemptId, startedAt, signingKeyHex, lastStep: 'fund' },
});

/**
 * What to do next, from the chain alone.
 *
 * - `registered` — an FID exists, so the fee was already spent: finish the
 *   account (signing key, name, profile) and never register it again.
 * - `funded`     — enough ETH, no FID yet: registration is the next step.
 * - `waiting`    — not enough arrived yet; keep showing the address.
 * - `blocked`    — the chain cannot be read, or is not the chain we expect.
 */
export type SetupStepFromChain =
  | 'registered'
  | 'funded'
  | 'waiting'
  | 'blocked';

export const setupStepFrom = (funding: FundingState): SetupStepFromChain => {
  if (funding.kind !== 'ready') {
    return 'blocked';
  }

  if (funding.fid > 0) {
    return 'registered';
  }

  if (funding.price > MAX_REGISTRATION_PRICE_WEI) {
    // The endpoint quoted a fee far above the real one; registering on it would
    // spend somebody's money on a lie.
    return 'blocked';
  }

  return funding.enough ? 'funded' : 'waiting';
};
