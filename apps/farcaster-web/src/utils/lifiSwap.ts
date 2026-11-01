import { hyperevm, robinhood } from 'farcaster-client-data';
import { Address, Chain, Hash, isAddress, zeroAddress } from 'viem';
import { arbitrum, base, bsc, celo, mainnet, monad } from 'viem/chains';

import {
  CELO_NATIVE_TOKEN_ADDRESS,
  LifiAsset,
  requestLifi,
} from '~/utils/lifiWallet';
import { MOVE_DESTINATION_CHAINS } from '~/utils/walletNetwork';

// Cross-chain moves are adapted from quilcast `5e4759372ed0` and `f45e83f4146b`
// (MIT): one keyless LI.FI quote per move, refused unless the transaction goes
// to LI.FI's own contract on the chain the sold token lives on. Upstream pins
// that address for every chain; this file pins it per chain (see LIFI_DIAMOND)
// and adds our destination-chain, receiver and arrival clauses.

// LI.FI models Celo's native asset through the CeloToken address. Celo token
// duality keeps this ERC-20 representation and the native CELO balance in sync.
// Keep the wallet UI on zeroAddress, but translate the asset at the quote and
// approval boundary where LI.FI requires the contract address.
export function toLifiSwapAsset(
  asset: LifiAsset,
  chain: Pick<Chain, 'id'>,
): LifiAsset {
  return chain.id === 42220 && asset.address === zeroAddress
    ? { ...asset, address: CELO_NATIVE_TOKEN_ADDRESS }
    : asset;
}

// The one contract a route may call, per chain. Measured 2026-10-23: every route
// target below is what `GET /v1/chains` reports as that chain's `diamondAddress`,
// and live `/quote` responses routed through exactly that address on Base,
// Ethereum, Arbitrum, BNB Smart Chain, Celo, HyperEVM and Robinhood Chain (Monad
// has no cross-chain route to test today, so its address comes from `/chains`
// alone). A cross-chain move is only signed when the transaction goes to the
// chain's own entry contract and the approval names the same one: a bridge that
// points anywhere else is not ours to sign, and the cost of being wrong is the
// whole amount.
export const LIFI_DIAMOND: Readonly<Record<number, Address>> = {
  [mainnet.id]: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  [base.id]: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  [arbitrum.id]: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  [bsc.id]: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  [celo.id]: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  [monad.id]: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37',
  [hyperevm.id]: '0x0a0758d937d1059c356D4714e57F5df0239bce1A',
  [robinhood.id]: '0xB477751B76CF82d00a686A1232f5fCD772414Af3',
};

export type LifiQuote = {
  tool?: string;
  toolDetails?: { name?: string };
  action: {
    fromChainId: number;
    toChainId: number;
    fromAddress: Address;
    toAddress: Address;
    fromAmount: string;
    fromToken: { chainId: number; address: Address; decimals: number };
    toToken: { chainId: number; address: Address; decimals: number };
  };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: Address;
    executionDuration?: number;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    gasCosts?: { amountUSD?: string }[];
    feeCosts?: { amountUSD?: string; included?: boolean }[];
  };
  transactionRequest: {
    chainId: number;
    from: Address;
    to: Address;
    data: `0x${string}`;
    value?: `0x${string}`;
    gasLimit?: `0x${string}`;
    gasPrice?: `0x${string}`;
    maxFeePerGas?: `0x${string}`;
    maxPriorityFeePerGas?: `0x${string}`;
  };
};

function sameAddress(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function unitAmount(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function hexQuantity(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && /^0x[\da-f]+$/i.test(value))
  );
}

/**
 * Every clause a quote has to pass, each with the sentence that names what it
 * broke. Split out from the throwing validator so a refusal can say which part
 * of the route was wrong instead of "the quote does not match".
 *
 * A same-chain swap is judged exactly as it was before: `toChain` defaults to
 * the chain the sold token lives on. Naming a different `toChain` asks for a
 * cross-chain move, which adds the clauses in the `crossing` block below.
 */
export function lifiQuoteFailures(
  quote: LifiQuote,
  wallet: Address,
  from: LifiAsset,
  to: LifiAsset,
  amount: bigint,
  chain: Pick<Chain, 'id' | 'name'> = base,
  toChain: Pick<Chain, 'id' | 'name'> = chain,
): string[] {
  const failures: string[] = [];
  const check = (holds: boolean, reason: string) => {
    if (!holds) {
      failures.push(reason);
    }
  };
  const action = quote?.action;
  const estimate = quote?.estimate;
  const transaction = quote?.transactionRequest;
  if (!action || !estimate || !transaction) {
    return ['the route is missing its description'];
  }
  const crossing = toChain.id !== chain.id;
  const diamond = LIFI_DIAMOND[chain.id];
  const usesLegacyGas = transaction.gasPrice !== undefined;
  const usesMaxFee = transaction.maxFeePerGas !== undefined;
  const usesPriorityFee = transaction.maxPriorityFeePerGas !== undefined;

  check(
    action.fromChainId === chain.id,
    `the route sells on chain ${action.fromChainId}, not ${chain.id}`,
  );
  check(
    action.toChainId === toChain.id,
    `the route lands on chain ${action.toChainId}, not ${toChain.id}`,
  );
  check(
    action.fromToken?.chainId === chain.id,
    `the sold token is not a ${chain.name} token`,
  );
  check(
    action.toToken?.chainId === toChain.id,
    `the bought token is not a ${toChain.name} token`,
  );
  check(
    sameAddress(action.fromAddress, wallet),
    'the seller is not this wallet',
  );
  check(
    sameAddress(action.toAddress, wallet),
    'the receiver is not this wallet',
  );
  check(
    sameAddress(action.fromToken?.address, from.address),
    'the sold token is a different contract',
  );
  check(
    sameAddress(action.toToken?.address, to.address),
    'the bought token is a different contract',
  );
  check(
    action.fromToken?.decimals === from.decimals,
    'the sold token decimals changed',
  );
  check(
    action.toToken?.decimals === to.decimals,
    'the bought token decimals changed',
  );
  check(
    unitAmount(action.fromAmount) && BigInt(action.fromAmount) === amount,
    'the sold amount is not the amount requested',
  );
  check(unitAmount(estimate.toAmount), 'the receive amount is missing');
  check(
    unitAmount(estimate.toAmountMin) &&
      BigInt(estimate.toAmountMin) > 0n &&
      unitAmount(estimate.toAmount) &&
      BigInt(estimate.toAmountMin) <= BigInt(estimate.toAmount),
    'the minimum receive is not below the quote',
  );
  check(
    transaction.chainId === chain.id,
    `the transaction is for chain ${transaction.chainId}, not ${chain.id}`,
  );
  check(
    sameAddress(transaction.from, wallet),
    'the transaction is signed by a different address',
  );
  check(
    typeof transaction.to === 'string' &&
      isAddress(transaction.to) &&
      transaction.to !== zeroAddress,
    'the route has no contract to call',
  );
  check(
    typeof transaction.data === 'string' &&
      /^0x(?:[a-fA-F0-9]{2})+$/.test(transaction.data),
    'the route has no calldata',
  );
  check(hexQuantity(transaction.value), 'the transaction value is malformed');
  check(hexQuantity(transaction.gasLimit), 'the gas limit is malformed');
  check(hexQuantity(transaction.gasPrice), 'the gas price is malformed');
  check(
    hexQuantity(transaction.maxFeePerGas) &&
      hexQuantity(transaction.maxPriorityFeePerGas),
    'the fee fields are malformed',
  );
  check(
    !(usesLegacyGas && (usesMaxFee || usesPriorityFee)),
    'the quote sets both a gas price and a fee cap',
  );
  check(
    usesMaxFee === usesPriorityFee,
    'the quote sets only one of the fee cap fields',
  );
  check(
    !estimate.approvalAddress ||
      (isAddress(estimate.approvalAddress) &&
        estimate.approvalAddress !== zeroAddress),
    'the approval address is not a contract',
  );
  check(
    !(
      from.address === zeroAddress && BigInt(transaction.value ?? '0') < amount
    ),
    'the transaction value does not cover the amount being sold',
  );

  if (crossing) {
    check(
      MOVE_DESTINATION_CHAINS.has(toChain.id),
      `moves to ${toChain.name} are not supported`,
    );
    check(
      diamond !== undefined && sameAddress(transaction.to, diamond),
      `the route does not go through LI.FI's ${chain.name} contract`,
    );
    check(
      !estimate.approvalAddress ||
        (diamond !== undefined &&
          sameAddress(estimate.approvalAddress, diamond)),
      `the approval is not for LI.FI's ${chain.name} contract`,
    );
  }
  return failures;
}

export function validateLifiQuote(
  quote: LifiQuote,
  wallet: Address,
  from: LifiAsset,
  to: LifiAsset,
  amount: bigint,
  chain: Pick<Chain, 'id' | 'name'> = base,
  toChain: Pick<Chain, 'id' | 'name'> = chain,
) {
  const failures = lifiQuoteFailures(
    quote,
    wallet,
    from,
    to,
    amount,
    chain,
    toChain,
  );
  if (failures.length > 0) {
    const move =
      toChain.id === chain.id
        ? `this ${chain.name} swap`
        : `this move to ${toChain.name}`;
    throw new Error(
      `LI.FI quote does not match ${move} (${failures[0]}). Request a new quote.`,
    );
  }
}

/**
 * What a route costs and how long it takes, in the words the sheet shows — each
 * field present only when LI.FI actually reported it. A missing fee is said to
 * be missing by saying nothing; "$0.00" and "~0 seconds" are claims, not
 * absences.
 */
export type LifiMoveCost = {
  tool?: string;
  seconds?: number;
  feesUsd?: number;
  fromUsd?: number;
  toUsd?: number;
};

function usd(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function named(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

export function readLifiQuoteCost(quote: LifiQuote): LifiMoveCost {
  const estimate = quote.estimate ?? ({} as LifiQuote['estimate']);
  const summed = (rows?: { amountUSD?: string }[]) => {
    const known = (rows ?? [])
      .map((row) => usd(row?.amountUSD))
      .filter((value): value is number => value !== undefined);
    return known.length > 0
      ? known.reduce((total, value) => total + value, 0)
      : undefined;
  };
  // Gas is always paid on top. A route fee marked `included` is already taken
  // out of the sold amount, so adding it again would overstate the cost.
  const extraFees = [
    summed(estimate.gasCosts),
    summed((estimate.feeCosts ?? []).filter((fee) => !fee.included)),
  ].filter((value): value is number => value !== undefined);
  const duration = estimate.executionDuration;
  return {
    tool: named(quote.toolDetails?.name) ?? named(quote.tool),
    seconds:
      typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? Math.round(duration)
        : undefined,
    feesUsd:
      extraFees.length > 0
        ? extraFees.reduce((total, value) => total + value, 0)
        : undefined,
    fromUsd: usd(estimate.fromAmountUSD),
    toUsd: usd(estimate.toAmountUSD),
  };
}

export type LifiMoveState = 'waiting' | 'arrived' | 'failed';

export type LifiMoveProgress = {
  state: LifiMoveState;
  sendingTxHash?: Hash;
  receivingTxHash?: Hash;
};

/**
 * Where a cross-chain move is, from LI.FI's own answer. Only a completed fill
 * counts as arrived: a refunded or partial fill reported a problem, and telling
 * someone their money arrived when it did not is the one lie a wallet cannot
 * make. An answer this build does not recognise (including the empty body LI.FI
 * sends for a transaction it has not indexed yet) keeps waiting.
 */
export function parseLifiTransferStatus(body: unknown): LifiMoveProgress {
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const word = (value: unknown) =>
    typeof value === 'string' ? value.toUpperCase() : '';
  const status = word(record.status);
  const substatus = word(record.substatus);
  const txHash = (value: unknown) =>
    typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)
      ? (value as Hash)
      : undefined;
  const sending = record.sending as Record<string, unknown> | undefined;
  const receiving = record.receiving as Record<string, unknown> | undefined;
  const hashes = {
    sendingTxHash: txHash(sending?.txHash),
    receivingTxHash: txHash(receiving?.txHash),
  };
  if (
    status === 'FAILED' ||
    (status === 'DONE' && /PARTIAL|REFUND/.test(substatus))
  ) {
    return { state: 'failed', ...hashes };
  }
  if (status === 'DONE') {
    return { state: 'arrived', ...hashes };
  }
  return { state: 'waiting', ...hashes };
}

export async function fetchLifiTransferStatus(
  transactionHash: Hash,
  fromChainId: number,
  toChainId: number,
  signal?: AbortSignal,
): Promise<LifiMoveProgress> {
  const params = new URLSearchParams({
    txHash: transactionHash,
    fromChain: String(fromChainId),
    toChain: String(toChainId),
  });
  // A move LI.FI has not indexed yet answers 404 with no status at all, which is
  // "not yet", not an error the person can do anything about.
  return parseLifiTransferStatus(
    await requestLifi(`/status?${params}`, signal, { allowNotFound: true }),
  );
}

/**
 * LI.FI's refusal for a route it cannot build is accurate but not a sentence
 * anyone can act on. Only the shapes measured here are rewritten; anything else
 * is shown as it arrived.
 */
export function lifiMoveErrorMessage(
  message: string,
  toChainName: string,
): string {
  return /no (?:available )?quotes|no route|could not successfully generate a tx|not found|deny list/i.test(
    message,
  )
    ? `No route can move this to ${toChainName} right now. Try a different amount, token, or network.`
    : message;
}

export async function fetchLifiQuote(
  wallet: Address,
  from: LifiAsset,
  to: LifiAsset,
  amount: bigint,
  chain: Pick<Chain, 'id' | 'name'> = base,
  toChain: Pick<Chain, 'id' | 'name'> = chain,
) {
  const params = new URLSearchParams({
    fromChain: String(chain.id),
    toChain: String(toChain.id),
    fromToken: from.address,
    toToken: to.address,
    fromAmount: amount.toString(),
    fromAddress: wallet,
    toAddress: wallet,
    slippage: '0.005',
    order: 'CHEAPEST',
    integrator: 'farcaster-wallet-client',
  });
  const quote = (await requestLifi(`/quote?${params}`)) as LifiQuote;
  validateLifiQuote(quote, wallet, from, to, amount, chain, toChain);
  return quote;
}
