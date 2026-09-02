import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import {
  DEFAULT_SOLANA_RPC_URL,
  SOLANA_LAMPORTS_PER_SOL,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  SolanaTokenAsset,
} from '~/utils/solanaWallet';

const TOKEN_ACCOUNT_SIZE = 165;

type RpcPayload<T> = { error?: { message?: string }; result?: T };

export type PreparedSolanaTransfer = {
  amountBaseUnits: bigint;
  feeLamports: number;
  recipientMinimumLamports: number;
  rentLamports: number;
  transaction: Uint8Array;
};

type PrepareSolanaTransferInput = {
  amount: string;
  asset?: SolanaTokenAsset;
  recipient: string;
  rpcUrl?: string;
  sender: string;
  solBalanceLamports: number;
};

async function rpc<T>(
  method: string,
  params: unknown[],
  rpcUrl = DEFAULT_SOLANA_RPC_URL,
): Promise<T> {
  const response = await fetch(rpcUrl, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Solana RPC request failed (${response.status}).`);
  }
  const payload = (await response.json()) as RpcPayload<T>;
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Solana RPC returned an error.');
  }
  if (payload.result === undefined) {
    throw new Error('Solana RPC returned an invalid response.');
  }
  return payload.result;
}

export function parseSolanaAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error('Enter a valid amount.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`This asset supports at most ${decimals} decimal places.`);
  }
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (value <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return value;
}

function publicKey(
  value: string,
  label: string,
  requireOnCurve = false,
): PublicKey {
  try {
    const key = new PublicKey(value);
    if (requireOnCurve && !PublicKey.isOnCurve(key.toBytes())) {
      throw new Error('off curve');
    }
    return key;
  } catch {
    throw new Error(`Enter a valid Solana ${label} address.`);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function unsignedBytes(transaction: Transaction): Uint8Array {
  return new Uint8Array(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
}

function tokenProgram(programId: string): PublicKey {
  if (programId === SOLANA_TOKEN_PROGRAM_ID) {
    return TOKEN_PROGRAM_ID;
  }
  if (programId === SOLANA_TOKEN_2022_PROGRAM_ID) {
    return TOKEN_2022_PROGRAM_ID;
  }
  throw new Error('This token program is not supported for transfers.');
}

export async function prepareSolanaTransfer({
  amount,
  asset,
  recipient,
  rpcUrl,
  sender,
  solBalanceLamports,
}: PrepareSolanaTransferInput): Promise<PreparedSolanaTransfer> {
  const senderKey = publicKey(sender, 'sender', true);
  const recipientKey = publicKey(recipient, 'recipient', true);
  if (senderKey.equals(recipientKey)) {
    throw new Error('Recipient must be different from your wallet.');
  }
  const amountBaseUnits = parseSolanaAmount(amount, asset?.decimals ?? 9);
  if (asset && amountBaseUnits > BigInt(asset.amount)) {
    throw new Error(`Insufficient ${asset.symbol} balance.`);
  }
  if (!asset && amountBaseUnits > BigInt(solBalanceLamports)) {
    throw new Error('Insufficient SOL balance.');
  }

  const latest = await rpc<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>('getLatestBlockhash', [{ commitment: 'confirmed' }], rpcUrl);
  const transaction = new Transaction({
    feePayer: senderKey,
    recentBlockhash: latest.value.blockhash,
  });
  let rentLamports = 0;
  let recipientMinimumLamports = 0;

  if (!asset) {
    if (amountBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('SOL amount is too large.');
    }
    const recipientAccount = await rpc<{ value: unknown | null }>(
      'getAccountInfo',
      [
        recipientKey.toBase58(),
        { commitment: 'confirmed', encoding: 'base64' },
      ],
      rpcUrl,
    );
    if (!recipientAccount.value) {
      recipientMinimumLamports = await rpc<number>(
        'getMinimumBalanceForRentExemption',
        [0, { commitment: 'confirmed' }],
        rpcUrl,
      );
      if (amountBaseUnits < BigInt(recipientMinimumLamports)) {
        throw new Error(
          `This address has no Solana account yet. Send at least ${formatSolanaFee(recipientMinimumLamports)} to create it.`,
        );
      }
    }
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderKey,
        lamports: Number(amountBaseUnits),
        toPubkey: recipientKey,
      }),
    );
  } else {
    const program = tokenProgram(asset.programId);
    const mint = publicKey(asset.mint, 'token mint');
    const destination = getAssociatedTokenAddressSync(
      mint,
      recipientKey,
      false,
      program,
    );
    const destinationAccount = await rpc<{ value: unknown | null }>(
      'getAccountInfo',
      [destination.toBase58(), { commitment: 'confirmed', encoding: 'base64' }],
      rpcUrl,
    );
    if (!destinationAccount.value) {
      rentLamports = await rpc<number>(
        'getMinimumBalanceForRentExemption',
        [TOKEN_ACCOUNT_SIZE, { commitment: 'confirmed' }],
        rpcUrl,
      );
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          senderKey,
          destination,
          recipientKey,
          mint,
          program,
        ),
      );
    }

    let remaining = amountBaseUnits;
    for (const source of asset.tokenAccounts) {
      if (remaining === 0n) {
        break;
      }
      const available = BigInt(source.amount);
      const transferAmount = available < remaining ? available : remaining;
      if (transferAmount === 0n) {
        continue;
      }
      transaction.add(
        createTransferCheckedInstruction(
          publicKey(source.address, 'token account'),
          mint,
          destination,
          senderKey,
          transferAmount,
          asset.decimals,
          [],
          program,
        ),
      );
      remaining -= transferAmount;
    }
    if (remaining !== 0n) {
      throw new Error(`Insufficient ${asset.symbol} balance.`);
    }
  }

  const message = transaction.serializeMessage();
  const fee = await rpc<{ value: number | null }>(
    'getFeeForMessage',
    [base64(new Uint8Array(message)), { commitment: 'confirmed' }],
    rpcUrl,
  );
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) {
    throw new Error('Could not estimate the Solana network fee.');
  }
  const requiredLamports =
    fee.value + rentLamports + (asset ? 0 : Number(amountBaseUnits));
  if (requiredLamports > solBalanceLamports) {
    throw new Error('Insufficient SOL for the amount and network costs.');
  }
  return {
    amountBaseUnits,
    feeLamports: fee.value,
    recipientMinimumLamports,
    rentLamports,
    transaction: unsignedBytes(transaction),
  };
}

export async function submitSignedSolanaTransaction(
  transaction: Uint8Array,
  rpcUrl?: string,
): Promise<string> {
  return rpc<string>(
    'sendTransaction',
    [
      base64(transaction),
      {
        encoding: 'base64',
        maxRetries: 3,
        preflightCommitment: 'confirmed',
        skipPreflight: false,
      },
    ],
    rpcUrl,
  );
}

export async function waitForSolanaConfirmation(
  signature: string,
  options: { attempts?: number; intervalMs?: number; rpcUrl?: string } = {},
): Promise<void> {
  const attempts = options.attempts ?? 45;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await rpc<{
      value: readonly ({ confirmationStatus?: string; err?: unknown } | null)[];
    }>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
      options.rpcUrl,
    );
    const status = result.value[0];
    if (status?.err) {
      throw new Error('The Solana transaction failed.');
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return;
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, options.intervalMs ?? 1_000),
    );
  }
  throw new Error(
    'Confirmation is taking longer than expected. Check the transaction in Solana Explorer.',
  );
}

export function formatSolanaFee(lamports: number): string {
  return `${(lamports / SOLANA_LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 9,
  })} SOL`;
}

export function solanaTransactionUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=mainnet-beta`;
}
