/**
 * A setup somebody walked away from, so another one can start.
 *
 * The gap this closes: an account is now written down on this device before it
 * is finished (see `AccountSetupAttempt` in `./localAccounts`), which is what
 * makes a reload safe — and also what makes the next screen dishonest if it
 * ignores it. A half-made account that greets every surface with "finish me" is
 * a trap for somebody who came back to make a *different* account.
 *
 * So the front door can set an unfinished setup aside: it stays selected, it
 * stays in the list, nothing is deleted — this device just stops treating it as
 * the thing in progress. `resumesSetup` is the one question every surface asks,
 * and the line that puts it back ("Finish setting up @them") is always drawn
 * for an unfinished account, set aside or not. There is no state a person can
 * reach where their half-made account is invisible and undeletable.
 *
 * Session-scoped on purpose, exactly like a modal: a reload is a fresh start at
 * the front door, where the unfinished account is offered again.
 */

import { isSettingUp, type LocalAccount } from './localAccounts';

/** The account whose setup was set aside, or null. */
let asideId: string | null = null;

/**
 * Remember that this device stopped setting an account up.
 *
 * Takes an account rather than an id so the rule lives in one place: `null`, or
 * an account that is already done, sets nothing aside — there is nothing to set
 * aside about a finished account, and a button that clears state on a no-op is
 * a button that silently forgets somebody else's setup.
 */
export const setSetupAside = (account: LocalAccount | null | undefined) => {
  asideId = account && isSettingUp(account) ? account.id : null;
};

/** The account id that was set aside, for a surface that wants to say so. */
export const setupSetAside = (): string | null => asideId;

/**
 * Should the setup pages pick this account's setup back up?
 *
 * No when there is no unfinished setup, and no while it is set aside. Yes for
 * every other unfinished account, which is how a new attempt started in the
 * meantime still sets itself up.
 */
export const resumesSetup = (
  account: LocalAccount | null | undefined,
): boolean =>
  Boolean(account && isSettingUp(account) && account.id !== asideId);
