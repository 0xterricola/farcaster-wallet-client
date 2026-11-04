import { FarcasterApiClient, isFarcasterApiError } from 'farcaster-client-data';

import { MergeIntoGloballyCachedUser } from '../../../../types';

const buildUserByUsernameFetcher =
  ({
    apiClient,
    username,
    mergeIntoGloballyCachedUser,
  }: {
    apiClient: FarcasterApiClient;
    username: string;
    mergeIntoGloballyCachedUser: MergeIntoGloballyCachedUser;
  }) =>
  async () => {
    try {
      const response = await apiClient.getUserByUsername({
        // API endpoint is case-sensitive and won't accept
        // uppercased usernames as they are technically invalid
        // at the protocol layer.
        username: username.toLowerCase(),
      });
      mergeIntoGloballyCachedUser({ updates: response.data.result.user });
      return response.data;
    } catch (error) {
      // Only a handled 404 means "no account goes by that name" — the
      // node really answered and said there is nobody there. Everything
      // else (5xx, a timed-out read, an unreachable node, an offline
      // browser) is rethrown: a query that swallows it would flatten a
      // dead node into a missing account, and every profile page would
      // tell the reader — including about themselves — that they do not
      // exist. Rethrowing is what lets react-query retry and rotate the
      // provider chain instead.
      if (isFarcasterApiError(error) && error.status === 404) {
        return null;
      }
      throw error;
    }
  };

export { buildUserByUsernameFetcher };
