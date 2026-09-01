import {
  QueryClient,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { Address, Chain, PublicClient, zeroAddress } from 'viem';
import { base } from 'viem/chains';
import { usePublicClient } from 'wagmi';

import { createBaseTransferReader } from '~/utils/baseWalletTransfer';
import {
  createLifiNativeToken,
  fetchLifiToken,
  fetchLifiWalletTokens,
  LifiAsset,
  lifiBalanceKey,
  lifiTokenKey,
  lifiWalletKey,
  normalizeLifiAddress,
  readLifiAsset,
} from '~/utils/lifiWallet';

// The host persists React Query to localStorage using JSON. Cache exact unit
// strings, and expose bigint to consumers without breaking that persistence.
type CachedLifiAsset = Omit<LifiAsset, 'balance'> & { balance: string };
const selectAsset = (asset: CachedLifiAsset): LifiAsset => ({
  ...asset,
  balance: BigInt(asset.balance),
});

function assetOptions(
  queryClient: QueryClient,
  client: PublicClient | undefined,
  address: Address,
  token: Address,
  chain: Chain,
) {
  const nativeSymbol = chain.nativeCurrency.symbol;
  const canonicalToken = normalizeLifiAddress(token, nativeSymbol);
  return {
    queryKey: lifiBalanceKey(address, canonicalToken, chain.id, nativeSymbol),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!client) {
        throw new Error(`${chain.name} connection is not ready.`);
      }
      const metadata =
        canonicalToken === zeroAddress
          ? createLifiNativeToken(chain)
          : await queryClient.fetchQuery({
              queryKey: lifiTokenKey(canonicalToken, chain.id, nativeSymbol),
              queryFn: ({ signal: tokenSignal }) =>
                fetchLifiToken(
                  canonicalToken,
                  tokenSignal,
                  chain.id,
                  nativeSymbol,
                ),
              staleTime: 60_000,
            });
      if (signal.aborted) {
        throw new Error('Balance request cancelled.');
      }
      const asset = await readLifiAsset(client, address, metadata);
      if (signal.aborted) {
        throw new Error('Balance request cancelled.');
      }
      return { ...asset, balance: asset.balance.toString() };
    },
    staleTime: 15_000,
    placeholderData: undefined,
    select: selectAsset,
    retry: 1,
    refetchInterval: 30_000,
  };
}

export function useLifiWalletTokens(address?: Address, chain: Chain = base) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [...lifiWalletKey(address ?? zeroAddress, chain.id), 'tokens'],
    enabled: Boolean(address),
    queryFn: async ({ signal }) => {
      if (!address) {
        throw new Error('Connect a wallet first.');
      }
      const result = await fetchLifiWalletTokens(
        address,
        signal,
        chain.id,
        chain.nativeCurrency.symbol,
      );
      if (signal.aborted) {
        throw new Error('Token request cancelled.');
      }
      for (const token of result.tokens) {
        queryClient.setQueryData(
          lifiTokenKey(token.address, chain.id, chain.nativeCurrency.symbol),
          token,
        );
      }
      return result;
    },
    staleTime: 30_000,
    placeholderData: undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useLifiAsset(
  address?: Address,
  token?: Address,
  chain: Chain = base,
) {
  const client = usePublicClient({ chainId: chain.id });
  const queryClient = useQueryClient();
  return useQuery({
    ...assetOptions(
      queryClient,
      client,
      address ?? zeroAddress,
      token ?? zeroAddress,
      chain,
    ),
    enabled: Boolean(address && token && client),
  });
}

export async function fetchFreshLifiAsset(
  queryClient: QueryClient,
  client: PublicClient,
  address: Address,
  token: Address,
  chain: Chain = base,
) {
  const options = assetOptions(queryClient, client, address, token, chain);
  // Do not reuse a background read that started before this preflight check.
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  return selectAsset(
    await queryClient.fetchQuery({ ...options, staleTime: 0 }),
  );
}

export function useLifiAssets(
  address: Address,
  tokens: Address[],
  chain: Chain = base,
) {
  const client = usePublicClient({ chainId: chain.id });
  const queryClient = useQueryClient();
  return useQueries({
    queries: tokens.map((token) => ({
      ...assetOptions(queryClient, client, address, token, chain),
      enabled: Boolean(client),
    })),
  });
}

export function useLifiTransferReader() {
  const client = usePublicClient({ chainId: base.id });
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      client
        ? {
            ...createBaseTransferReader(client),
            nativeBalance: async (wallet: Address) =>
              (
                await fetchFreshLifiAsset(
                  queryClient,
                  client,
                  wallet,
                  zeroAddress,
                  base,
                )
              ).balance,
            tokenDetails: (token: Address, wallet: Address) =>
              fetchFreshLifiAsset(queryClient, client, wallet, token, base),
          }
        : undefined,
    [client, queryClient],
  );
}

export function refreshLifiWallet(
  queryClient: QueryClient,
  address: Address,
  chainId: number = base.id,
) {
  return queryClient.invalidateQueries({
    queryKey: lifiWalletKey(address, chainId),
  });
}
