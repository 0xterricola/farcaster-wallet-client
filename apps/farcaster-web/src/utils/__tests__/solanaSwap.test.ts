import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertFreshSolanaQuote,
  decodeLifiSolanaTransaction,
  estimatedSolanaNetworkFee,
  fetchLifiSolanaQuote,
  formatSolanaSwapUnits,
  isHighCostSolanaQuote,
  LifiSolanaQuote,
  SOLANA_NATIVE_MINT,
  SOLANA_USDC_MINT,
  validateLifiSolanaQuote,
} from '~/utils/solanaSwap';
import { LIFI_SOLANA_CHAIN_ID } from '~/utils/solanaWallet';

const wallet = '6k1HtMjnCjha272Z2rEg7vMK4CwxJVn34uMhdUTJmAuP';
const from = {
  amount: '25000000',
  decimals: 9,
  mint: SOLANA_NATIVE_MINT,
  name: 'Solana',
  symbol: 'SOL',
};

function transactionData(feePayer = wallet): string {
  const message = new TransactionMessage({
    instructions: [],
    payerKey: new PublicKey(feePayer),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).compileToV0Message();
  const bytes = new VersionedTransaction(message).serialize();
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
const to = {
  amount: '0',
  decimals: 6,
  mint: SOLANA_USDC_MINT,
  name: 'USD Coin',
  symbol: 'USDC',
};

function quote(overrides: Partial<LifiSolanaQuote> = {}): LifiSolanaQuote {
  return {
    action: {
      fromAddress: wallet,
      fromAmount: '10000000',
      fromChainId: LIFI_SOLANA_CHAIN_ID,
      fromToken: {
        address: SOLANA_NATIVE_MINT,
        chainId: LIFI_SOLANA_CHAIN_ID,
        decimals: 9,
        symbol: 'SOL',
      },
      slippage: 0.005,
      toAddress: wallet,
      toChainId: LIFI_SOLANA_CHAIN_ID,
      toToken: {
        address: SOLANA_USDC_MINT,
        chainId: LIFI_SOLANA_CHAIN_ID,
        decimals: 6,
        symbol: 'USDC',
      },
    },
    estimate: {
      gasCosts: [
        {
          amount: '39669',
          token: {
            address: SOLANA_NATIVE_MINT,
            chainId: LIFI_SOLANA_CHAIN_ID,
            decimals: 9,
            symbol: 'SOL',
          },
        },
      ],
      toAmount: '996569',
      toAmountMin: '991586',
    },
    tool: 'fly',
    transactionRequest: { data: transactionData() },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Solana LI.FI quotes', () => {
  it('requests and validates an exact same-chain quote', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(quote()), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await fetchLifiSolanaQuote(wallet, from, to, '0.01');

    expect(result.amount).toBe(10_000_000n);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('fromChain')).toBe(
      String(LIFI_SOLANA_CHAIN_ID),
    );
    expect(url.searchParams.get('fromToken')).toBe(SOLANA_NATIVE_MINT);
    expect(url.searchParams.get('toToken')).toBe(SOLANA_USDC_MINT);
    expect(url.searchParams.get('fromAddress')).toBe(wallet);
  });

  it('rejects a quote whose wallet, token, amount, or transaction changed', () => {
    const changed = [
      quote({ action: { ...quote().action, fromAddress: 'another-wallet' } }),
      quote({ action: { ...quote().action, fromAmount: '9999999' } }),
      quote({
        action: {
          ...quote().action,
          toToken: { ...quote().action.toToken, address: SOLANA_NATIVE_MINT },
        },
      }),
      quote({ transactionRequest: { data: 'not base64!' } }),
      quote({ estimate: { toAmount: '10', toAmountMin: '11' } }),
    ];
    for (const candidate of changed) {
      expect(() =>
        validateLifiSolanaQuote(candidate, wallet, from, to, 10_000_000n),
      ).toThrow('does not match this Solana swap');
    }
  });

  it('rejects same-asset and insufficient-balance requests before fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchLifiSolanaQuote(wallet, from, from, '0.01'),
    ).rejects.toThrow('different assets');
    await expect(fetchLifiSolanaQuote(wallet, from, to, '1')).rejects.toThrow(
      'Insufficient SOL balance',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('formats exact output units and the estimated SOL fee', () => {
    expect(formatSolanaSwapUnits('996569', 6)).toBe('0.996569');
    expect(formatSolanaSwapUnits('1000000', 6)).toBe('1');
    expect(estimatedSolanaNetworkFee(quote())).toBe('0.000039669');
  });

  it('requires the connected wallet to be the transaction fee payer', () => {
    expect(
      decodeLifiSolanaTransaction(transactionData(), wallet),
    ).toBeInstanceOf(Uint8Array);
    expect(() =>
      decodeLifiSolanaTransaction(
        transactionData(Keypair.generate().publicKey.toBase58()),
        wallet,
      ),
    ).toThrow('invalid Solana transaction');
  });

  it('accepts only the same route with an equal or better refreshed minimum', () => {
    const reviewed = quote();
    expect(() => assertFreshSolanaQuote(reviewed, quote())).not.toThrow();
    expect(() =>
      assertFreshSolanaQuote(
        reviewed,
        quote({ estimate: { toAmount: '996569', toAmountMin: '991585' } }),
      ),
    ).toThrow('Quote changed');
    expect(() =>
      assertFreshSolanaQuote(reviewed, quote({ tool: 'another-route' })),
    ).toThrow('Quote changed');
  });

  it('identifies quotes whose network fee exceeds their output value', () => {
    expect(
      isHighCostSolanaQuote(
        quote({
          estimate: {
            gasCosts: [{ amountUSD: '0.003' }],
            toAmount: '1000',
            toAmountMin: '995',
            toAmountUSD: '0.002',
          },
        }),
      ),
    ).toBe(true);
    expect(isHighCostSolanaQuote(quote())).toBe(false);
  });
});
