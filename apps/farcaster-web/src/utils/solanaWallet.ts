export const SOLANA_MAINNET_NAME = 'Solana Mainnet';
export const SOLANA_EXPLORER_URL = 'https://explorer.solana.com';
export const SOLANA_LAMPORTS_PER_SOL = 1_000_000_000;
export const DEFAULT_SOLANA_RPC_URL = '/~wallet/solana-rpc';
export const LIFI_SOLANA_CHAIN_ID = 1_151_111_081_099_710;
export const SOLANA_TOKEN_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LIFI_TOKENS_URL = `https://li.quest/v1/tokens?chains=${LIFI_SOLANA_CHAIN_ID}`;

type SolanaBalanceResponse = {
  error?: { message?: string };
  result?: { value?: number };
};

export type SolanaTokenAsset = {
  amount: string;
  decimals: number;
  logoURI?: string;
  mint: string;
  name: string;
  priceUSD?: number;
  programId: string;
  recognized: boolean;
  symbol: string;
  tokenAccounts: readonly { address: string; amount: string }[];
};

type ParsedTokenAccount = {
  amount: string;
  decimals: number;
  mint: string;
  programId: string;
  tokenAccounts: readonly { address: string; amount: string }[];
};

type SolanaTokenAccountsResponse = {
  error?: { message?: string };
  result?: { value?: unknown[] };
};

export async function fetchSolanaBalance(
  address: string,
  options: {
    rpcUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const response = await fetch(options.rpcUrl ?? DEFAULT_SOLANA_RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getBalance',
      params: [address, { commitment: 'confirmed' }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Solana RPC request failed (${response.status}).`);
  }

  const payload = (await response.json()) as SolanaBalanceResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Solana RPC returned an error.');
  }
  const lamports = payload.result?.value;
  if (
    typeof lamports !== 'number' ||
    !Number.isSafeInteger(lamports) ||
    lamports < 0
  ) {
    throw new Error('Solana RPC returned an invalid balance.');
  }
  return lamports;
}

export function formatSolBalance(lamports: number): string {
  return `${(lamports / SOLANA_LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 9,
  })} SOL`;
}

export function solanaAddressUrl(address: string): string {
  return `${SOLANA_EXPLORER_URL}/address/${encodeURIComponent(address)}?cluster=mainnet-beta`;
}

async function requestSolanaTokenProgram(
  address: string,
  programId: string,
  rpcUrl: string,
  signal?: AbortSignal,
): Promise<ParsedTokenAccount[]> {
  const response = await fetch(rpcUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getTokenAccountsByOwner',
      params: [
        address,
        { programId },
        { commitment: 'confirmed', encoding: 'jsonParsed' },
      ],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Solana token RPC request failed (${response.status}).`);
  }
  const payload = (await response.json()) as SolanaTokenAccountsResponse;
  if (payload.error) {
    throw new Error(
      payload.error.message ?? 'Solana token RPC returned an error.',
    );
  }
  if (!Array.isArray(payload.result?.value)) {
    throw new Error('Solana token RPC returned an invalid account list.');
  }

  return payload.result.value.flatMap((entry) => {
    try {
      const entryRecord = record(entry);
      const tokenAccountAddress = entryRecord.pubkey;
      const account = entryRecord.account;
      const data = record(record(account).data);
      const parsed = record(data.parsed);
      const info = record(parsed.info);
      const tokenAmount = record(info.tokenAmount);
      const mint = info.mint;
      const amount = tokenAmount.amount;
      const decimals = tokenAmount.decimals;
      if (
        typeof mint !== 'string' ||
        !mint ||
        typeof tokenAccountAddress !== 'string' ||
        typeof amount !== 'string' ||
        !/^\d+$/.test(amount) ||
        typeof decimals !== 'number' ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 255
      ) {
        return [];
      }
      return [
        {
          amount,
          decimals,
          mint,
          programId,
          tokenAccounts: [{ address: tokenAccountAddress, amount }],
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function fetchSolanaTokenAccounts(
  address: string,
  options: { rpcUrl?: string; signal?: AbortSignal } = {},
): Promise<ParsedTokenAccount[]> {
  const rpcUrl = options.rpcUrl ?? DEFAULT_SOLANA_RPC_URL;
  const rows = (
    await Promise.all(
      [SOLANA_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) =>
        requestSolanaTokenProgram(address, programId, rpcUrl, options.signal),
      ),
    )
  ).flat();
  const aggregated = new Map<string, ParsedTokenAccount>();
  for (const row of rows) {
    if (BigInt(row.amount) === 0n) {
      continue;
    }
    const current = aggregated.get(row.mint);
    if (
      current &&
      (current.decimals !== row.decimals || current.programId !== row.programId)
    ) {
      continue;
    }
    aggregated.set(row.mint, {
      ...row,
      amount: (BigInt(current?.amount ?? '0') + BigInt(row.amount)).toString(),
      tokenAccounts: [...(current?.tokenAccounts ?? []), ...row.tokenAccounts],
    });
  }
  return [...aggregated.values()];
}

export async function fetchSolanaTokenPortfolio(
  address: string,
  options: { rpcUrl?: string; signal?: AbortSignal } = {},
): Promise<SolanaTokenAsset[]> {
  const [accounts, response] = await Promise.all([
    fetchSolanaTokenAccounts(address, options),
    fetch(LIFI_TOKENS_URL, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    }),
  ]);
  if (!response.ok) {
    throw new Error(`LI.FI token request failed (${response.status}).`);
  }
  const payload = record(await response.json());
  const tokensByChain = record(payload.tokens);
  const metadataRows = tokensByChain[String(LIFI_SOLANA_CHAIN_ID)];
  if (!Array.isArray(metadataRows)) {
    throw new Error('LI.FI returned an invalid Solana token list.');
  }
  const metadata = new Map<string, Record<string, unknown>>();
  for (const value of metadataRows) {
    try {
      const token = record(value);
      if (typeof token.address === 'string') {
        metadata.set(token.address, token);
      }
    } catch {
      // Ignore malformed metadata without hiding a valid on-chain balance.
    }
  }

  return accounts
    .map((account): SolanaTokenAsset => {
      const token = metadata.get(account.mint);
      const metadataDecimals = token?.decimals;
      const recognized =
        Boolean(token) &&
        typeof metadataDecimals === 'number' &&
        metadataDecimals === account.decimals;
      const rawPrice = token?.priceUSD;
      const price =
        typeof rawPrice === 'string' && rawPrice.trim()
          ? Number(rawPrice)
          : rawPrice;
      return {
        ...account,
        logoURI:
          recognized && typeof token?.logoURI === 'string'
            ? token.logoURI
            : undefined,
        name:
          recognized && typeof token?.name === 'string'
            ? token.name
            : 'Unrecognized SPL token',
        priceUSD:
          recognized &&
          typeof price === 'number' &&
          Number.isFinite(price) &&
          price >= 0
            ? price
            : undefined,
        recognized,
        symbol:
          recognized && typeof token?.symbol === 'string' && token.symbol
            ? token.symbol
            : `${account.mint.slice(0, 4)}…${account.mint.slice(-4)}`,
      };
    })
    .sort((left, right) => {
      const leftUsd = solanaTokenUsd(left) ?? -1;
      const rightUsd = solanaTokenUsd(right) ?? -1;
      return rightUsd - leftUsd || left.symbol.localeCompare(right.symbol);
    });
}

export function formatSolanaTokenAmount(asset: SolanaTokenAsset): string {
  const amount = BigInt(asset.amount);
  if (asset.decimals === 0) {
    return amount.toString();
  }
  const padded = amount.toString().padStart(asset.decimals + 1, '0');
  const whole = padded.slice(0, -asset.decimals);
  const fraction = padded.slice(-asset.decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function solanaTokenUsd(asset: SolanaTokenAsset): number | undefined {
  if (asset.priceUSD === undefined) {
    return undefined;
  }
  const value = Number(formatSolanaTokenAmount(asset)) * asset.priceUSD;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid response object.');
  }
  return value as Record<string, unknown>;
}
