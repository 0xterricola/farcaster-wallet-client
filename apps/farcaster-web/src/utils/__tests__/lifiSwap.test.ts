import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { LifiQuote, validateLifiQuote } from '~/utils/lifiSwap';
import { BASE_NATIVE_TOKEN } from '~/utils/lifiWallet';
const wallet = '0x1111111111111111111111111111111111111111';
const from = { ...BASE_NATIVE_TOKEN, balance: 1000n };
const to = {
  ...from,
  address: '0x2222222222222222222222222222222222222222' as const,
  decimals: 6,
};
const makeQuote = (): LifiQuote => ({
  tool: 'test',
  action: {
    fromChainId: 8453,
    toChainId: 8453,
    fromAddress: wallet,
    toAddress: wallet,
    fromAmount: '100',
    fromToken: from,
    toToken: to,
  },
  estimate: { toAmount: '1000', toAmountMin: '990' },
  transactionRequest: {
    chainId: 8453,
    from: wallet,
    to: to.address,
    data: '0xabcd',
    value: '0x64',
  },
});
describe('LI.FI quote validation', () => {
  it('accepts a matching same-chain swap', () =>
    expect(() =>
      validateLifiQuote(makeQuote(), wallet, from, to, 100n),
    ).not.toThrow());
  it.each([
    (q: LifiQuote) => {
      q.action.toChainId = 1;
    },
    (q: LifiQuote) => {
      q.action.toAddress = to.address;
    },
    (q: LifiQuote) => {
      q.action.fromAmount = '101';
    },
    (q: LifiQuote) => {
      q.action.toToken = { ...to, decimals: 18 };
    },
    (q: LifiQuote) => {
      q.action.fromToken = { ...from, address: to.address };
    },
    (q: LifiQuote) => {
      q.estimate.toAmountMin = '0';
    },
    (q: LifiQuote) => {
      q.estimate.toAmountMin = '1001';
    },
    (q: LifiQuote) => {
      q.transactionRequest.chainId = 1;
    },
    (q: LifiQuote) => {
      q.transactionRequest.from = to.address;
    },
    (q: LifiQuote) => {
      q.transactionRequest.to = zeroAddress;
    },
    (q: LifiQuote) => {
      q.estimate.approvalAddress = zeroAddress;
    },
    (q: LifiQuote) => {
      q.transactionRequest.value = '0x01';
    },
  ])('rejects mismatched or malformed quotes %#', (change) => {
    const q = makeQuote();
    change(q);
    expect(() => validateLifiQuote(q, wallet, from, to, 100n)).toThrow();
  });
});
