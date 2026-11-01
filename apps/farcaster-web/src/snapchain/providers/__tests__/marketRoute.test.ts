/**
 * The token-market route through the provider seam.
 *
 * `/v2/token-links` is not a read any server in the catalog can answer — a node
 * keeps no markets, and Neynar's fungible reads take contract addresses rather
 * than a ticker (MEASURED 2026-10-24) — so the seam answers it from a public
 * market index *before* a provider is consulted, exactly the way it answers the
 * media pipeline and this device's own drafts.
 *
 * These tests hold that: the answer arrives with the live provider set to one
 * that could not answer it and has no key at all, no provider was asked, the
 * node adapter was never built, and the routing log says where the answer came
 * from.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogEntry } from '~/snapchain/nodeApi/nodeBackedFetch';
import { neynarProvider } from '~/snapchain/providers/catalog';
import {
  clearMarketIndexCache,
  type MarketPair,
} from '~/snapchain/providers/marketIndex';
import { createProviderBackedFetch } from '~/snapchain/providers/providerFetch';

const DEGEN_BASE = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';

const MARKET_BASE_URL = 'https://market.test';

const degenPair: MarketPair = {
  chainId: 'base',
  url: `https://dexscreener.com/base/${DEGEN_BASE}`,
  priceUsd: '0.00094',
  marketCap: 34_000_000,
  liquidity: { usd: 203_919 },
  baseToken: { address: DEGEN_BASE, name: 'DEGEN', symbol: 'DEGEN' },
};

beforeEach(() => {
  clearMarketIndexCache();
});

describe('/v2/token-links through the seam', () => {
  it('is answered by the market index, with no provider and no key involved', async () => {
    const asked: string[] = [];
    const marketFetch = vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ pairs: [degenPair] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const nodeAdapterFactory = vi.fn();

    const log: RequestLogEntry[] = [];
    const handle = createProviderBackedFetch({
      // The live provider is the one that could not have answered this: Neynar,
      // with no key of the reader's, which is a 501 for anything it is asked.
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: marketFetch,
      neynarApiKey: null,
      marketIndexBaseUrl: MARKET_BASE_URL,
      requestLog: log,
      createNodeAdapter:
        nodeAdapterFactory as unknown as typeof import('~/snapchain/nodeApi/nodeBackedFetch').createNodeBackedFetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/token-links?ticker=degen&intent=submit',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tokens: { ticker: string; ca: string }[]; coins: unknown[] };
    };
    expect(body.result.tokens).toHaveLength(1);
    expect(body.result.tokens[0]).toMatchObject({
      ticker: 'DEGEN',
      ca: DEGEN_BASE,
    });
    expect(body.result.coins).toEqual([]);

    // One request, to the market index — the only server asked.
    expect(asked).toEqual([`${MARKET_BASE_URL}/latest/dex/search?q=degen`]);
    // No node client was built, and no provider answered.
    expect(nodeAdapterFactory).not.toHaveBeenCalled();
    expect(log.at(-1)).toMatchObject({ kind: 'market', status: 200 });
  });

  it('refuses in words when the index did not answer, rather than 200 with nothing', async () => {
    const marketFetch = vi.fn(async () => {
      throw new Error('the market index answered 503');
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: marketFetch,
      neynarApiKey: null,
      marketIndexBaseUrl: MARKET_BASE_URL,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/token-links?ticker=degen',
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toContain('Dexscreener');
    expect(body.errors[0]?.message).toContain('nothing was invented');
  });
});
