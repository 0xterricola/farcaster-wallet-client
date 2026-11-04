// @vitest-environment jsdom

/**
 * A profile page's user lookup, with a node outage told apart from a missing
 * account.
 *
 * The fetcher in `farcaster-client-hooks` now resolves null ONLY for a handled
 * 404 and rethrows everything else (ported from quilcast 0.61.1,
 * backmeupplz/quilcast 27c1253, MIT — "a node that is down no longer says
 * your account doesn't exist"). These tests pin what this hook makes of each
 * react-query outcome:
 *
 *   - pending → loading;
 *   - data → loaded;
 *   - resolved null (the fetcher's 404) → notFound, never an error page;
 *   - an error for somebody else's handle → error state with a retry;
 *   - an error for the SIGNED-IN reader's own handle → loaded from what this
 *     browser already knows (onboarding state, plus the globally cached user
 *     when it has one), so a dead node cannot tell the reader they do not
 *     exist.
 */

import { renderHook } from '@testing-library/react';
import { ApiUser } from 'farcaster-client-data';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useNonSuspenseUserByUsername: vi.fn(),
  useCachedOnboardingState: vi.fn(),
  getCachedUser: vi.fn(),
}));

vi.mock('farcaster-client-hooks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('farcaster-client-hooks')>();
  return {
    ...actual,
    useNonSuspenseUserByUsername: mocks.useNonSuspenseUserByUsername,
    useCachedOnboardingState: mocks.useCachedOnboardingState,
    useGetGloballyCachedUser: () => mocks.getCachedUser,
  };
});

import { useUserByUsernameProfile } from '~/hooks/data/useUserByUsernameProfile';

const selfUser = (overrides: Partial<ApiUser> = {}): ApiUser =>
  ({
    fid: 7237,
    username: 'alice',
    displayName: 'Alice',
    profile: { bio: { text: '', mentions: [] } },
    followerCount: 12,
    followingCount: 34,
    ...overrides,
  }) as ApiUser;

const queryResult = ({
  data,
  error,
  isPending = false,
}: {
  data?: unknown;
  error?: Error | null;
  isPending?: boolean;
} = {}) => ({
  data,
  error,
  isPending,
  refetch: vi.fn(),
});

const withQuery = (
  result: ReturnType<typeof queryResult>,
  currentUser: ApiUser | undefined,
  cachedUser?: ApiUser,
) => {
  mocks.useNonSuspenseUserByUsername.mockReturnValue(result);
  mocks.useCachedOnboardingState.mockReturnValue({
    result: { state: { user: currentUser } },
  });
  mocks.getCachedUser.mockImplementation(({ fid }: { fid: number }) =>
    cachedUser && cachedUser.fid === fid ? cachedUser : undefined,
  );
};

const outageError = new Error(
  'getUserByUsername 502 - Your node did not answer this read',
);

describe('useUserByUsernameProfile', () => {
  it('is loading while the lookup is pending', () => {
    withQuery(queryResult({ isPending: true }), undefined);

    const { result } = renderHook(() =>
      useUserByUsernameProfile({ username: 'alice' }),
    );
    expect(result.current).toEqual({ status: 'loading' });
  });

  it('is loaded when the lookup answered', () => {
    const userProfile = { user: selfUser() };
    withQuery(queryResult({ data: { result: userProfile } }), undefined);

    const { result } = renderHook(() =>
      useUserByUsernameProfile({ username: 'alice' }),
    );
    expect(result.current).toEqual({ status: 'loaded', userProfile });
  });

  it('is notFound when the lookup resolved to null — the fetcher only does that for a 404', () => {
    withQuery(queryResult({ data: null }), undefined);

    const { result } = renderHook(() =>
      useUserByUsernameProfile({ username: 'nobody' }),
    );
    expect(result.current).toEqual({ status: 'notFound' });
  });

  it('is an error state with a retry when the node is down and the handle is somebody else', () => {
    const result = queryResult({ error: outageError });
    // Signed in as alice, reading bob's profile while the node is down.
    withQuery(result, selfUser());

    const { current } = renderHook(() =>
      useUserByUsernameProfile({ username: 'bob' }),
    ).result;

    expect(current).toEqual({
      status: 'error',
      error: outageError,
      retry: expect.any(Function),
    });
    (current as { retry: () => void }).retry();
    expect(result.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the signed-in reader from what this browser knows when their own profile cannot be read', () => {
    withQuery(
      queryResult({ error: outageError }),
      selfUser(),
      selfUser({ followerCount: 99, displayName: 'Alice (cached)' }),
    );

    const { current } = renderHook(() =>
      useUserByUsernameProfile({ username: 'Alice' }),
    ).result;

    expect(current.status).toBe('loaded');
    if (current.status !== 'loaded') {
      return;
    }
    // Freshest local fact wins: the globally cached user's counts and name.
    expect(current.userProfile.user.followerCount).toBe(99);
    expect(current.userProfile.user.displayName).toBe('Alice (cached)');
    expect(current.userProfile.user.username).toBe('alice');
    expect(current.userProfile.user.fid).toBe(7237);
  });

  it('falls back to the onboarding-state user alone when the global cache has nothing for the fid', () => {
    withQuery(queryResult({ error: outageError }), selfUser(), undefined);

    const { current } = renderHook(() =>
      useUserByUsernameProfile({ username: 'alice' }),
    ).result;

    expect(current.status).toBe('loaded');
    if (current.status !== 'loaded') {
      return;
    }
    expect(current.userProfile.user.displayName).toBe('Alice');
    expect(current.userProfile.user.followerCount).toBe(12);
  });

  it('is an error, never a self fallback, when the down handle belongs to somebody else', () => {
    withQuery(queryResult({ error: outageError }), selfUser());

    const { current } = renderHook(() =>
      useUserByUsernameProfile({ username: 'bob' }),
    ).result;

    expect(current.status).toBe('error');
  });
});
