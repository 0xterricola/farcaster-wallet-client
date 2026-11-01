import { hyperevm, robinhood } from 'farcaster-client-data';
import { zeroAddress } from 'viem';
import {
  arbitrum,
  base,
  bsc,
  celo,
  mainnet,
  monad,
  polygon,
} from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchLifiTransferStatus,
  LIFI_DIAMOND,
  lifiMoveErrorMessage,
  LifiQuote,
  parseLifiTransferStatus,
  readLifiQuoteCost,
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

  it('accepts a matching Monad native same-chain swap', () => {
    const monadFrom = { ...from, chainId: monad.id, symbol: 'MON' };
    const monadTo = { ...to, chainId: monad.id };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: monad.id,
      toChainId: monad.id,
      fromToken: monadFrom,
      toToken: monadTo,
    };
    quote.transactionRequest.chainId = monad.id;
    expect(() =>
      validateLifiQuote(quote, wallet, monadFrom, monadTo, 100n, monad),
    ).not.toThrow();
  });

  it('accepts a matching HyperEVM native same-chain swap', () => {
    const hypeFrom = { ...from, chainId: hyperevm.id, symbol: 'HYPE' };
    const hyperEvmTo = { ...to, chainId: hyperevm.id };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: hyperevm.id,
      toChainId: hyperevm.id,
      fromToken: hypeFrom,
      toToken: hyperEvmTo,
    };
    quote.transactionRequest.chainId = hyperevm.id;
    expect(() =>
      validateLifiQuote(quote, wallet, hypeFrom, hyperEvmTo, 100n, hyperevm),
    ).not.toThrow();
  });

  it('accepts a matching Robinhood Chain native same-chain swap', () => {
    const robinhoodFrom = { ...from, chainId: robinhood.id, symbol: 'ETH' };
    const robinhoodTo = { ...to, chainId: robinhood.id, symbol: 'USDG' };
    const quote = makeQuote();
    quote.action = {
      ...quote.action,
      fromChainId: robinhood.id,
      toChainId: robinhood.id,
      fromToken: robinhoodFrom,
      toToken: robinhoodTo,
    };
    quote.transactionRequest.chainId = robinhood.id;
    expect(() =>
      validateLifiQuote(
        quote,
        wallet,
        robinhoodFrom,
        robinhoodTo,
        100n,
        robinhood,
      ),
    ).not.toThrow();
  });
});

// A move that lands somewhere else. Adapted from quilcast `5e4759372ed0` (MIT),
// where a quote is refused unless the transaction runs through LI.FI's own
// contract on the chain the sold token lives on. The clauses here keep that one
// and add the destination chain, the receiver, this wallet's chain set and the
// arrival side of the trade.
describe('cross-chain move validation', () => {
  const arbUsdc = { ...to, chainId: arbitrum.id, symbol: 'USDC' };
  const otherWallet = '0x3333333333333333333333333333333333333333' as const;
  const moveQuote = (): LifiQuote => ({
    tool: 'relaydepository',
    toolDetails: { name: 'Relay' },
    action: {
      fromChainId: base.id,
      toChainId: arbitrum.id,
      fromAddress: wallet,
      toAddress: wallet,
      fromAmount: '100',
      fromToken: from,
      toToken: arbUsdc,
    },
    estimate: {
      toAmount: '1000',
      toAmountMin: '990',
      approvalAddress: LIFI_DIAMOND[base.id],
      executionDuration: 61,
      fromAmountUSD: '2.4023',
      toAmountUSD: '2.3678',
      gasCosts: [{ amountUSD: '0.0019' }],
      feeCosts: [
        { amountUSD: '0.0060', included: true },
        { amountUSD: '0.0029', included: false },
      ],
    },
    transactionRequest: {
      chainId: base.id,
      from: wallet,
      to: LIFI_DIAMOND[base.id]!,
      data: '0xabcd',
      value: '0x64',
    },
  });
  const move = (quote: LifiQuote) =>
    validateLifiQuote(quote, wallet, from, arbUsdc, 100n, base, arbitrum);

  it('accepts a move that routes through the sell chain’s LI.FI contract', () => {
    expect(() => move(moveQuote())).not.toThrow();
  });

  it('refuses that same quote when it is asked for as a Base swap', () => {
    expect(() =>
      validateLifiQuote(moveQuote(), wallet, from, to, 100n),
    ).toThrow('Base swap');
  });

  it('accepts a move out of a chain whose entry contract is its own', () => {
    const hype = { ...from, chainId: hyperevm.id, symbol: 'HYPE' };
    const quote = moveQuote();
    quote.action = {
      ...quote.action,
      fromChainId: hyperevm.id,
      toChainId: base.id,
      fromToken: hype,
      toToken: to,
    };
    quote.estimate.approvalAddress = LIFI_DIAMOND[hyperevm.id];
    quote.transactionRequest = {
      ...quote.transactionRequest,
      chainId: hyperevm.id,
      to: LIFI_DIAMOND[hyperevm.id]!,
    };
    expect(() =>
      validateLifiQuote(quote, wallet, hype, to, 100n, hyperevm, base),
    ).not.toThrow();
  });

  it('refuses a destination chain this wallet cannot read, by name', () => {
    const quote = moveQuote();
    quote.action.toChainId = polygon.id;
    quote.action.toToken = { ...arbUsdc, chainId: polygon.id };
    expect(() =>
      validateLifiQuote(quote, wallet, from, arbUsdc, 100n, base, polygon),
    ).toThrow('moves to Polygon are not supported');
  });

  it('refuses a route that does not go through LI.FI’s contract', () => {
    const quote = moveQuote();
    quote.transactionRequest.to = otherWallet;
    expect(() => move(quote)).toThrow(
      "the route does not go through LI.FI's Base contract",
    );
  });

  it('refuses an approval that is not for LI.FI’s contract', () => {
    const quote = moveQuote();
    quote.estimate.approvalAddress = otherWallet;
    expect(() => move(quote)).toThrow(
      "the approval is not for LI.FI's Base contract",
    );
  });

  it('refuses a minimum receive above the quoted receive', () => {
    const quote = moveQuote();
    quote.estimate.toAmountMin = '1001';
    expect(() => move(quote)).toThrow(
      'the minimum receive is not below the quote',
    );
  });

  it('refuses a native sell whose value does not cover the amount', () => {
    const quote = moveQuote();
    quote.transactionRequest.value = '0x01';
    expect(() => move(quote)).toThrow(
      'the transaction value does not cover the amount being sold',
    );
  });

  it('refuses a move that arrives anywhere but this wallet', () => {
    const quote = moveQuote();
    quote.action.toAddress = otherWallet;
    expect(() => move(quote)).toThrow('the receiver is not this wallet');
  });

  it('refuses a transaction that would be signed on the destination chain', () => {
    const quote = moveQuote();
    quote.transactionRequest.chainId = arbitrum.id;
    expect(() => move(quote)).toThrow(
      'the transaction is for chain 42161, not 8453',
    );
  });

  it('refuses a sell token that does not live on the sell chain', () => {
    const quote = moveQuote();
    quote.action.fromToken = { ...from, chainId: arbitrum.id };
    expect(() => move(quote)).toThrow('the sold token is not a Base token');
  });
});

describe('what a route costs and how long it takes', () => {
  it('reads the route, the time, the fees and both sides in dollars', () => {
    const quote = makeQuote();
    quote.tool = 'relaydepository';
    quote.toolDetails = { name: 'Relay' };
    quote.estimate = {
      ...quote.estimate,
      executionDuration: 61,
      fromAmountUSD: '2.4023',
      toAmountUSD: '2.3678',
      gasCosts: [{ amountUSD: '0.0019' }],
      feeCosts: [
        { amountUSD: '0.0060', included: true },
        { amountUSD: '0.0029', included: false },
      ],
    };
    const cost = readLifiQuoteCost(quote);
    expect(cost.tool).toBe('Relay');
    expect(cost.seconds).toBe(61);
    // Gas, plus only the fee the route does not already take out of the sold
    // amount: a fee marked `included` is not an extra cost.
    expect(cost.feesUsd).toBeCloseTo(0.0048, 6);
    expect(cost.fromUsd).toBe(2.4023);
    expect(cost.toUsd).toBe(2.3678);
  });

  it('says nothing at all when LI.FI reported nothing', () => {
    expect(readLifiQuoteCost(makeQuote())).toEqual({
      tool: 'test',
      seconds: undefined,
      feesUsd: undefined,
      fromUsd: undefined,
      toUsd: undefined,
    });
  });

  it('drops a zero or unreadable number instead of printing it', () => {
    const quote = makeQuote();
    quote.estimate = {
      ...quote.estimate,
      executionDuration: Number.NaN,
      fromAmountUSD: '0',
      toAmountUSD: '',
      gasCosts: [{ amountUSD: '0.0000' }, { amountUSD: 'n/a' }],
      feeCosts: [{ amountUSD: '0' }],
    };
    expect(readLifiQuoteCost(quote)).toEqual({
      tool: 'test',
      seconds: undefined,
      feesUsd: undefined,
      fromUsd: undefined,
      toUsd: undefined,
    });
  });
});

describe('where a sent move is', () => {
  const receivingHash = `0x${'b'.repeat(64)}` as const;
  const sendingHash = `0x${'a'.repeat(64)}` as const;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('counts a completed fill as arrived, with the arrival transaction', () => {
    expect(
      parseLifiTransferStatus({
        status: 'DONE',
        substatus: 'COMPLETED',
        sending: { txHash: sendingHash },
        receiving: { txHash: receivingHash },
      }),
    ).toEqual({
      state: 'arrived',
      sendingTxHash: sendingHash,
      receivingTxHash: receivingHash,
    });
  });

  it('reads a refunded or partial fill as a problem, not an arrival', () => {
    expect(
      parseLifiTransferStatus({ status: 'DONE', substatus: 'REFUNDED' }).state,
    ).toBe('failed');
    expect(
      parseLifiTransferStatus({ status: 'DONE', substatus: 'PARTIAL' }).state,
    ).toBe('failed');
  });

  it('reads FAILED as a problem and keeps the transaction hashes', () => {
    expect(
      parseLifiTransferStatus({
        status: 'FAILED',
        sending: { txHash: sendingHash },
      }),
    ).toEqual({
      state: 'failed',
      sendingTxHash: sendingHash,
      receivingTxHash: undefined,
    });
  });

  it('keeps waiting for PENDING, an unindexed transfer and nonsense', () => {
    expect(parseLifiTransferStatus({ status: 'PENDING' }).state).toBe(
      'waiting',
    );
    expect(
      parseLifiTransferStatus({
        message: "Transaction hash '0xaa' not found on chain '8453'",
        code: 1003,
      }).state,
    ).toBe('waiting');
    expect(parseLifiTransferStatus('nonsense').state).toBe('waiting');
    expect(parseLifiTransferStatus(undefined).state).toBe('waiting');
  });

  it('asks LI.FI about the move on the wire', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'PENDING' }),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchLifiTransferStatus(sendingHash, base.id, arbitrum.id),
    ).resolves.toEqual({
      state: 'waiting',
      sendingTxHash: undefined,
      receivingTxHash: undefined,
    });
    expect(fetch.mock.calls[0][0]).toBe(
      `https://li.quest/v1/status?txHash=${sendingHash}&fromChain=8453&toChain=42161`,
    );
  });

  it('reads a transfer LI.FI has not indexed yet as not-yet, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: 'not found on chain 8453', code: 1003 }),
      }),
    );
    await expect(
      fetchLifiTransferStatus(sendingHash, base.id, arbitrum.id),
    ).resolves.toEqual({
      state: 'waiting',
      sendingTxHash: undefined,
      receivingTxHash: undefined,
    });
  });
});

describe('a route LI.FI could not build', () => {
  it('is said in words a person can act on', () => {
    expect(
      lifiMoveErrorMessage(
        'LI.FI request failed (404). No available quotes for the requested transfer. Please try again.',
        'Arbitrum One',
      ),
    ).toBe(
      'No route can move this to Arbitrum One right now. Try a different amount, token, or network.',
    );
  });

  it('shows anything else exactly as it arrived', () => {
    expect(
      lifiMoveErrorMessage(
        'LI.FI is rate limiting requests. Please try again shortly.',
        'Base',
      ),
    ).toBe('LI.FI is rate limiting requests. Please try again shortly.');
  });
});
