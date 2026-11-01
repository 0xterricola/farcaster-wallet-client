/**
 * A ticker's market, read from a public index — and every claim it must not make.
 *
 * The surfaces (`$TICKER` page, `/~/ca/<address>`, the composer's `$` typeahead,
 * the profile's token picker) draw whatever this reader answers with, so these
 * tests hold the answer itself to the honesty rules the file states:
 *
 *   - a symbol matches its own symbol (a prefix only while a ticker is being
 *     typed), so `$degen` never lands on `$DEGENX`;
 *   - an address is looked up by address, with no symbol guessing;
 *   - a field the index did not state is *absent* — never a zero that would read
 *     as a measurement;
 *   - an unreachable index is a refusal, never an empty success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyHostedRequest } from '~/snapchain/nodeApi/hostedRoutes';
import {
  answerTokenLinks,
  apiTokenLinkFromPair,
  clearMarketIndexCache,
  isContractAddress,
  marketIndexUrlFor,
  type MarketPair,
  matchingPairs,
  rankPairs,
  tokenLinksFromPairs,
} from '~/snapchain/providers/marketIndex';

const DEGEN_BASE = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';
const DEGEN_ROBINHOOD = '0x0830a9dd26a04e959657ab6788d45f5725590c32';
const OTHER = '0x0000000000000000000000000000000000000001';

const pair = (overrides: Partial<MarketPair> = {}): MarketPair => ({
  chainId: 'base',
  url: `https://dexscreener.com/base/${DEGEN_BASE}`,
  priceUsd: '0.001',
  marketCap: 34_000_000,
  liquidity: { usd: 500_000 },
  baseToken: { address: DEGEN_BASE, name: 'Degen', symbol: 'DEGEN' },
  ...overrides,
});

const jsonOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const tokensOf = (body: Record<string, unknown>): Record<string, unknown>[] =>
  (body.result as { tokens: Record<string, unknown>[] }).tokens;

const fetchAnswering = (pairs: MarketPair[], status = 200): typeof fetch =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(status === 200 ? { pairs } : {}), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

beforeEach(() => {
  clearMarketIndexCache();
});

describe('/v2/token-links is a market read, not the adapter’s fallback', () => {
  it('classifies as a market route, in its own words', () => {
    const route = classifyHostedRequest({
      method: 'GET',
      path: '/v2/token-links',
    });

    expect(route.kind).toBe('market');
    expect(route.why).toContain('public market index');
    expect(route.why).toContain('Dexscreener');
    // The sentence a reader was shown before this card: gone from this route.
    expect(route.why).not.toContain('no reader here answers it');
  });

  it('is read straight through the hosted-API path the client builds', () => {
    const route = classifyHostedRequest({
      method: 'GET',
      path: '/~api/v2/token-links',
    });

    expect(route.kind).toBe('market');
    expect(route.path).toBe('/v2/token-links');
  });
});

describe('which pairs a ticker means', () => {
  it('matches its own symbol exactly, and nothing that merely starts with it', () => {
    const pairs = [
      pair(),
      pair({
        chainId: 'base',
        baseToken: { address: OTHER, name: 'DegenX', symbol: 'DEGENX' },
      }),
    ];

    const matches = matchingPairs({ pairs, ticker: 'degen', intent: 'submit' });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.baseToken?.symbol).toBe('DEGEN');
  });

  it('matches a prefix only while a ticker is still being typed', () => {
    const pairs = [
      pair(),
      pair({
        chainId: 'base',
        baseToken: { address: OTHER, name: 'DegenX', symbol: 'DEGENX' },
      }),
    ];

    expect(
      matchingPairs({ pairs, ticker: 'deg', intent: 'submit' }),
    ).toHaveLength(0);
    expect(
      matchingPairs({ pairs, ticker: 'deg', intent: 'typeahead' }),
    ).toHaveLength(2);
  });

  it('ranks the chains this client trades on first, then real liquidity', () => {
    const onRobinhood = pair({
      chainId: 'robinhood',
      liquidity: { usd: 900_000 },
      baseToken: { address: DEGEN_ROBINHOOD, name: 'DEGEN', symbol: 'DEGEN' },
    });
    const thinOnBase = pair({ liquidity: { usd: 1_000 } });
    const fatOnBase = pair({
      liquidity: { usd: 400_000 },
      baseToken: { address: OTHER, name: 'Degen', symbol: 'DEGEN' },
    });

    const ranked = rankPairs([onRobinhood, thinOnBase, fatOnBase]);

    // Base first, however liquid the chain this client does not trade on is…
    expect(ranked[0]?.chainId).toBe('base');
    expect(ranked[1]?.chainId).toBe('base');
    // …then the deeper of the two Base markets.
    expect(ranked[0]?.baseToken?.address).toBe(OTHER);
    expect(ranked[2]?.chainId).toBe('robinhood');
  });
});

describe('a market as the hosted shapes', () => {
  it('carries every field the index stated', () => {
    const token = apiTokenLinkFromPair(
      pair({
        fdv: 1_000_000,
        volume: { h6: 10, h24: 20 },
        priceChange: { h6: -0.75, h24: -0.87 },
        info: {
          imageUrl: 'https://cdn.example/degen.png',
          websites: [{ url: 'https://degen.tips/', label: 'Website' }],
          socials: [{ url: 'https://x.com/degentokenbase', type: 'twitter' }],
        },
      }),
    );

    expect(token).toMatchObject({
      name: 'Degen',
      ticker: 'DEGEN',
      ca: DEGEN_BASE,
      chain: 'base',
      marketCap: 34_000_000,
      liquidity: 500_000,
      fdv: 1_000_000,
      priceUsd: '0.001',
      priceChangePct: { h6: -0.75, h24: -0.87 },
      volume: { h6: 10, h24: 20 },
      imageUrl: 'https://cdn.example/degen.png',
      urls: {
        website: 'https://degen.tips/',
        twitter: 'https://x.com/degentokenbase',
        dexscreener: `https://dexscreener.com/base/${DEGEN_BASE}`,
      },
    });
  });

  it('leaves out every field the index did not state, rather than zeroing it', () => {
    const token = apiTokenLinkFromPair(
      pair({
        priceUsd: undefined,
        marketCap: undefined,
        liquidity: undefined,
        info: undefined,
      }),
    );

    expect(token).not.toBeNull();
    expect(token).not.toHaveProperty('marketCap');
    expect(token).not.toHaveProperty('liquidity');
    expect(token).not.toHaveProperty('priceUsd');
    expect(token).not.toHaveProperty('fdv');
    expect(token).not.toHaveProperty('holderCount');
    expect(token).not.toHaveProperty('totalSupply');
    expect(token).not.toHaveProperty('description');
    expect(token).not.toHaveProperty('source');
    expect(token).not.toHaveProperty('verifications');
    expect(token).not.toHaveProperty('newsItems');
    expect(token).not.toHaveProperty('isHighRisk');
    expect(token).not.toHaveProperty('walletContext');
  });

  it('is nothing at all without an address or a symbol to name it by', () => {
    expect(
      apiTokenLinkFromPair(pair({ baseToken: { name: 'Degen' } })),
    ).toBeNull();
  });

  it('draws one row per market, not one per pair', () => {
    const sameMarketTwice = [
      pair(),
      pair({ liquidity: { usd: 100 } }),
      pair({
        chainId: 'base',
        baseToken: { address: OTHER, name: 'Other', symbol: 'DEGEN' },
      }),
    ];

    const { tokens, coins } = tokenLinksFromPairs({
      pairs: sameMarketTwice,
      ticker: 'degen',
    });

    expect(tokens).toHaveLength(2);
    // `coins` is Warpcast's own coin registry, which this client has no source
    // for: empty rather than a second copy of the same markets.
    expect(coins).toEqual([]);
  });
});

describe('what is asked of the index', () => {
  it('asks by symbol, with the `$` stripped', () => {
    expect(marketIndexUrlFor({ ticker: '$degen' })).toBe(
      'https://api.dexscreener.com/latest/dex/search?q=degen',
    );
  });

  it('asks by address when a reader pasted one', () => {
    expect(isContractAddress(DEGEN_BASE)).toBe(true);
    expect(isContractAddress('degen')).toBe(false);
    expect(marketIndexUrlFor({ ticker: DEGEN_BASE })).toBe(
      `https://api.dexscreener.com/latest/dex/tokens/${DEGEN_BASE}`,
    );
  });
});

describe('the answer a surface is handed', () => {
  it('answers a ticker with the markets that use it', async () => {
    const response = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'degen', intent: 'submit' }),
      fetchImpl: fetchAnswering([pair()]),
    });

    expect(response.status).toBe(200);
    const tokens = tokensOf(await jsonOf(response));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.ticker).toBe('DEGEN');
    expect(tokens[0]?.marketCap).toBe(34_000_000);
  });

  it('answers an address with the market that address really is', async () => {
    const response = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: DEGEN_BASE }),
      fetchImpl: fetchAnswering([pair()]),
    });

    const body = await jsonOf(response);
    expect(body.result).toEqual({
      tokens: [expect.objectContaining({ ca: DEGEN_BASE, chain: 'base' })],
      coins: [],
    });
  });

  it('answers a ticker no market uses with nothing, and asks nobody twice', async () => {
    const fetchImpl = fetchAnswering([pair()]);

    const first = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'degen' }),
      fetchImpl,
    });
    const second = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'degen', intent: 'submit' }),
      fetchImpl,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // One question, one request to a public API — the composer's typeahead asks
    // once per keystroke, and the cache is what keeps that honest.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const none = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'nosuchticker' }),
      fetchImpl: fetchAnswering([]),
    });
    expect(none.status).toBe(200);
    expect(await jsonOf(none)).toEqual({ result: { tokens: [], coins: [] } });
  });

  it('does not ask the index at all when there is no ticker to ask about', async () => {
    const fetchImpl = fetchAnswering([pair()]);

    const response = await answerTokenLinks({
      searchParams: new URLSearchParams({}),
      fetchImpl,
    });

    expect(await jsonOf(response)).toEqual({
      result: { tokens: [], coins: [] },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses in words when the index did not answer, never with an empty list', async () => {
    const response = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'degen' }),
      fetchImpl: fetchAnswering([], 500),
    });

    expect(response.status).toBe(502);
    const body = await jsonOf(response);
    const message = (body.errors as { message: string }[])[0]?.message ?? '';
    expect(message).toContain('Dexscreener');
    expect(message).toContain('did not answer');
    expect(message).toContain('nothing was invented');
  });

  it('says which failure it was when the index could not be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    }) as unknown as typeof fetch;

    const response = await answerTokenLinks({
      searchParams: new URLSearchParams({ ticker: 'degen' }),
      fetchImpl,
    });

    expect(response.status).toBe(502);
    const body = await jsonOf(response);
    const message = (body.errors as { message: string }[])[0]?.message ?? '';
    expect(message).toContain('ERR_NAME_NOT_RESOLVED');
  });
});
