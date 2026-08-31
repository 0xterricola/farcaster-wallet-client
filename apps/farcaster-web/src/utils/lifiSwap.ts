import { Address, isAddress, zeroAddress } from 'viem';
import { base } from 'viem/chains';

import { LifiAsset, requestLifi } from '~/utils/lifiWallet';

export type LifiQuote = {
  tool: string;
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
  };
  transactionRequest: {
    chainId: number;
    from: Address;
    to: Address;
    data: `0x${string}`;
    value?: `0x${string}`;
    gasLimit?: `0x${string}`;
    gasPrice?: `0x${string}`;
  };
};

export function validateLifiQuote(
  quote: LifiQuote,
  wallet: Address,
  from: LifiAsset,
  to: LifiAsset,
  amount: bigint,
) {
  const same = (a: string | undefined, b: string) =>
    typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const units = (value: unknown) =>
    typeof value === 'string' && /^\d+$/.test(value);
  if (
    !quote?.action ||
    !quote.estimate ||
    !quote.transactionRequest ||
    quote.action.fromChainId !== base.id ||
    quote.action.toChainId !== base.id ||
    quote.action.fromToken?.chainId !== base.id ||
    quote.action.toToken?.chainId !== base.id ||
    !same(quote.action.fromAddress, wallet) ||
    !same(quote.action.toAddress, wallet) ||
    !same(quote.action.fromToken?.address, from.address) ||
    !same(quote.action.toToken?.address, to.address) ||
    quote.action.fromToken.decimals !== from.decimals ||
    quote.action.toToken.decimals !== to.decimals ||
    !units(quote.action.fromAmount) ||
    BigInt(quote.action.fromAmount) !== amount ||
    !units(quote.estimate.toAmount) ||
    !units(quote.estimate.toAmountMin) ||
    BigInt(quote.estimate.toAmountMin) <= 0n ||
    BigInt(quote.estimate.toAmountMin) > BigInt(quote.estimate.toAmount) ||
    quote.transactionRequest.chainId !== base.id ||
    !same(quote.transactionRequest.from, wallet) ||
    !isAddress(quote.transactionRequest.to) ||
    quote.transactionRequest.to === zeroAddress ||
    typeof quote.transactionRequest.data !== 'string' ||
    !/^0x(?:[a-fA-F0-9]{2})+$/.test(quote.transactionRequest.data) ||
    (quote.estimate.approvalAddress &&
      (!isAddress(quote.estimate.approvalAddress) ||
        quote.estimate.approvalAddress === zeroAddress))
  ) {
    throw new Error(
      'LI.FI quote does not match this Base swap. Request a new quote.',
    );
  }
  const value = BigInt(quote.transactionRequest.value ?? '0');
  if (value < 0n || (from.address === zeroAddress && value < amount)) {
    throw new Error('Invalid LI.FI transaction value.');
  }
}

export async function fetchLifiQuote(
  wallet: Address,
  from: LifiAsset,
  to: LifiAsset,
  amount: bigint,
) {
  const params = new URLSearchParams({
    fromChain: String(base.id),
    toChain: String(base.id),
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
  validateLifiQuote(quote, wallet, from, to, amount);
  return quote;
}
