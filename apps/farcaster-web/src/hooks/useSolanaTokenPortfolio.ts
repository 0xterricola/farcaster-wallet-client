import { useQuery } from '@tanstack/react-query';

import { fetchSolanaTokenPortfolio } from '~/utils/solanaWallet';

const configuredRpcUrl = import.meta.env.VITE_SOLANA_RPC_URL as
  | string
  | undefined;

export const solanaTokenPortfolioKey = (address: string) =>
  ['solana-wallet', address, 'tokens'] as const;

export function useSolanaTokenPortfolio(address: string | undefined) {
  return useQuery({
    enabled: Boolean(address),
    queryFn: ({ signal }) =>
      fetchSolanaTokenPortfolio(address!, {
        rpcUrl: configuredRpcUrl,
        signal,
      }),
    queryKey: solanaTokenPortfolioKey(address ?? ''),
    refetchInterval: 60_000,
    retry: 1,
    staleTime: 30_000,
  });
}
