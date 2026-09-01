import {
  Address,
  Chain,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  PublicClient,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';

export const LIFI_API_URL = 'https://li.quest/v1';
export const LIFI_NATIVE_ADDRESS = zeroAddress;
export const CELO_NATIVE_TOKEN_ADDRESS =
  '0x471EcE3750Da237f93B8E339c536989b8978a438' as Address;
export type LifiToken = {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD?: number;
  verificationStatus?: string;
};
export type LifiAsset = LifiToken & { balance: bigint };
export const BASE_NATIVE_TOKEN: LifiToken = {
  chainId: base.id,
  address: zeroAddress,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
};

// Celo's native CELO and CeloToken ERC-20 representation share one balance.
// Treat both addresses as the same native asset so wallet surfaces do not
// display or submit the balance twice.
export function isNativeWalletAsset(address: Address, chainId: number) {
  return (
    address.toLowerCase() === zeroAddress ||
    (chainId === 42220 &&
      address.toLowerCase() === CELO_NATIVE_TOKEN_ADDRESS.toLowerCase())
  );
}

export function createLifiNativeToken(
  chain: Pick<Chain, 'id' | 'nativeCurrency'>,
): LifiToken {
  return {
    chainId: chain.id,
    address: zeroAddress,
    symbol: chain.nativeCurrency.symbol,
    name: chain.nativeCurrency.name,
    decimals: chain.nativeCurrency.decimals,
  };
}

export function normalizeLifiAddress(
  value: string,
  nativeSymbol: string = base.nativeCurrency.symbol,
): Address {
  const input = value.trim();
  if (
    input.toUpperCase() === nativeSymbol.toUpperCase() ||
    input.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ) {
    return zeroAddress;
  }
  if (!isAddress(input)) {
    throw new Error(`Enter ${nativeSymbol} or a valid token contract address.`);
  }
  return getAddress(input);
}

export const lifiWalletKey = (address: Address, chainId: number = base.id) =>
  ['lifiWallet', chainId, address.toLowerCase()] as const;
export const lifiTokenKey = (
  token: Address,
  chainId: number = base.id,
  nativeSymbol: string = base.nativeCurrency.symbol,
) =>
  [
    'lifiToken',
    chainId,
    normalizeLifiAddress(token, nativeSymbol).toLowerCase(),
  ] as const;
export const lifiBalanceKey = (
  address: Address,
  token: Address,
  chainId: number = base.id,
  nativeSymbol: string = base.nativeCurrency.symbol,
) =>
  [
    ...lifiWalletKey(address, chainId),
    'balance',
    normalizeLifiAddress(token, nativeSymbol).toLowerCase(),
  ] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid LI.FI response.');
  }
  return value as Record<string, unknown>;
}

export function parseLifiToken(
  value: unknown,
  chainId: number = base.id,
  nativeSymbol: string = base.nativeCurrency.symbol,
): LifiToken {
  const token = object(value);
  if (
    token.chainId !== chainId ||
    typeof token.address !== 'string' ||
    !isAddress(token.address) ||
    typeof token.decimals !== 'number' ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    typeof token.symbol !== 'string' ||
    !token.symbol.trim()
  ) {
    throw new Error(`Invalid token for chain ${chainId} in LI.FI response.`);
  }
  const price =
    typeof token.priceUSD === 'string' && token.priceUSD.trim() !== ''
      ? Number(token.priceUSD)
      : token.priceUSD;
  return {
    chainId,
    address: normalizeLifiAddress(token.address, nativeSymbol),
    symbol: token.symbol,
    name: typeof token.name === 'string' ? token.name : token.symbol,
    decimals: token.decimals,
    priceUSD:
      typeof price === 'number' && Number.isFinite(price) && price >= 0
        ? price
        : undefined,
    verificationStatus:
      typeof token.verificationStatus === 'string'
        ? token.verificationStatus
        : undefined,
  };
}

export async function requestLifi(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) {
    cancel();
  }
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 20_000);
  try {
    const response = await fetch(`${LIFI_API_URL}${path}`, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? 'LI.FI is rate limiting requests. Please try again shortly.'
          : `LI.FI request failed (${response.status}). Please try again.`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function fetchLifiWalletTokens(
  address: Address,
  signal?: AbortSignal,
  chainId: number = base.id,
  nativeSymbol: string = base.nativeCurrency.symbol,
) {
  const body = object(
    await requestLifi(
      `/wallets/${address.toLowerCase()}/balances?extended=true`,
      signal,
    ),
  );
  if (
    typeof body.walletAddress !== 'string' ||
    body.walletAddress.toLowerCase() !== address.toLowerCase()
  ) {
    throw new Error('LI.FI returned a different wallet.');
  }
  const balances = object(body.balances);
  const rows = balances[chainId] ?? [];
  if (!Array.isArray(rows)) {
    throw new Error(`Invalid LI.FI balances for chain ${chainId}.`);
  }
  const tokens = new Map<string, LifiToken>();
  let skipped = 0;
  for (const row of rows) {
    try {
      const token = parseLifiToken(row, chainId, nativeSymbol);
      tokens.set(token.address.toLowerCase(), token);
    } catch {
      skipped += 1;
    }
  }
  // Indexed amounts are deliberately not copied into the spendable balance
  // cache. Every screen uses the same live balance query instead.
  const total = Object.values(balances).reduce<number>(
    (count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
    0,
  );
  return {
    tokens: [...tokens.values()],
    skipped,
    possiblyLimited: typeof body.limit === 'number' && total >= body.limit,
  };
}

export async function fetchLifiToken(
  address: Address,
  signal?: AbortSignal,
  chainId: number = base.id,
  nativeSymbol: string = base.nativeCurrency.symbol,
) {
  const token = parseLifiToken(
    await requestLifi(`/token?chain=${chainId}&token=${address}`, signal),
    chainId,
    nativeSymbol,
  );
  if (
    token.address.toLowerCase() !==
    normalizeLifiAddress(address, nativeSymbol).toLowerCase()
  ) {
    throw new Error('LI.FI returned a different token.');
  }
  return token;
}

export async function readLifiAsset(
  client: PublicClient,
  wallet: Address,
  token: LifiToken,
): Promise<LifiAsset> {
  if (client.chain?.id !== token.chainId) {
    throw new Error(`RPC for chain ${token.chainId} is required.`);
  }
  if (token.address === zeroAddress) {
    return { ...token, balance: await client.getBalance({ address: wallet }) };
  }
  const [decimals, balance] = await Promise.all([
    client.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    client.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
    }),
  ]);
  if (decimals !== token.decimals) {
    throw new Error(
      'Token decimals disagree with LI.FI. Refresh token data before using this asset.',
    );
  }
  return { ...token, balance };
}

export function lifiAssetUsd(asset: LifiAsset): number | undefined {
  if (asset.priceUSD === undefined) {
    return undefined;
  }
  const value =
    Number(formatUnits(asset.balance, asset.decimals)) * asset.priceUSD;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formatLifiBalance(asset: LifiAsset): string {
  return formatUnits(asset.balance, asset.decimals);
}
