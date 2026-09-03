import { useQuery } from '@tanstack/react-query';

import { fetchSolanaActivity } from '~/utils/solanaActivity';

const configuredRpcUrl = import.meta.env.VITE_SOLANA_RPC_URL as
  | string
  | undefined;

export const solanaActivityKey = (address: string) =>
  ['solana-wallet', address, 'activity'] as const;

export function useSolanaActivity(address: string | undefined) {
  return useQuery({
    enabled: Boolean(address),
    queryFn: ({ signal }) =>
      fetchSolanaActivity(address!, { rpcUrl: configuredRpcUrl, signal }),
    queryKey: solanaActivityKey(address ?? ''),
    refetchInterval: 60_000,
    retry: 1,
    staleTime: 30_000,
  });
}
