import { Address, Chain, formatUnits, getAddress, Hash, isAddress } from 'viem';

const STORAGE_KEY = 'farcaster.walletActivity.v1';
const MAX_LOCAL_RECORDS = 100;
const LOCAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type WalletActivityStatus = 'pending' | 'confirmed' | 'failed';
export type WalletActivityType =
  | 'send'
  | 'receive'
  | 'swap'
  | 'approval'
  | 'contract';

export type WalletActivityAsset = {
  symbol: string;
  value: string;
  decimals: number;
  address?: Address;
};

export type WalletActivity = {
  chainId: number;
  address: Address;
  hash: Hash;
  type: WalletActivityType;
  status: WalletActivityStatus;
  timestamp: number;
  fromAsset?: WalletActivityAsset;
  toAsset?: WalletActivityAsset;
  local?: boolean;
};

type EtherscanTransaction = {
  hash?: unknown;
  timeStamp?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  isError?: unknown;
  txreceipt_status?: unknown;
  methodId?: unknown;
  functionName?: unknown;
};

type EtherscanTokenTransfer = EtherscanTransaction & {
  contractAddress?: unknown;
  tokenSymbol?: unknown;
  tokenDecimal?: unknown;
};

type BlockscoutTransaction = {
  hash?: unknown;
  timestamp?: unknown;
  from?: { hash?: unknown } | unknown;
  to?: { hash?: unknown } | unknown;
  value?: unknown;
  status?: unknown;
  method?: unknown;
};

type BlockscoutTokenTransfer = {
  transaction_hash?: unknown;
  timestamp?: unknown;
  from?: { hash?: unknown } | unknown;
  to?: { hash?: unknown } | unknown;
  total?: { value?: unknown; decimals?: unknown } | unknown;
  token?: { symbol?: unknown; decimals?: unknown; address_hash?: unknown };
};

export type WalletActivityResponse =
  | {
      source: 'etherscan';
      normalTransactions: EtherscanTransaction[];
      tokenTransfers: EtherscanTokenTransfer[];
    }
  | {
      source: 'blockscout';
      normalTransactions: BlockscoutTransaction[];
      tokenTransfers: BlockscoutTokenTransfer[];
    };

type ActivityGroup = {
  hash: Hash;
  timestamp: number;
  status: WalletActivityStatus;
  from?: string;
  to?: string;
  nativeValue?: string;
  method?: string;
  outgoing: WalletActivityAsset[];
  incoming: WalletActivityAsset[];
};

function hash(value: unknown): Hash | undefined {
  return typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)
    ? (value as Hash)
    : undefined;
}

function address(value: unknown): Address | undefined {
  const candidate =
    typeof value === 'object' && value
      ? (value as { hash?: unknown }).hash
      : value;
  return typeof candidate === 'string' && isAddress(candidate)
    ? getAddress(candidate)
    : undefined;
}

function units(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}

function decimals(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255
    ? parsed
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value) * 1000
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function groupFor(
  groups: Map<Hash, ActivityGroup>,
  transactionHash: Hash,
  transactionTimestamp: number,
) {
  const existing = groups.get(transactionHash);
  if (existing) {
    existing.timestamp = Math.max(existing.timestamp, transactionTimestamp);
    return existing;
  }
  const group: ActivityGroup = {
    hash: transactionHash,
    timestamp: transactionTimestamp,
    status: 'confirmed',
    outgoing: [],
    incoming: [],
  };
  groups.set(transactionHash, group);
  return group;
}

function activityFromGroups(
  groups: Map<Hash, ActivityGroup>,
  wallet: Address,
  chain: Pick<Chain, 'id' | 'nativeCurrency'>,
) {
  const normalizedWallet = wallet.toLowerCase();
  return [...groups.values()]
    .map((group): WalletActivity => {
      const nativeAsset =
        group.nativeValue && group.nativeValue !== '0'
          ? {
              symbol: chain.nativeCurrency.symbol,
              value: group.nativeValue,
              decimals: chain.nativeCurrency.decimals,
            }
          : undefined;
      const walletSent = group.from?.toLowerCase() === normalizedWallet;
      const walletReceived = group.to?.toLowerCase() === normalizedWallet;
      const outgoing = [...group.outgoing];
      const incoming = [...group.incoming];
      if (nativeAsset && walletSent) {
        outgoing.unshift(nativeAsset);
      }
      if (nativeAsset && walletReceived) {
        incoming.unshift(nativeAsset);
      }
      if (outgoing.length && incoming.length) {
        return {
          chainId: chain.id,
          address: wallet,
          hash: group.hash,
          type: 'swap',
          status: group.status,
          timestamp: group.timestamp,
          fromAsset: outgoing[0],
          toAsset: incoming[0],
        };
      }
      if (outgoing.length) {
        return {
          chainId: chain.id,
          address: wallet,
          hash: group.hash,
          type: 'send',
          status: group.status,
          timestamp: group.timestamp,
          fromAsset: outgoing[0],
        };
      }
      if (incoming.length) {
        return {
          chainId: chain.id,
          address: wallet,
          hash: group.hash,
          type: 'receive',
          status: group.status,
          timestamp: group.timestamp,
          toAsset: incoming[0],
        };
      }
      const approval =
        group.method?.toLowerCase().includes('approve') ||
        group.method?.toLowerCase() === '0x095ea7b3';
      return {
        chainId: chain.id,
        address: wallet,
        hash: group.hash,
        type: approval ? 'approval' : 'contract',
        status: group.status,
        timestamp: group.timestamp,
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function parseWalletActivity(
  payload: WalletActivityResponse,
  wallet: Address,
  chain: Pick<Chain, 'id' | 'nativeCurrency'>,
) {
  const groups = new Map<Hash, ActivityGroup>();
  if (payload.source === 'etherscan') {
    for (const transaction of payload.normalTransactions) {
      const transactionHash = hash(transaction.hash);
      const transactionTimestamp = timestamp(transaction.timeStamp);
      if (!transactionHash || !transactionTimestamp) {
        continue;
      }
      const group = groupFor(groups, transactionHash, transactionTimestamp);
      group.from = address(transaction.from);
      group.to = address(transaction.to);
      group.nativeValue = units(transaction.value);
      group.method =
        typeof transaction.functionName === 'string'
          ? transaction.functionName
          : typeof transaction.methodId === 'string'
            ? transaction.methodId
            : undefined;
      if (transaction.isError === '1' || transaction.txreceipt_status === '0') {
        group.status = 'failed';
      }
    }
    for (const transfer of payload.tokenTransfers) {
      const transactionHash = hash(transfer.hash);
      const transactionTimestamp = timestamp(transfer.timeStamp);
      const value = units(transfer.value);
      const tokenDecimals = decimals(transfer.tokenDecimal);
      const symbol =
        typeof transfer.tokenSymbol === 'string'
          ? transfer.tokenSymbol.trim()
          : '';
      if (
        !transactionHash ||
        !transactionTimestamp ||
        !value ||
        tokenDecimals === undefined ||
        !symbol
      ) {
        continue;
      }
      const group = groupFor(groups, transactionHash, transactionTimestamp);
      const asset: WalletActivityAsset = {
        symbol,
        value,
        decimals: tokenDecimals,
        ...(address(transfer.contractAddress)
          ? { address: address(transfer.contractAddress) }
          : {}),
      };
      if (address(transfer.from)?.toLowerCase() === wallet.toLowerCase()) {
        group.outgoing.push(asset);
      }
      if (address(transfer.to)?.toLowerCase() === wallet.toLowerCase()) {
        group.incoming.push(asset);
      }
    }
  } else {
    for (const transaction of payload.normalTransactions) {
      const transactionHash = hash(transaction.hash);
      const transactionTimestamp = timestamp(transaction.timestamp);
      if (!transactionHash || !transactionTimestamp) {
        continue;
      }
      const group = groupFor(groups, transactionHash, transactionTimestamp);
      group.from = address(transaction.from);
      group.to = address(transaction.to);
      group.nativeValue = units(transaction.value);
      group.method =
        typeof transaction.method === 'string' ? transaction.method : undefined;
      if (transaction.status === 'error') {
        group.status = 'failed';
      }
    }
    for (const transfer of payload.tokenTransfers) {
      const transactionHash = hash(transfer.transaction_hash);
      const transactionTimestamp = timestamp(transfer.timestamp);
      const total =
        typeof transfer.total === 'object' && transfer.total
          ? (transfer.total as { value?: unknown; decimals?: unknown })
          : undefined;
      const value = units(total?.value);
      const tokenDecimals = decimals(
        total?.decimals ?? transfer.token?.decimals,
      );
      const symbol =
        typeof transfer.token?.symbol === 'string'
          ? transfer.token.symbol.trim()
          : '';
      if (
        !transactionHash ||
        !transactionTimestamp ||
        !value ||
        tokenDecimals === undefined ||
        !symbol
      ) {
        continue;
      }
      const group = groupFor(groups, transactionHash, transactionTimestamp);
      const asset: WalletActivityAsset = {
        symbol,
        value,
        decimals: tokenDecimals,
        ...(address(transfer.token?.address_hash)
          ? { address: address(transfer.token?.address_hash) }
          : {}),
      };
      if (address(transfer.from)?.toLowerCase() === wallet.toLowerCase()) {
        group.outgoing.push(asset);
      }
      if (address(transfer.to)?.toLowerCase() === wallet.toLowerCase()) {
        group.incoming.push(asset);
      }
    }
  }
  return activityFromGroups(groups, wallet, chain);
}

function validActivity(value: unknown): value is WalletActivity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<WalletActivity>;
  return (
    Number.isSafeInteger(item.chainId) &&
    typeof item.address === 'string' &&
    isAddress(item.address) &&
    typeof item.hash === 'string' &&
    Boolean(hash(item.hash)) &&
    ['send', 'receive', 'swap', 'approval', 'contract'].includes(
      item.type ?? '',
    ) &&
    ['pending', 'confirmed', 'failed'].includes(item.status ?? '') &&
    typeof item.timestamp === 'number' &&
    Number.isFinite(item.timestamp)
  );
}

function storageOrUndefined(storage?: Storage) {
  return (
    storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
  );
}

export function readLocalWalletActivity(
  wallet: Address,
  chainId: number,
  storage?: Storage,
) {
  const selectedStorage = storageOrUndefined(storage);
  if (!selectedStorage) {
    return [];
  }
  try {
    const parsed = JSON.parse(selectedStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    const cutoff = Date.now() - LOCAL_RETENTION_MS;
    return parsed
      .filter(validActivity)
      .filter(
        (item) =>
          item.chainId === chainId &&
          item.address.toLowerCase() === wallet.toLowerCase() &&
          item.timestamp >= cutoff,
      )
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

function writeLocalWalletActivity(items: WalletActivity[], storage?: Storage) {
  const selectedStorage = storageOrUndefined(storage);
  if (!selectedStorage) {
    return;
  }
  try {
    selectedStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        items
          .filter(validActivity)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, MAX_LOCAL_RECORDS),
      ),
    );
  } catch {
    // Activity is a convenience surface. Storage failure must never affect a
    // transaction that may already have been broadcast by the wallet.
  }
}

export function recordPendingWalletActivity(
  activity: Omit<WalletActivity, 'status' | 'timestamp' | 'local'>,
  storage?: Storage,
) {
  const selectedStorage = storageOrUndefined(storage);
  if (!selectedStorage) {
    return;
  }
  let all: WalletActivity[] = [];
  try {
    const parsed = JSON.parse(selectedStorage.getItem(STORAGE_KEY) ?? '[]');
    all = Array.isArray(parsed) ? parsed.filter(validActivity) : [];
  } catch {
    all = [];
  }
  const next: WalletActivity = {
    ...activity,
    status: 'pending',
    timestamp: Date.now(),
    local: true,
  };
  writeLocalWalletActivity(
    [
      next,
      ...all.filter(
        (item) =>
          item.chainId !== next.chainId ||
          item.hash.toLowerCase() !== next.hash.toLowerCase(),
      ),
    ],
    selectedStorage,
  );
}

export function settleLocalWalletActivity(
  wallet: Address,
  chainId: number,
  submittedHash: Hash,
  status: Exclude<WalletActivityStatus, 'pending'>,
  finalHash: Hash = submittedHash,
  storage?: Storage,
) {
  const selectedStorage = storageOrUndefined(storage);
  if (!selectedStorage) {
    return;
  }
  let all: WalletActivity[] = [];
  try {
    const parsed = JSON.parse(selectedStorage.getItem(STORAGE_KEY) ?? '[]');
    all = Array.isArray(parsed) ? parsed.filter(validActivity) : [];
  } catch {
    return;
  }
  writeLocalWalletActivity(
    all.map((item) =>
      item.chainId === chainId &&
      item.address.toLowerCase() === wallet.toLowerCase() &&
      item.hash.toLowerCase() === submittedHash.toLowerCase()
        ? { ...item, hash: finalHash, status }
        : item,
    ),
    selectedStorage,
  );
}

export function mergeWalletActivity(
  indexed: WalletActivity[],
  local: WalletActivity[],
  limit = 5,
) {
  const merged = new Map<string, WalletActivity>();
  for (const item of local) {
    merged.set(`${item.chainId}:${item.hash.toLowerCase()}`, item);
  }
  for (const item of indexed) {
    merged.set(`${item.chainId}:${item.hash.toLowerCase()}`, item);
  }
  return [...merged.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export function formatWalletActivityAsset(asset?: WalletActivityAsset) {
  if (!asset) {
    return undefined;
  }
  try {
    return `${formatUnits(BigInt(asset.value), asset.decimals)} ${asset.symbol}`;
  } catch {
    return undefined;
  }
}

export async function fetchWalletActivity(
  wallet: Address,
  chain: Pick<Chain, 'id' | 'nativeCurrency'>,
) {
  const params = new URLSearchParams({
    address: wallet,
    chainId: String(chain.id),
  });
  const response = await fetch(`/~wallet/activity?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? 'Complete explorer history is not configured.'
        : 'Complete explorer history is temporarily unavailable.',
    );
  }
  const payload = (await response.json()) as WalletActivityResponse;
  if (
    !payload ||
    !['etherscan', 'blockscout'].includes(payload.source) ||
    !Array.isArray(payload.normalTransactions) ||
    !Array.isArray(payload.tokenTransfers)
  ) {
    throw new Error('Explorer returned invalid activity data.');
  }
  return parseWalletActivity(payload, wallet, chain);
}
