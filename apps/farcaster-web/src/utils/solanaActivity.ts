import { DEFAULT_SOLANA_RPC_URL } from '~/utils/solanaWallet';

// Matches the EVM wallet's "five most recent transactions" behavior — this
// is a bounded recent-history read, not a paginated feed.
export const SOLANA_ACTIVITY_LIMIT = 5;

// The Jupiter Aggregator v6 program id — the router LI.FI uses for Solana
// same-chain swaps today. Swap classification only fires when a transaction
// actually routes through a program we recognize; everything else that
// moves more than one asset is left as "unknown" rather than guessed at.
const SOLANA_SWAP_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
]);

export type SolanaActivityType = 'receive' | 'send' | 'swap' | 'unknown';
export type SolanaActivityStatus = 'failed' | 'success';

export type SolanaActivityAsset = {
  amount: string;
  decimals: number;
  // undefined mint means native SOL.
  mint: string | undefined;
};

export type SolanaActivity = {
  counterparty: string | undefined;
  receivedAsset: SolanaActivityAsset | undefined;
  sentAsset: SolanaActivityAsset | undefined;
  signature: string;
  slot: number | undefined;
  status: SolanaActivityStatus;
  timestamp: number | undefined;
  type: SolanaActivityType;
};

export type SolanaSignatureEntry = {
  blockTime?: number | null;
  err?: unknown;
  signature?: unknown;
  slot?: number;
};

type SolanaSignaturesResponse = {
  error?: { message?: string };
  result?: unknown;
};

type SolanaTransactionResponse = {
  error?: { message?: string };
  result?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid response object.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.round(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

export async function fetchSolanaSignatures(
  address: string,
  options: {
    limit?: number;
    rpcUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<readonly SolanaSignatureEntry[]> {
  const limit = Math.min(options.limit ?? SOLANA_ACTIVITY_LIMIT, 5);
  const response = await fetch(options.rpcUrl ?? DEFAULT_SOLANA_RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getSignaturesForAddress',
      params: [
        address,
        {
          commitment: 'confirmed',
          limit,
        },
      ],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Solana signatures request failed (${response.status}).`);
  }
  const payload = (await response.json()) as SolanaSignaturesResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Solana RPC returned an error.');
  }
  return asArray(payload.result) as SolanaSignatureEntry[];
}

export async function fetchSolanaTransaction(
  signature: string,
  options: { rpcUrl?: string; signal?: AbortSignal } = {},
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(options.rpcUrl ?? DEFAULT_SOLANA_RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getTransaction',
      params: [
        signature,
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Solana transaction request failed (${response.status}).`);
  }
  const payload = (await response.json()) as SolanaTransactionResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Solana RPC returned an error.');
  }
  if (payload.result === null || payload.result === undefined) {
    return undefined;
  }
  try {
    return record(payload.result);
  } catch {
    return undefined;
  }
}

type ChangedAsset = {
  decimals: number;
  delta: bigint;
  mint: string | undefined;
};

function accountKeyStrings(message: Record<string, unknown>): string[] {
  return asArray(message.accountKeys).map((key) => {
    if (typeof key === 'string') {
      return key;
    }
    try {
      const parsed = record(key).pubkey;
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  });
}

function solDelta(
  meta: Record<string, unknown>,
  accountKeys: string[],
  address: string,
): bigint | undefined {
  const ownIndex = accountKeys.indexOf(address);
  if (ownIndex < 0) {
    return undefined;
  }
  const pre = asArray(meta.preBalances)[ownIndex];
  const post = asArray(meta.postBalances)[ownIndex];
  const preLamports = asBigInt(pre);
  const postLamports = asBigInt(post);
  if (preLamports === undefined || postLamports === undefined) {
    return undefined;
  }
  let delta = postLamports - preLamports;
  // The fee payer's balance always drops by the network fee; that isn't
  // part of what the wallet sent or received, so exclude it.
  if (ownIndex === 0) {
    const fee = asBigInt(meta.fee);
    if (fee !== undefined) {
      delta += fee;
    }
  }
  return delta;
}

type TokenBalanceEntry = {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown };
};

function tokenDeltas(
  meta: Record<string, unknown>,
  address: string,
): ChangedAsset[] {
  const pre = asArray(meta.preTokenBalances) as TokenBalanceEntry[];
  const post = asArray(meta.postTokenBalances) as TokenBalanceEntry[];
  const indexes = new Set<number>();
  for (const entry of [...pre, ...post]) {
    if (entry.owner === address && typeof entry.accountIndex === 'number') {
      indexes.add(entry.accountIndex);
    }
  }

  const deltasByMint = new Map<string, ChangedAsset>();
  for (const index of indexes) {
    const preEntry = pre.find(
      (entry) => entry.accountIndex === index && entry.owner === address,
    );
    const postEntry = post.find(
      (entry) => entry.accountIndex === index && entry.owner === address,
    );
    const mint = (postEntry ?? preEntry)?.mint;
    if (typeof mint !== 'string') {
      continue;
    }
    const decimals = Number(
      (postEntry ?? preEntry)?.uiTokenAmount?.decimals ?? 0,
    );
    const preAmount = asBigInt(preEntry?.uiTokenAmount?.amount) ?? 0n;
    const postAmount = asBigInt(postEntry?.uiTokenAmount?.amount) ?? 0n;
    const delta = postAmount - preAmount;
    if (delta === 0n) {
      continue;
    }
    const existing = deltasByMint.get(mint);
    deltasByMint.set(mint, {
      decimals,
      delta: (existing?.delta ?? 0n) + delta,
      mint,
    });
  }
  return [...deltasByMint.values()];
}

function toAsset(asset: ChangedAsset): SolanaActivityAsset {
  const magnitude = asset.delta < 0n ? -asset.delta : asset.delta;
  return {
    amount: magnitude.toString(),
    decimals: asset.decimals,
    mint: asset.mint,
  };
}

export function classifySolanaTransaction(
  transaction: Record<string, unknown> | undefined,
  signatureEntry: SolanaSignatureEntry,
  address: string,
): SolanaActivity {
  const signature =
    typeof signatureEntry.signature === 'string'
      ? signatureEntry.signature
      : '';
  const base: SolanaActivity = {
    counterparty: undefined,
    receivedAsset: undefined,
    sentAsset: undefined,
    signature,
    slot:
      typeof signatureEntry.slot === 'number' ? signatureEntry.slot : undefined,
    status: signatureEntry.err ? 'failed' : 'success',
    timestamp:
      typeof signatureEntry.blockTime === 'number'
        ? signatureEntry.blockTime
        : undefined,
    type: 'unknown',
  };

  if (!transaction) {
    return base;
  }

  try {
    const meta = record(transaction.meta);
    const status: SolanaActivityStatus = meta.err ? 'failed' : base.status;
    const message = record(record(transaction.transaction).message);
    const accountKeys = accountKeyStrings(message);

    const instructions = asArray(message.instructions);
    const innerInstructions = asArray(meta.innerInstructions).flatMap(
      (entry) => {
        try {
          return asArray(record(entry).instructions);
        } catch {
          return [];
        }
      },
    );
    const allInstructions = [...instructions, ...innerInstructions];
    const touchesKnownSwapProgram = allInstructions.some((instruction) => {
      try {
        const programId = record(instruction).programId;
        return (
          typeof programId === 'string' &&
          SOLANA_SWAP_PROGRAM_IDS.has(programId)
        );
      } catch {
        return false;
      }
    });

    const changed = [
      ...(() => {
        const delta = solDelta(meta, accountKeys, address);
        return delta && delta !== 0n
          ? [{ decimals: 9, delta, mint: undefined } satisfies ChangedAsset]
          : [];
      })(),
      ...tokenDeltas(meta, address),
    ];

    if (changed.length === 0) {
      return { ...base, status };
    }

    if (changed.length > 1 || touchesKnownSwapProgram) {
      if (!touchesKnownSwapProgram) {
        // More than one asset moved, but not through a router we recognize.
        // Don't guess — an unrecognized multi-asset transaction could be
        // anything from a liquidity action to an airdrop claim.
        return { ...base, status };
      }
      const sent = changed.find((asset) => asset.delta < 0n);
      const received = changed.find((asset) => asset.delta > 0n);
      return {
        ...base,
        receivedAsset: received ? toAsset(received) : undefined,
        sentAsset: sent ? toAsset(sent) : undefined,
        status,
        type: 'swap',
      };
    }

    const [only] = changed;
    return only.delta < 0n
      ? { ...base, sentAsset: toAsset(only), status, type: 'send' }
      : { ...base, receivedAsset: toAsset(only), status, type: 'receive' };
  } catch {
    return base;
  }
}

export async function fetchSolanaActivity(
  address: string,
  options: {
    limit?: number;
    rpcUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<readonly SolanaActivity[]> {
  const signatures = await fetchSolanaSignatures(address, options);
  return Promise.all(
    signatures.map(async (entry) => {
      if (typeof entry.signature !== 'string') {
        return classifySolanaTransaction(undefined, entry, address);
      }
      const transaction = await fetchSolanaTransaction(entry.signature, {
        rpcUrl: options.rpcUrl,
        signal: options.signal,
      }).catch(() => undefined);
      return classifySolanaTransaction(transaction, entry, address);
    }),
  );
}
