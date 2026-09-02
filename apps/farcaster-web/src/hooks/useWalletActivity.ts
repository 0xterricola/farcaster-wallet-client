import { useQuery } from '@tanstack/react-query';
import { Address, Chain } from 'viem';

import { fetchWalletActivity } from '~/utils/walletActivity';

export const walletActivityKey = (address: Address, chainId: number) => [
  'walletActivity',
  chainId,
  address.toLowerCase(),
];

export function useWalletActivity(address: Address, chain: Chain) {
  return useQuery({
    queryKey: walletActivityKey(address, chain.id),
    queryFn: () => fetchWalletActivity(address, chain),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
