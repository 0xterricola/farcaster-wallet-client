import { useQuery } from '@tanstack/react-query';

import { fetchSolanaBalance } from '~/utils/solanaWallet';

const configuredRpcUrl = import.meta.env.VITE_SOLANA_RPC_URL as
  | string
  | undefined;

export function useSolanaBalance(address: string | undefined) {
  return useQuery({
    enabled: Boolean(address),
    queryFn: ({ signal }) =>
      fetchSolanaBalance(address!, {
        rpcUrl: configuredRpcUrl,
        signal,
      }),
    queryKey: ['solana-wallet-balance', address],
    refetchInterval: 30_000,
  });
}
