import { hyperevm } from 'farcaster-client-data';
import { Provider } from 'ox';
import { Chain, toHex } from 'viem';
import { arbitrum, base, bsc, celo, mainnet, monad } from 'viem/chains';

export const DEFAULT_WALLET_CHAIN_ID = base.id;

export type WalletChainCapabilities = {
  read: boolean;
  send: boolean;
  swap: boolean;
};

const WALLET_CHAIN_CAPABILITIES: ReadonlyMap<number, WalletChainCapabilities> =
  new Map([
    [base.id, { read: true, send: true, swap: true }],
    [mainnet.id, { read: true, send: true, swap: true }],
    [arbitrum.id, { read: true, send: true, swap: true }],
    [bsc.id, { read: true, send: true, swap: true }],
    [celo.id, { read: true, send: true, swap: true }],
    [monad.id, { read: true, send: true, swap: true }],
    [hyperevm.id, { read: true, send: false, swap: false }],
  ]);

export function walletChainCapabilities(chainId: number) {
  return (
    WALLET_CHAIN_CAPABILITIES.get(chainId) ?? {
      read: false,
      send: false,
      swap: false,
    }
  );
}

// A chain is dashboard-enabled once its read-only balance and receive surfaces
// are safe. Transaction capabilities are enabled separately above.
export const DASHBOARD_CHAINS: ReadonlyMap<number, Chain> = new Map<
  number,
  Chain
>([
  [base.id, base],
  [mainnet.id, mainnet],
  [arbitrum.id, arbitrum],
  [bsc.id, bsc],
  [celo.id, celo],
  [monad.id, monad],
  [hyperevm.id, hyperevm],
]);

// Networks that the shared provider can intentionally follow. A network is
// added to DASHBOARD_CHAINS only after its read-only wallet screen ships.
export const SELECTABLE_WALLET_CHAINS: ReadonlyMap<number, Chain> = new Map<
  number,
  Chain
>([
  [base.id, base],
  [mainnet.id, mainnet],
  [arbitrum.id, arbitrum],
  [bsc.id, bsc],
  [celo.id, celo],
  [monad.id, monad],
  [hyperevm.id, hyperevm],
]);

const KNOWN_WALLET_NETWORK_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'Ethereum'],
  [56, 'BNB Smart Chain'],
  [143, 'Monad'],
  [8453, 'Base'],
  [999, 'HyperEVM'],
  [4663, 'Robinhood Chain'],
  [42161, 'Arbitrum One'],
  [42220, 'Celo'],
]);

export function walletNetworkName(chainId?: number) {
  if (!chainId) {
    return 'Unknown network';
  }
  return KNOWN_WALLET_NETWORK_NAMES.get(chainId) ?? `Chain ${chainId}`;
}

export type WalletNetworkErrorKind =
  | 'rejected'
  | 'network_not_added'
  | 'method_unsupported'
  | 'switch_failed';

export type WalletNetworkError = {
  kind: WalletNetworkErrorKind;
  requestedChainId: number;
  message: string;
};

export function parseWalletChainId(value: unknown): number | undefined {
  let chainId: number;
  if (typeof value === 'number') {
    chainId = value;
  } else if (typeof value === 'bigint') {
    chainId = Number(value);
  } else if (typeof value === 'string' && /^(?:0x[\da-f]+|\d+)$/i.test(value)) {
    chainId = Number(value);
  } else {
    return undefined;
  }
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : undefined;
}

function errorValues(error: unknown) {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const item = current as {
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    values.push(item.code, item.message, item.shortMessage, item.details);
    current = item.cause;
  }
  return values;
}

export function classifyWalletNetworkError(
  error: unknown,
  requestedChainId: number,
): WalletNetworkError {
  const values = errorValues(error);
  const codes = values.filter(
    (value): value is number => typeof value === 'number',
  );
  const text = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  if (codes.includes(4001) || /user rejected|user denied/i.test(text)) {
    return {
      kind: 'rejected',
      requestedChainId,
      message: 'Network change was cancelled in the wallet.',
    };
  }
  if (
    codes.includes(4902) ||
    /unrecognized chain|unknown chain|not added/i.test(text)
  ) {
    return {
      kind: 'network_not_added',
      requestedChainId,
      message: 'This network is not currently added to the wallet.',
    };
  }
  if (
    codes.includes(-32601) ||
    /method not found|unsupported method|does not support/i.test(text)
  ) {
    return {
      kind: 'method_unsupported',
      requestedChainId,
      message: 'The connected wallet does not support this network request.',
    };
  }
  return {
    kind: 'switch_failed',
    requestedChainId,
    message: 'The wallet could not switch networks.',
  };
}

export function addEthereumChainParameters(chain: Chain) {
  return {
    chainId: toHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers?.default.url
      ? [chain.blockExplorers.default.url]
      : [],
  };
}

export async function readWalletChainId(
  provider: Pick<Provider.Provider, 'request'>,
) {
  const value = await provider.request({ method: 'eth_chainId' });
  const chainId = parseWalletChainId(value);
  if (!chainId) {
    throw new Error('Wallet returned an invalid chain ID.');
  }
  return chainId;
}
