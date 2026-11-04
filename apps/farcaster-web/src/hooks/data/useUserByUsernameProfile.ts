import { ApiUser, ApiUserProfile } from 'farcaster-client-data';
import {
  useCachedOnboardingState,
  useGetGloballyCachedUser,
  useNonSuspenseUserByUsername,
} from 'farcaster-client-hooks';
import merge from 'lodash/merge';
import { useMemo } from 'react';

/**
 * A profile page's user lookup, with a node outage told apart from a missing
 * account.
 *
 * WHY THIS EXISTS
 * The username fetcher used to flatten every failure into null, so a profile
 * page rendered "@username not found on Farcaster" — including for the
 * signed-in reader's own profile — whenever the node or its provider chain
 * was down. The fetcher now rethrows everything except a handled 404
 * (quilcast 0.61.1, backmeupplz/quilcast 27c1253, MIT), and this hook turns
 * the react-query outcome into one of four page states:
 *
 *   - loading  — the lookup has not settled yet;
 *   - loaded   — a real answer, or (see below) the locally-known self;
 *   - notFound — a 404: the node answered, nobody goes by that name;
 *   - error    — the node did not answer: honest copy plus a retry, never
 *                "not found".
 *
 * THE SELF FALLBACK
 * When the lookup fails non-404 and the handle belongs to the signed-in
 * reader, the page still renders: this browser already knows who they are,
 * from the same cached sources the shell itself renders identity from — the
 * onboarding state (which never fetches) and the globally cached user for
 * their fid. Both carry real data from the last successful read, so the
 * counts and profile shown are facts this browser holds, not guesses; a
 * field neither source knows is simply absent, never invented.
 */
export type UserProfileByUsername =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; error: Error; retry: () => void }
  | { status: 'loaded'; userProfile: ApiUserProfile };

const useUserByUsernameProfile = ({
  username,
}: {
  username: string;
}): UserProfileByUsername => {
  // `throwOnError` is off on purpose: the page owns the outcome, so an
  // outage renders as this hook's error state instead of unwinding into the
  // shell's error boundary (which would still be honest, just blunter).
  const { data, error, isPending, refetch } = useNonSuspenseUserByUsername({
    username,
  });

  // Who this browser is signed in as, with no fetch: the same cached
  // onboarding state the shell renders the account from. This has to answer
  // synchronously, including while the network is the thing that is broken.
  const currentUser = useCachedOnboardingState().result.state.user;

  // The same synchronous read the profile header's cache merge uses, so the
  // fallback and the header agree about what this browser knows.
  const getCachedUser = useGetGloballyCachedUser();

  const isSelf = useMemo(
    () =>
      !!currentUser?.username &&
      currentUser.username.toLowerCase() === username.toLowerCase(),
    [currentUser?.username, username],
  );

  return useMemo<UserProfileByUsername>(() => {
    if (data) {
      return { status: 'loaded', userProfile: data.result };
    }

    // A resolved null is the fetcher's one swallowed case: a handled 404.
    if (!error) {
      return isPending ? { status: 'loading' } : { status: 'notFound' };
    }

    // The node is down (or the route to it is), not the account. If the
    // handle is the signed-in reader's own, render who this browser already
    // knows them to be — the locally-known user, freshest wins.
    if (isSelf && currentUser) {
      const cachedSelf = getCachedUser({ fid: currentUser.fid });
      const fallbackUser = cachedSelf
        ? (merge({}, currentUser, cachedSelf) as ApiUser)
        : currentUser;
      return {
        status: 'loaded',
        userProfile: {
          user: fallbackUser,
          collectionsOwned: [],
          extras: {
            fid: fallbackUser.fid,
            custodyAddress: '',
          },
        },
      };
    }

    return {
      status: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
      retry: () => {
        void refetch();
      },
    };
  }, [data, error, isPending, isSelf, currentUser, getCachedUser, refetch]);
};

export { useUserByUsernameProfile };
