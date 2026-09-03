import { VersionedTransaction } from '@solana/web3.js';

import { requestLifi } from '~/utils/lifiWallet';
import { parseSolanaAmount } from '~/utils/solanaTransfer';
import { LIFI_SOLANA_CHAIN_ID, SolanaTokenAsset } from '~/utils/solanaWallet';

export const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type SolanaSwapAsset = Pick<
  SolanaTokenAsset,
  'amount' | 'decimals' | 'mint' | 'name' | 'symbol'
>;

type LifiSolanaToken = {
  address: string;
  chainId: number;
  decimals: number;
  symbol: string;
};

export type LifiSolanaQuote = {
  action: {
    fromAddress: string;
    fromAmount: string;
    fromChainId: number;
    fromToken: LifiSolanaToken;
    slippage: number;
    toAddress: string;
    toChainId: number;
    toToken: LifiSolanaToken;
  };
  estimate: {
    feeCosts?: readonly {
      amount?: string;
      amountUSD?: string;
      included?: boolean;
      name?: string;
      token?: LifiSolanaToken;
    }[];
    gasCosts?: readonly {
      amount?: string;
      amountUSD?: string;
      token?: LifiSolanaToken;
    }[];
    toAmount: string;
    toAmountMin: string;
    toAmountUSD?: string;
  };
  tool: string;
  transactionRequest: { data: string };
};

function units(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validBase64(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function decodeLifiSolanaTransaction(
  data: string,
  wallet: string,
): Uint8Array {
  try {
    const bytes = fromBase64(data);
    const transaction = VersionedTransaction.deserialize(bytes);
    const feePayer = transaction.message.staticAccountKeys[0]?.toBase58();
    if (
      transaction.message.header.numRequiredSignatures !== 1 ||
      feePayer !== wallet
    ) {
      throw new Error('unexpected fee payer');
    }
    return bytes;
  } catch {
    throw new Error(
      'LI.FI returned an invalid Solana transaction. Request a new quote.',
    );
  }
}

export function validateLifiSolanaQuote(
  quote: LifiSolanaQuote,
  wallet: string,
  from: SolanaSwapAsset,
  to: SolanaSwapAsset,
  amount: bigint,
): void {
  const action = quote?.action;
  const estimate = quote?.estimate;
  if (
    !action ||
    !estimate ||
    typeof quote.tool !== 'string' ||
    !quote.tool ||
    action.fromChainId !== LIFI_SOLANA_CHAIN_ID ||
    action.toChainId !== LIFI_SOLANA_CHAIN_ID ||
    action.fromToken?.chainId !== LIFI_SOLANA_CHAIN_ID ||
    action.toToken?.chainId !== LIFI_SOLANA_CHAIN_ID ||
    action.fromAddress !== wallet ||
    action.toAddress !== wallet ||
    action.fromToken.address !== from.mint ||
    action.toToken.address !== to.mint ||
    action.fromToken.decimals !== from.decimals ||
    action.toToken.decimals !== to.decimals ||
    !units(action.fromAmount) ||
    BigInt(action.fromAmount) !== amount ||
    !units(estimate.toAmount) ||
    !units(estimate.toAmountMin) ||
    BigInt(estimate.toAmountMin) <= 0n ||
    BigInt(estimate.toAmountMin) > BigInt(estimate.toAmount) ||
    !validBase64(quote.transactionRequest?.data)
  ) {
    throw new Error(
      'LI.FI quote does not match this Solana swap. Request a new quote.',
    );
  }
  decodeLifiSolanaTransaction(quote.transactionRequest.data, wallet);
}

export function assertFreshSolanaQuote(
  reviewed: LifiSolanaQuote,
  refreshed: LifiSolanaQuote,
): void {
  if (
    refreshed.tool !== reviewed.tool ||
    BigInt(refreshed.estimate.toAmountMin) <
      BigInt(reviewed.estimate.toAmountMin)
  ) {
    throw new Error(
      'Quote changed. Get a new quote and review it before swapping.',
    );
  }
}

export async function fetchLifiSolanaQuote(
  wallet: string,
  from: SolanaSwapAsset,
  to: SolanaSwapAsset,
  amountInput: string,
  signal?: AbortSignal,
): Promise<{ amount: bigint; quote: LifiSolanaQuote }> {
  if (from.mint === to.mint) {
    throw new Error('Choose two different assets.');
  }
  const amount = parseSolanaAmount(amountInput, from.decimals);
  if (amount > BigInt(from.amount)) {
    throw new Error(`Insufficient ${from.symbol} balance.`);
  }
  const params = new URLSearchParams({
    fromAddress: wallet,
    fromAmount: amount.toString(),
    fromChain: String(LIFI_SOLANA_CHAIN_ID),
    fromToken: from.mint,
    integrator: 'farcaster-wallet-client',
    order: 'CHEAPEST',
    slippage: '0.005',
    toAddress: wallet,
    toChain: String(LIFI_SOLANA_CHAIN_ID),
    toToken: to.mint,
  });
  const quote = (await requestLifi(
    `/quote?${params}`,
    signal,
  )) as LifiSolanaQuote;
  validateLifiSolanaQuote(quote, wallet, from, to, amount);
  return { amount, quote };
}

export function formatSolanaSwapUnits(value: string, decimals: number): string {
  if (!units(value)) {
    throw new Error('Invalid token amount.');
  }
  if (decimals === 0) {
    return value;
  }
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function estimatedSolanaNetworkFee(
  quote: LifiSolanaQuote,
): string | undefined {
  const cost = quote.estimate.gasCosts?.find(
    (entry) => entry.token?.address === SOLANA_NATIVE_MINT,
  );
  return cost && units(cost.amount)
    ? formatSolanaSwapUnits(cost.amount, cost.token?.decimals ?? 9)
    : undefined;
}

export function isHighCostSolanaQuote(quote: LifiSolanaQuote): boolean {
  const outputUsd = Number(quote.estimate.toAmountUSD);
  const gasUsd = (quote.estimate.gasCosts ?? []).reduce((total, cost) => {
    const value = Number(cost.amountUSD);
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  return Number.isFinite(outputUsd) && outputUsd > 0 && gasUsd > outputUsd;
}
