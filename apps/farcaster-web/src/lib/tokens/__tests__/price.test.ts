import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bestSymbolMatch,
  clearPriceCache,
  formatUsdPrice,
  lookupTokenPrice,
} from '~/lib/tokens/price';

const pair = (overrides: Record<string, unknown> = {}) => ({
  chainId: 'base',
  url: 'https://dexscreener.com/base/0xabc',
  priceUsd: '0.0123',
  liquidity: { usd: 1000 },
  baseToken: { symbol: 'DEGEN', address: '0xabc' },
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }) as unknown as Response;

beforeEach(() => {
  clearPriceCache();
});

describe('a price for a cast’s cashtag', () => {
  it('asks by contract address when the cast knew one, and picks the deepest market', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      jsonResponse({
        pairs: [
          pair({ priceUsd: '0.01', liquidity: { usd: 10 } }),
          pair({ priceUsd: '0.02', liquidity: { usd: 999_999 } }),
        ],
      }),
    );

    const result = await lookupTokenPrice(
      { ticker: 'degen', address: '0xAbC', chain: 'base' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.reason).toBeNull();
    expect(result.price?.usd).toBe(0.02);
    expect(result.price?.chainId).toBe('base');
    expect(result.price?.url).toContain('dexscreener.com');
    expect(fetchImpl.mock.calls[0]![0]).toContain('/latest/dex/tokens/0xAbC');
  });

  it('asks by ticker when there is no address, and says which market it picked', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      jsonResponse({
        pairs: [
          pair({ chainId: 'polygon', liquidity: { usd: 10_000_000 } }),
          pair({ chainId: 'base', liquidity: { usd: 5 } }),
        ],
      }),
    );

    const result = await lookupTokenPrice(
      { ticker: '$DEGEN' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.price?.chainId).toBe('base');
    expect(fetchImpl.mock.calls[0]![0]).toContain('/latest/dex/search?q=DEGEN');
  });

  it('does not imply a ticker is unique: a different $DOGE is refused in words', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ pairs: [pair({ baseToken: { symbol: 'SHIB' } })] }),
    );

    const result = await lookupTokenPrice(
      { ticker: 'DOGE' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.price).toBeNull();
    expect(result.reason).toMatch(/no market with the ticker \$DOGE/);
    expect(result.reason).toMatch(/other \$DOGE tokens exist/);
  });

  it('answers honestly when the market exists but quotes nothing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ pairs: [pair({ priceUsd: 'not a number' })] }),
    );

    const result = await lookupTokenPrice(
      { ticker: 'DEGEN' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.reason).toMatch(/did not quote a price/);
  });

  it('answers honestly when there is no market at all', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pairs: [] }));

    const result = await lookupTokenPrice(
      { ticker: 'NOPE' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.price).toBeNull();
    expect(result.reason).toBe('no market was found for $NOPE');
  });

  it('answers honestly when the service refuses or cannot be reached', async () => {
    const refused = await lookupTokenPrice(
      { ticker: 'DEGEN' },
      {
        fetchImpl: (async () =>
          jsonResponse({}, 429)) as unknown as typeof fetch,
      },
    );

    expect(refused.reason).toMatch(/could not be reached/);

    clearPriceCache();

    const unreachable = await lookupTokenPrice(
      { ticker: 'DEGEN' },
      {
        fetchImpl: (async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
      },
    );

    expect(unreachable.reason).toMatch(/could not be reached/);
  });

  it('names a timeout as a timeout', async () => {
    const result = await lookupTokenPrice(
      { ticker: 'DEGEN' },
      {
        fetchImpl: (async () => {
          throw new Error('The operation was aborted due to timeout');
        }) as unknown as typeof fetch,
      },
    );

    expect(result.reason).toMatch(/did not answer in time/);
  });

  it('caches for a minute, and re-asks after it', async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => jsonResponse({ pairs: [pair()] }));
    const options = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
      ttlMs: 60_000,
    };

    await lookupTokenPrice({ ticker: 'DEGEN' }, options);
    await lookupTokenPrice({ ticker: 'DEGEN' }, options);

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 60_001;

    await lookupTokenPrice({ ticker: 'DEGEN' }, options);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks once when a feed renders the same cashtag twenty times at once', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pairs: [pair()] }));

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        lookupTokenPrice(
          { ticker: 'DEGEN' },
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.price?.usd === 0.0123)).toBe(true);
  });

  it('says so when there is no ticker to look up', async () => {
    const result = await lookupTokenPrice({ ticker: '  ' });

    expect(result.reason).toMatch(/no ticker/);
  });

  it('never throws, whatever the service does', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('weird');

      throw error;
    });

    await expect(
      lookupTokenPrice(
        { ticker: 'DEGEN' },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toEqual({
      price: null,
      reason: 'the price service could not be reached',
    });
  });
});

describe('bestSymbolMatch', () => {
  it('knows which chains this client’s readers trade on', () => {
    const chosen = bestSymbolMatch(
      [
        pair({ chainId: 'polygon' }),
        pair({ chainId: 'solana' }),
        pair({ chainId: 'base' }),
      ],
      'DEGEN',
    );

    expect(chosen?.chainId).toBe('base');
  });

  it('falls back to depth on an unknown chain, and to nothing with no match', () => {
    const chosen = bestSymbolMatch(
      [
        pair({ chainId: 'somewhere', liquidity: { usd: 5 } }),
        pair({ chainId: 'elsewhere', liquidity: { usd: 50 } }),
      ],
      'DEGEN',
    );

    expect(chosen?.chainId).toBe('elsewhere');
    expect(bestSymbolMatch([pair()], 'SHIB')).toBeNull();
    expect(bestSymbolMatch([], 'DEGEN')).toBeNull();
  });
});

describe('formatting a price a person reads at a glance', () => {
  it('keeps small numbers visible instead of rounding them to nothing', () => {
    expect(formatUsdPrice(1234.5678)).toBe('$1,235');
    expect(formatUsdPrice(12.5)).toBe('$12.50');
    expect(formatUsdPrice(0.012345)).toBe('$0.0123');
    expect(formatUsdPrice(0.00012345)).toBe('$0.000123');
    expect(formatUsdPrice(0.000012345)).toMatch(/^\$0\.0000123/);
    expect(formatUsdPrice(0.0000004212)).toBe('$0.00000042');
  });

  it('shows a dash rather than a fake number', () => {
    expect(formatUsdPrice(0)).toBe('—');
    expect(formatUsdPrice(Number.NaN)).toBe('—');
    expect(formatUsdPrice(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
