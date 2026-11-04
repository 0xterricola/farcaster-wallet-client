import {
  FarcasterApiClient,
  HandledFetchError,
  UnhandledFetchError,
} from 'farcaster-client-data';
import { describe, expect, it, vi } from 'vitest';

import { buildUserByUsernameFetcher } from '../buildUserByUsernameFetcher';

// Ported from quilcast's src/api.test.ts (backmeupplz/quilcast 27c1253, MIT):
// "a node that is down is not a user who is missing". Upstream asserts that a
// 502 rejects with the status riding along and only a 404 resolves to "no
// such user". Here the seam is the fetcher: same two facts, plus a plain
// network failure, which must also refuse to become null.

const fakeApiClient = (
  getUserByUsername: FarcasterApiClient['getUserByUsername'],
) => ({ getUserByUsername }) as unknown as FarcasterApiClient;

const handledError = (status: number, message: string) =>
  new HandledFetchError(`getUserByUsername ${status} - ${message}`, {
    absoluteUrl: 'https://example.com/v2/user-by-username?username=alice',
    body: undefined,
    endpointName: 'getUserByUsername',
    hasTimedOut: false,
    isNetworkError: false,
    method: 'GET',
    relativeUrl: '/v2/user-by-username',
    resolvedTimeout: 10_000,
    response: undefined,
    responseData: { errors: [{ message }] },
    status,
    timeout: undefined,
    error: undefined,
    isHandled: true,
    isOffline: false,
  });

const unhandledError = () =>
  new UnhandledFetchError('getUserByUsername - request failed', {
    absoluteUrl: 'https://example.com/v2/user-by-username?username=alice',
    body: undefined,
    endpointName: 'getUserByUsername',
    hasTimedOut: false,
    isNetworkError: true,
    method: 'GET',
    relativeUrl: '/v2/user-by-username',
    resolvedTimeout: 10_000,
    response: undefined,
    responseData: undefined,
    status: undefined,
    timeout: undefined,
    error: new TypeError('fetch failed'),
    isHandled: false,
    isOffline: false,
  });

const fetcherFor = (error: unknown) =>
  buildUserByUsernameFetcher({
    apiClient: fakeApiClient(
      vi
        .fn()
        .mockRejectedValue(
          error,
        ) as unknown as FarcasterApiClient['getUserByUsername'],
    ),
    username: 'alice',
    mergeIntoGloballyCachedUser: vi.fn(),
  });

describe('buildUserByUsernameFetcher error handling', () => {
  it('resolves to null on a handled 404 — no one goes by that name', async () => {
    await expect(
      fetcherFor(handledError(404, 'User not found'))(),
    ).resolves.toBeNull();
  });

  it('rethrows a 502 with the status riding along, instead of answering null', async () => {
    const error = handledError(502, 'error code: 502');
    await expect(fetcherFor(error)()).rejects.toBe(error);
    expect(error.status).toBe(502);
  });

  it('rethrows an unhandled network failure — a dead node is not a missing account', async () => {
    const error = unhandledError();
    await expect(fetcherFor(error)()).rejects.toBe(error);
  });

  it('rethrows a plain error thrown before any response existed', async () => {
    const error = new TypeError('fetch failed');
    await expect(fetcherFor(error)()).rejects.toBe(error);
  });

  it('still returns the response and merges the user into the global cache on success', async () => {
    const user = { fid: 1, username: 'alice', displayName: 'Alice' };
    const mergeIntoGloballyCachedUser = vi.fn();
    const data = { result: { user } };
    const fetcher = buildUserByUsernameFetcher({
      apiClient: fakeApiClient(
        vi.fn().mockResolvedValue({
          data,
        }) as unknown as FarcasterApiClient['getUserByUsername'],
      ),
      username: 'Alice',
      mergeIntoGloballyCachedUser,
    });

    await expect(fetcher()).resolves.toBe(data);
    expect(mergeIntoGloballyCachedUser).toHaveBeenCalledWith({ updates: user });
  });
});
