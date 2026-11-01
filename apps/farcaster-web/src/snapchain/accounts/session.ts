/**
 * Signing in as an account this device holds.
 *
 * The client's session is the same honest one the SIWF sign-in produces: real
 * identity, no privileged server access (see `~/lib/siwfSession`). Building it
 * for a locally created account means a person who made an account here does not
 * have to sign in a second time with it — the session is assembled from the FID
 * and handle the account actually has, and the app is rebooted onto it.
 *
 * The one thing this must never do is claim more than it knows: an account
 * without a FID yet cannot sign in, because there is nothing to sign in as.
 */

import type { ApiToken } from 'farcaster-client-data';
import { useEffect, useState } from 'react';

import { getOnboardingStateKey } from '~/constants/storage';
import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
} from '~/lib/siwfSession';
import { setItem } from '~/utils/storageUtils';

import {
  loadCurrentAccountId,
  loadLocalAccounts,
  LOCAL_ACCOUNTS_CHANGED_EVENT,
  type LocalAccount,
} from './localAccounts';

export class LocalSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSignInError';
  }
}

/** The session an account signs in with: a local token and the state the app's
 *  signed-in gate reads. Exported so tests and the switcher agree on one shape. */
export const buildLocalSessionForAccount = (account: LocalAccount) => {
  if (account.fid === undefined) {
    throw new LocalSignInError(
      'this account has no number yet - finish setting it up first',
    );
  }

  const authToken = buildLocalAuthToken({ fid: account.fid });
  const onboardingState = buildLocalOnboardingState({
    fid: account.fid,
    username: account.username,
    displayName: account.displayName,
  });

  return { authToken, onboardingState };
};

/**
 * Sign in as a locally held account.
 *
 * The onboarding state is written BEFORE the token, exactly as the SIWF path
 * does, because the key it is stored under is derived from the token secret and
 * the reload that follows races the write.
 */
export const signInAsLocalAccount = async ({
  account,
  signIn,
}: {
  account: LocalAccount;
  signIn: (parameters: { authToken: ApiToken }) => Promise<void>;
}): Promise<void> => {
  const { authToken, onboardingState } = buildLocalSessionForAccount(account);

  await setItem({
    key: await getOnboardingStateKey(authToken.secret),
    value: onboardingState,
  });

  await signIn({ authToken: authToken as unknown as ApiToken });
};

export interface LocalAccountsState {
  accounts: LocalAccount[];
  currentId?: string;
  current?: LocalAccount;
  loading: boolean;
  reload: () => Promise<void>;
}

/** The accounts this device holds, re-read when any surface changes them. */
export const useLocalAccounts = (): LocalAccountsState => {
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    const [nextAccounts, nextCurrentId] = await Promise.all([
      loadLocalAccounts(),
      loadCurrentAccountId(),
    ]);
    setAccounts(nextAccounts);
    setCurrentId(nextCurrentId);
    setLoading(false);
  };

  useEffect(() => {
    void reload();

    const onChanged = () => {
      void reload();
    };

    window.addEventListener(LOCAL_ACCOUNTS_CHANGED_EVENT, onChanged);

    return () => {
      window.removeEventListener(LOCAL_ACCOUNTS_CHANGED_EVENT, onChanged);
    };
  }, []);

  return {
    accounts,
    currentId,
    current: accounts.find((account) => account.id === currentId),
    loading,
    reload,
  };
};
