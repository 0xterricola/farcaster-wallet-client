/**
 * The accounts this device holds, and which one is signing in.
 *
 * Fiddy used to hold exactly one identity: the session the sign-in left behind,
 * with one app key stored against one FID. Multiple accounts are the same idea
 * with a list instead of a variable — every account keeps its own recovery
 * phrase (for accounts made here) and its own signing key (already stored per
 * FID by `~/snapchain/appKeyStorage`, so no key can ever be used for the wrong
 * account), and exactly one of them is selected at a time.
 *
 * WHAT IS ON THIS DEVICE, AND WHAT IS NOT
 *
 * A recovery phrase written here is stored here and nowhere else: not in a
 * Fiddy request, not in analytics, not in a log. That is the whole point of
 * creating an account in the client rather than asking a server to do it — the
 * server never has the key that owns the account.
 *
 * The selected account is what the client signs with, so the switch is announced
 * twice on purpose: in the account menu ("signing in as …"), and by the session
 * the client then holds.
 */

import { clearAppKey } from '~/snapchain/appKeyStorage';
import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

/** Every account this browser knows, in the order they were added. */
const ACCOUNTS_KEY = 'fiddy:accounts';

/** Which of them is selected. */
const CURRENT_ACCOUNT_KEY = 'fiddy:current-account';

/** Fired after any write, so mounted surfaces re-read instead of guessing. */
export const LOCAL_ACCOUNTS_CHANGED_EVENT = 'fiddy:accounts-changed';

export interface LocalAccount {
  /** The custody address, lowercased: one account per address, by definition. */
  id: string;
  custodyAddress: string;
  /**
   * The recovery phrase, for an account this device created. It is the key that
   * owns the account, so it stays here and is never sent anywhere.
   */
  phrase?: string;
  /** The FID, once the network has given the account its number. */
  fid?: number;
  username?: string;
  displayName?: string;
  createdAt: number;
  /** When a signing key for this device was last installed for this account. */
  signedInAt?: number;
  /**
   * How the account was made, when it was made with a social sign-up
   * (see `~/lib/socialAccount`): the words behind it are held by the sign-up
   * provider rather than written down here, and the person is named by their
   * email or handle rather than by an address they have never seen.
   */
  walletCustody?: 'privy';
  provider?: string;
  email?: string;
}

/** One account per custody address. */
export const accountIdFor = (custodyAddress: string): string =>
  custodyAddress.trim().toLowerCase();

const announce = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(LOCAL_ACCOUNTS_CHANGED_EVENT));
  }
};

export const loadLocalAccounts = async (): Promise<LocalAccount[]> => {
  const stored = await getItem<LocalAccount[] | null>({
    key: ACCOUNTS_KEY,
    fallback: null,
  });

  if (!Array.isArray(stored)) {
    return [];
  }

  return stored.filter(
    (account): account is LocalAccount =>
      Boolean(account) &&
      typeof account.id === 'string' &&
      typeof account.custodyAddress === 'string',
  );
};

export const loadCurrentAccountId = async (): Promise<string | undefined> =>
  (await getItem<string | null>({
    key: CURRENT_ACCOUNT_KEY,
    fallback: null,
  })) ?? undefined;

/** The selected account, or undefined when this device holds none. */
export const loadCurrentAccount = async (): Promise<
  LocalAccount | undefined
> => {
  const [accounts, currentId] = await Promise.all([
    loadLocalAccounts(),
    loadCurrentAccountId(),
  ]);

  return accounts.find((account) => account.id === currentId);
};

/**
 * Add or update an account. `select` is for the account that was just created —
 * the person who made it is holding it.
 */
export const saveLocalAccount = async (
  account: LocalAccount,
  { select = true }: { select?: boolean } = {},
) => {
  const accounts = await loadLocalAccounts();
  const index = accounts.findIndex((candidate) => candidate.id === account.id);

  if (index >= 0) {
    accounts[index] = { ...accounts[index], ...account };
  } else {
    accounts.push(account);
  }

  await setItem({ key: ACCOUNTS_KEY, value: accounts });

  if (select) {
    await setItem({ key: CURRENT_ACCOUNT_KEY, value: account.id });
  }

  announce();

  return accounts;
};

/** Choose which account the client signs in as. */
export const selectLocalAccount = async (id: string) => {
  await setItem({ key: CURRENT_ACCOUNT_KEY, value: id });
  announce();
};

/**
 * Forget an account on this device.
 *
 * This is the honest kind of "remove": it deletes what is stored here — the
 * entry, the recovery phrase, and the posting key this device holds for that
 * FID — and says out loud that an account whose phrase is gone cannot be
 * recovered by Fiddy, because the keys were never ours to restore. Forgetting an
 * account that still has a key installed on the node leaves the key valid there;
 * what this removes is this browser's ability to use it.
 *
 * The key is left alone when another account in the list still carries that
 * same FID: one FID is one key, and forgetting a duplicate entry must not
 * disarm the account that is still held.
 */
export const removeLocalAccount = async (id: string) => {
  const accounts = await loadLocalAccounts();
  const removed = accounts.find((account) => account.id === id);
  const remaining = accounts.filter((account) => account.id !== id);

  await setItem({ key: ACCOUNTS_KEY, value: remaining });

  if (
    removed?.fid !== undefined &&
    !remaining.some((account) => account.fid === removed.fid)
  ) {
    await clearAppKey(removed.fid);
  }

  const currentId = await loadCurrentAccountId();

  if (currentId === id) {
    const next = remaining[0];
    await setItem({
      key: CURRENT_ACCOUNT_KEY,
      value: next ? next.id : undefined,
    });
  }

  announce();

  return remaining;
};

/** Clear the list entirely (used when the last account is removed). */
export const clearLocalAccounts = async () => {
  await deleteItem(ACCOUNTS_KEY);
  await deleteItem(CURRENT_ACCOUNT_KEY);
  announce();
};

/**
 * How an account is named on screen: the handle when it has one, else its
 * number, else the short address. Never invents a handle it does not have.
 */
export const describeLocalAccount = (account: LocalAccount): string => {
  if (account.username) {
    return `@${account.username}`;
  }

  if (account.fid !== undefined) {
    return `account ${account.fid}`;
  }

  // An account signed up with Google or X has no number yet and a name the
  // person recognises — the email or handle they signed up with. The address it
  // is keyed by is the wallet held for them, which is nobody's idea of a name,
  // so it is the last resort rather than the first.
  if (account.email) {
    return account.email;
  }

  return `${account.custodyAddress.slice(0, 6)}…${account.custodyAddress.slice(-4)}`;
};

/** "signing in as @fiddy" / "signing in as account 4242" — the honest label. */
export const signedInAsLabel = (
  account: LocalAccount | undefined,
): string | undefined =>
  account ? `signing in as ${describeLocalAccount(account)}` : undefined;
