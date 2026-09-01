import { zeroAddress } from 'viem';
import { arbitrum, bsc, celo, mainnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import {
  LifiQuote,
  toLifiSwapAsset,
  validateLifiQuote,
} from '~/utils/lifiSwap';
import {
  BASE_NATIVE_TOKEN,
  CELO_NATIVE_TOKEN_ADDRESS,
} from '~/utils/lifiWallet';
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
  it('translates only native Celo to LI.FI CeloToken', () => {
    const nativeCelo = { ...from, chainId: celo.id, symbol: 'CELO' };
    expect(toLifiSwapAsset(nativeCelo, celo)).toEqual({
      ...nativeCelo,
      address: CELO_NATIVE_TOKEN_ADDRESS,
    });
    expect(toLifiSwapAsset(from, mainnet)).toBe(from);
    expect(
      toLifiSwapAsset({ ...nativeCelo, address: to.address }, celo).address,
    ).toBe(to.address);
  });

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
    (q: LifiQuote) => {
      q.transactionRequest.gasPrice = '0x1';
      q.transactionRequest.maxFeePerGas = '0x2';
      q.transactionRequest.maxPriorityFeePerGas = '0x1';
    },
    (q: LifiQuote) => {
      q.transactionRequest.maxFeePerGas = '0x2';
    },
  ])('rejects mismatched or malformed quotes %#', (change) => {
    const q = makeQuote();
    change(q);
    expect(() => validateLifiQuote(q, wallet, from, to, 100n)).toThrow();
  });

  it('accepts a matching Ethereum same-chain swap and rejects Base metadata', () => {
    const ethereumFrom = { ...from, chainId: mainnet.id };
    const ethereumTo = { ...to, chainId: mainnet.id };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: mainnet.id,
      toChainId: mainnet.id,
      fromToken: ethereumFrom,
      toToken: ethereumTo,
    };
    quote.transactionRequest.chainId = mainnet.id;
    expect(() =>
      validateLifiQuote(quote, wallet, ethereumFrom, ethereumTo, 100n, mainnet),
    ).not.toThrow();
    expect(() => validateLifiQuote(quote, wallet, from, to, 100n)).toThrow(
      'Base swap',
    );
  });

  it('accepts a matching Arbitrum same-chain swap and rejects Base metadata', () => {
    const arbitrumFrom = { ...from, chainId: arbitrum.id };
    const arbitrumTo = { ...to, chainId: arbitrum.id };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: arbitrum.id,
      toChainId: arbitrum.id,
      fromToken: arbitrumFrom,
      toToken: arbitrumTo,
    };
    quote.transactionRequest.chainId = arbitrum.id;
    expect(() =>
      validateLifiQuote(
        quote,
        wallet,
        arbitrumFrom,
        arbitrumTo,
        100n,
        arbitrum,
      ),
    ).not.toThrow();
    expect(() => validateLifiQuote(quote, wallet, from, to, 100n)).toThrow(
      'Base swap',
    );
  });

  it('accepts a matching BSC same-chain swap and rejects Base metadata', () => {
    const bscFrom = { ...from, chainId: bsc.id, symbol: 'BNB' };
    const bscTo = { ...to, chainId: bsc.id, decimals: 18 };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: bsc.id,
      toChainId: bsc.id,
      fromToken: bscFrom,
      toToken: bscTo,
    };
    quote.transactionRequest.chainId = bsc.id;
    expect(() =>
      validateLifiQuote(quote, wallet, bscFrom, bscTo, 100n, bsc),
    ).not.toThrow();
    expect(() => validateLifiQuote(quote, wallet, from, to, 100n)).toThrow(
      'Base swap',
    );
  });

  it('accepts a matching Celo same-chain swap and rejects Base metadata', () => {
    const celoFrom = toLifiSwapAsset(
      { ...from, chainId: celo.id, symbol: 'CELO' },
      celo,
    );
    const celoTo = { ...to, chainId: celo.id };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: celo.id,
      toChainId: celo.id,
      fromToken: celoFrom,
      toToken: celoTo,
    };
    quote.transactionRequest.chainId = celo.id;
    expect(() =>
      validateLifiQuote(quote, wallet, celoFrom, celoTo, 100n, celo),
    ).not.toThrow();
    expect(() => validateLifiQuote(quote, wallet, from, to, 100n)).toThrow(
      'Base swap',
    );
  });
});
