/**
 * The Fiddy balance, read the way this client reads anything: as data.
 *
 * Two queries and one derived state.
 *
 *   `useFundingConfig`   the public config — where a top-up goes, what it is
 *                        paid in, and the amounts the server offers. Cached for
 *                        the same minute the server's own header advertises.
 *   `useFundingBalance`  this account's credit, plus its last ten movements.
 *                        Private, never cached across accounts.
 *   `useFundingSession`  the one thing both surfaces need to know before they
 *                        offer a send: can this browser add to a balance at
 *                        all? The server is the only thing that can answer —
 *                        the balance route refuses a session it cannot place
 *                        (`AUTH_REQUIRED`, `PRODUCTION_AUTH_REQUIRED`,
 *                        `ORIGIN_NOT_ALLOWED`) — so the answer comes from that
 *                        read and not from a guess about who is signed in.
 *
 * WHY THE SESSION GATE MATTERS FOR MONEY. A top-up is a real USDC transfer to
 * Fiddy's treasury. If the service will not credit this session, offering the
 * send would move somebody's money to an address whose credit cannot land —
 * so the screen does not offer it, and says why instead. The config query is
 * public and stays available either way, which is what makes the sentence
 * "adding funds is not switched on here yet" possible before anyone signs in.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchFundingBalance,
  fetchFundingConfig,
  type FundingBalance,
  type FundingConfig,
  fundingFailureCode,
  fundingFailureOwnerLine,
  type FundingSession,
  isFundingError,
} from '~/lib/fiddyCredit';

export const fundingConfigQueryKey = ['fiddy', 'funding', 'config'] as const;
export const fundingBalanceQueryKey = ['fiddy', 'funding', 'balance'] as const;

/** One minute, which is the lifetime the config route itself advertises. */
const CONFIG_STALE_MS = 60_000;
/** The chip is a number somebody watches, so it is allowed to be a little old. */
const BALANCE_STALE_MS = 15_000;

export const useFundingConfig = (): UseQueryResult<FundingConfig, unknown> =>
  useQuery({
    queryKey: fundingConfigQueryKey,
    queryFn: async ({ signal }) => await fetchFundingConfig(signal),
    staleTime: CONFIG_STALE_MS,
    gcTime: CONFIG_STALE_MS * 5,
    retry: 1,
  });

export const useFundingBalance = (
  enabled = true,
): UseQueryResult<FundingBalance, unknown> =>
  useQuery({
    queryKey: fundingBalanceQueryKey,
    queryFn: async ({ signal }) => await fetchFundingBalance(signal),
    enabled,
    staleTime: BALANCE_STALE_MS,
    retry: 1,
  });

export interface FundingSessionState {
  session: FundingSession;
  /** What to say when the send cannot be offered. Null once it can. */
  line: string | null;
  /** The server's code, kept for the owner to quote. Null once ready. */
  code: string | null;
}

export const useFundingSession = ({
  enabled = true,
}: { enabled?: boolean } = {}): FundingSessionState => {
  const balance = useFundingBalance(enabled);

  if (balance.isPending) {
    return { session: 'loading', line: null, code: null };
  }

  if (balance.isSuccess) {
    return { session: 'ready', line: null, code: null };
  }

  const code =
    balance.error === null ? null : fundingFailureCode(balance.error);
  const refused =
    code === 'AUTH_REQUIRED' ||
    code === 'PRODUCTION_AUTH_REQUIRED' ||
    code === 'ORIGIN_NOT_ALLOWED';

  if (refused) {
    return {
      session: 'refused',
      line: balance.error === null ? null : fundingErrorLine(balance.error),
      code,
    };
  }

  return {
    session: 'unavailable',
    line:
      balance.error === null ? null : fundingFailureOwnerLine(balance.error),
    code,
  };
};

const fundingErrorLine = (error: unknown): string | null =>
  isFundingError(error) ? error.ownerLine : fundingFailureOwnerLine(error);
