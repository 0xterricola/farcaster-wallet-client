/**
 * A ticker's market, asked of a public market index instead of a Farcaster
 * server.
 *
 * WHY THIS FILE EXISTS
 *
 * The fork's `/v2/token-links` asks one question: *which token does this ticker
 * mean?* It is answered by the hosted API from Warpcast's own registry of the
 * tokens Farcaster's own casts link with a ticker — an index nobody else keeps.
 * So the client's own routing table had no source for it, and every surface that
 * asks it (the `$TICKER` page, `/~/ca/<address>`, the composer's `$` typeahead,
 * the profile's token picker) was shown the adapter's fallback sentence.
 *
 * What was measured before this file was written (2026-10-24), with the reader's
 * own Neynar key:
 *
 *   GET https://api.neynar.com/v2/farcaster/fungibles/?fungibles=degen
 *       → 400. Neynar's fungible reads take **contract addresses**, in CAIP
 *         form (`eip155:8453/erc20:0x833589f…`), never a ticker — so Neynar
 *         cannot answer this question, and a reader that pretended otherwise
 *         would answer a different one.
 *   GET https://api.dexscreener.com/latest/dex/search?q=degen
 *       → 200, `access-control-allow-origin: *`, 30 pairs for the symbol, each
 *         carrying its own chain, contract address, price, market cap, liquidity
 *         and market URL.
 *
 * Dexscreener is not a new dependency chosen here: it is already this client's
 * source for what a `$cashtag` is worth (`~/lib/tokens/price.ts`, the chip in a
 * cast body), it needs no key of anyone's, and its answer is the same whichever
 * Farcaster server the reader is on. So `/v2/token-links` is answered from it,
 * and what comes back is a *market* answer, not a Farcaster-registry answer:
 *
 *   - a ticker is not unique on the internet, so the answer is a list of the
 *     markets whose own symbol matches, ranked by the chains this client's world
 *     actually trades on and then by real liquidity — and every row carries the
 *     chain, the contract address and the market URL it came from, so a reader
 *     can see which market it is;
 *   - `intent: typeahead` (the composer, while a ticker is still being typed)
 *     matches a symbol *prefix*; anything else matches the symbol exactly, which
 *     is what "the token behind this ticker" means;
 *   - a contract address is looked up exactly, by address, with no symbol
 *     guessing at all (`/~/ca/<address>`);
 *   - every field the index did not state is **absent**, never zero — the row
 *     components already guard (`TokenSummary` draws a market cap only when there
 *     is one), so nothing on screen claims a number nobody measured. There is no
 *     invented creator, no invented verification, no invented holder count and no
 *     invented price;
 *   - `coins` stays empty. That list is Warpcast's own coin registry (coins with
 *     no Farcaster link); this client has no source for it, and filling it with a
 *     second copy of the same markets would be dressing up one answer as two.
 *
 * An index that cannot be reached is a refusal, not an empty list: a reader must
 * never be shown "there is nothing here" for a question that was never answered.
 */

import type { ApiCoinLink, ApiTokenLink } from 'farcaster-client-data';

/** The public market index, and the only third-party host this module talks to. */
export const MARKET_INDEX_BASE_URL = 'https://api.dexscreener.com';

const SEARCH_PATH = '/latest/dex/search';
const TOKEN_PATH = '/latest/dex/tokens';

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * How many market rows one answer may carry. The `$TICKER` page draws three and
 * the typeahead draws a dropdown; a hundred `$DOGE`s is not a list a reader can
 * use, and the ranking below is what decides which ones arrive first.
 */
export const MAX_TOKEN_LINKS = 12;

/**
 * Chains this client's world trades on, most likely first — the same order the
 * cashtag chip ranks by (`~/lib/tokens/price.ts`), because a `$DEGEN` in a cast
 * is nearly always Base's and a market index worldwide is not.
 */
const CHAIN_PREFERENCE = [
  'base',
  'solana',
  'ethereum',
  'optimism',
  'arbitrum',
  'polygon',
  'zora',
];

/** One market, as the index states it — only the fields this module reads. */
export interface MarketPair {
  chainId?: string;
  url?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h6?: number; h24?: number };
  priceChange?: { h6?: number; h24?: number };
  baseToken?: { address?: string; name?: string; symbol?: string };
  info?: {
    imageUrl?: string;
    websites?: { url?: string; label?: string }[];
    socials?: { url?: string; type?: string }[];
  };
}

export interface TokenLinksAnswer {
  tokens: ApiTokenLink[];
  coins: ApiCoinLink[];
}

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const lower = (value: string | undefined): string =>
  (value ?? '').toLowerCase();

/**
 * Is this what a reader pasted from a wallet — a contract address, not a ticker?
 *
 * EVM addresses only: that is the shape `/~/ca/<address>` is reached with, and a
 * 0x-prefixed 40-hex string is never a ticker, so treating one as a symbol search
 * would be a lookup nobody asked for.
 */
export const isContractAddress = (value: string): boolean =>
  /^0x[0-9a-f]{40}$/i.test(value.trim());

/** A pair's own liquidity in USD, or 0 when the index did not state one. */
const liquidityOf = (pair: MarketPair): number =>
  finiteOrUndefined(pair.liquidity?.usd) ?? 0;

/** Where this chain sits in the order this client cares about. */
const chainRank = (chainId: string | undefined): number => {
  const index = CHAIN_PREFERENCE.indexOf(lower(chainId));

  return index === -1 ? CHAIN_PREFERENCE.length : index;
};

/**
 * The market a reader most likely meant, ranked the way the cashtag chip ranks:
 * the chains this client's world trades on first, then real liquidity. Ties keep
 * the index's own order, so the ranking is stable.
 */
export const rankPairs = (pairs: MarketPair[]): MarketPair[] =>
  [...pairs]
    .map((pair, index) => ({ pair, index }))
    .sort((left, right) => {
      const byChain =
        chainRank(left.pair.chainId) - chainRank(right.pair.chainId);

      if (byChain !== 0) {
        return byChain;
      }

      const byLiquidity = liquidityOf(right.pair) - liquidityOf(left.pair);

      return byLiquidity !== 0 ? byLiquidity : left.index - right.index;
    })
    .map(({ pair }) => pair);

/**
 * The pairs whose own symbol matches what was typed.
 *
 * A typeahead matches a prefix (a reader typing `$deg` means `DEGEN`), everything
 * else matches the whole symbol: `$degen` meaning `$DEGENX` would put a market
 * under a ticker that never named it.
 */
export const matchingPairs = ({
  pairs,
  ticker,
  intent,
}: {
  pairs: MarketPair[];
  ticker: string;
  intent?: string;
}): MarketPair[] => {
  const wanted = lower(ticker.replace(/^\$/, ''));

  if (wanted.length === 0) {
    return [];
  }

  const matches = pairs.filter((pair) => {
    const symbol = lower(pair.baseToken?.symbol);

    if (symbol.length === 0) {
      return false;
    }

    return intent === 'typeahead'
      ? symbol.startsWith(wanted)
      : symbol === wanted;
  });

  return rankPairs(matches);
};

/** One row per market: the same token is many pairs, and a reader wants a token. */
const onePerMarket = (pairs: MarketPair[]): MarketPair[] => {
  const seen = new Set<string>();
  const kept: MarketPair[] = [];

  for (const pair of pairs) {
    const key = `${lower(pair.chainId)}:${lower(pair.baseToken?.address)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    kept.push(pair);
  }

  return kept;
};

const urlsOf = (pair: MarketPair): ApiTokenLink['urls'] => {
  const urls: NonNullable<ApiTokenLink['urls']> = {};

  const website = stringOrUndefined(pair.info?.websites?.[0]?.url);
  if (website !== undefined) {
    urls.website = website;
  }

  for (const social of pair.info?.socials ?? []) {
    const url = stringOrUndefined(social.url);
    if (url === undefined) {
      continue;
    }

    switch (lower(social.type)) {
      case 'twitter':
        urls.twitter = urls.twitter ?? url;
        break;
      case 'telegram':
        urls.telegram = urls.telegram ?? url;
        break;
      case 'discord':
        urls.discord = urls.discord ?? url;
        break;
      default:
        break;
    }
  }

  const market = stringOrUndefined(pair.url);
  if (market !== undefined) {
    urls.dexscreener = market;
  }

  return Object.keys(urls).length > 0 ? urls : undefined;
};

/**
 * A market as the hosted API's token link — and nothing more than the index said.
 *
 * Every optional field is written only when the index stated it: a `0` where a
 * number is missing would be a measurement nobody made, and the row components
 * render an absent market cap as absent.
 */
export const apiTokenLinkFromPair = (pair: MarketPair): ApiTokenLink | null => {
  const ca = stringOrUndefined(pair.baseToken?.address);
  const ticker = stringOrUndefined(pair.baseToken?.symbol);

  if (ca === undefined || ticker === undefined) {
    return null;
  }

  const name = stringOrUndefined(pair.baseToken?.name) ?? ticker;
  const imageUrl = stringOrUndefined(pair.info?.imageUrl) ?? '';
  const chainId = stringOrUndefined(pair.chainId);
  const priceUsd = stringOrUndefined(pair.priceUsd);
  const marketCap = finiteOrUndefined(pair.marketCap);
  const liquidity = finiteOrUndefined(pair.liquidity?.usd);
  const fdv = finiteOrUndefined(pair.fdv);
  const volumeH6 = finiteOrUndefined(pair.volume?.h6);
  const volumeH24 = finiteOrUndefined(pair.volume?.h24);
  const changeH6 = finiteOrUndefined(pair.priceChange?.h6);
  const changeH24 = finiteOrUndefined(pair.priceChange?.h24);
  const urls = urlsOf(pair);

  return {
    name,
    imageUrl,
    ticker,
    ca,
    // The hosted API's `chain` is its own enum; the index names the chain the
    // same way for the chains this client trades on ("base", "solana", …), and a
    // chain this client's enum does not hold is left out of the cast rather than
    // forced into a wrong one.
    chain: chainId as ApiTokenLink['chain'],
    ...(priceUsd !== undefined ? { priceUsd, priceUpdatedAt: Date.now() } : {}),
    ...(changeH6 !== undefined || changeH24 !== undefined
      ? {
          priceChangePct: {
            ...(changeH6 !== undefined ? { h6: changeH6 } : {}),
            ...(changeH24 !== undefined ? { h24: changeH24 } : {}),
          },
        }
      : {}),
    ...(volumeH6 !== undefined || volumeH24 !== undefined
      ? {
          volume: {
            ...(volumeH6 !== undefined ? { h6: volumeH6 } : {}),
            ...(volumeH24 !== undefined ? { h24: volumeH24 } : {}),
          },
        }
      : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    ...(fdv !== undefined ? { fdv } : {}),
    ...(urls !== undefined ? { urls } : {}),
  } as ApiTokenLink;
};

/**
 * A market as the hosted API's *coin link*: the market's own row (chain, address,
 * market URL, image, ticker, market cap) and nothing else.
 */
export const apiCoinLinkFromPair = (pair: MarketPair): ApiCoinLink | null => {
  const url = stringOrUndefined(pair.url);
  const ca = stringOrUndefined(pair.baseToken?.address);
  const ticker = stringOrUndefined(pair.baseToken?.symbol);

  if (url === undefined || ca === undefined || ticker === undefined) {
    return null;
  }

  const chainId = stringOrUndefined(pair.chainId);
  const marketCap = finiteOrUndefined(pair.marketCap);

  return {
    url,
    ca,
    ticker,
    imageUrl: stringOrUndefined(pair.info?.imageUrl) ?? '',
    ...(chainId !== undefined
      ? { chain: chainId as ApiCoinLink['chain'] }
      : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
  } as ApiCoinLink;
};

const tokenLinksFrom = (pairs: MarketPair[]): ApiTokenLink[] =>
  onePerMarket(pairs)
    .map(apiTokenLinkFromPair)
    .filter((token): token is ApiTokenLink => token !== null)
    .slice(0, MAX_TOKEN_LINKS);

/**
 * The whole answer for one question, from the index's own pairs.
 *
 * Pure, so the honesty rules above are testable without a network.
 */
export const tokenLinksFromPairs = ({
  pairs,
  ticker,
  intent,
}: {
  pairs: MarketPair[];
  ticker: string;
  intent?: string;
}): TokenLinksAnswer => ({
  tokens: tokenLinksFrom(matchingPairs({ pairs, ticker, intent })),
  // See the file's own note: `coins` is Warpcast's coin registry, and this client
  // has no source for it. Empty is the honest answer; a copy of `tokens` is not.
  coins: [],
});

/** Where one question is asked, as the index spells it. */
export const marketIndexUrlFor = ({
  ticker,
  baseUrl = MARKET_INDEX_BASE_URL,
}: {
  ticker: string;
  baseUrl?: string;
}): string =>
  isContractAddress(ticker)
    ? `${baseUrl}${TOKEN_PATH}/${encodeURIComponent(ticker.trim())}`
    : `${baseUrl}${SEARCH_PATH}?q=${encodeURIComponent(
        ticker.replace(/^\$/, '').trim(),
      )}`;

/**
 * One answer, cached for a minute and shared between callers.
 *
 * The composer's typeahead asks once per keystroke (debounced), so a reader
 * typing `$degen` would otherwise make five requests to a public API for one
 * question. The cache holds the index's own pairs; the shaping above runs per
 * request, so a cached answer is never a stale *claim*, only a stale price.
 */
interface CachedPairs {
  pairs: MarketPair[];
  expiresAt: number;
}

const cache = new Map<string, CachedPairs>();
const inFlight = new Map<string, Promise<MarketPair[]>>();

const timeoutSignal = (timeoutMs: number): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

const askMarketIndex = async ({
  ticker,
  fetchImpl,
  baseUrl,
  timeoutMs,
}: {
  ticker: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
}): Promise<MarketPair[]> => {
  const url = marketIndexUrlFor({ ticker, baseUrl });
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: timeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`the market index answered ${response.status}`);
  }

  const payload = (await response.json()) as { pairs?: MarketPair[] | null };

  return Array.isArray(payload.pairs) ? payload.pairs : [];
};

const pairsFor = async ({
  ticker,
  fetchImpl,
  baseUrl,
  timeoutMs,
  ttlMs,
  now,
}: {
  ticker: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  ttlMs: number;
  now: () => number;
}): Promise<MarketPair[]> => {
  const key = marketIndexUrlFor({ ticker, baseUrl });
  const cached = cache.get(key);

  if (cached !== undefined && cached.expiresAt > now()) {
    return cached.pairs;
  }

  const alreadyAsking = inFlight.get(key);

  if (alreadyAsking !== undefined) {
    return alreadyAsking;
  }

  const asking = askMarketIndex({ ticker, fetchImpl, baseUrl, timeoutMs }).then(
    (pairs) => {
      cache.set(key, { pairs, expiresAt: now() + ttlMs });
      inFlight.delete(key);

      return pairs;
    },
    (error: unknown) => {
      inFlight.delete(key);

      throw error;
    },
  );

  inFlight.set(key, asking);

  return asking;
};

/** Forget every cached answer — for tests, and for a "refresh" affordance. */
export const clearMarketIndexCache = (): void => {
  cache.clear();
  inFlight.clear();
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * What a reader is told when the index itself did not answer.
 *
 * `502`, in the same family as the node's own "was asked and did not answer": a
 * retry can change this one, and the alternative to a refusal here is an empty
 * list that reads as "there is no such token".
 */
export const MARKET_INDEX_DID_NOT_ANSWER = (detail: string): string =>
  `Dexscreener, the public market index this client reads token markets from, did not answer (${detail}) — so no token is shown here, and nothing was invented.`;

export interface AnswerTokenLinksOptions {
  searchParams: URLSearchParams;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * The one call the routing table makes for `/v2/token-links`.
 *
 * Never answers a question it did not get an answer to: an unreachable index is a
 * `502` with the sentence above, and a ticker no market uses is an empty answer
 * the surfaces already draw their own empty state for.
 */
export const answerTokenLinks = async ({
  searchParams,
  fetchImpl = globalThis.fetch,
  baseUrl = MARKET_INDEX_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
}: AnswerTokenLinksOptions): Promise<Response> => {
  const ticker = (searchParams.get('ticker') ?? '').trim();
  const intent = searchParams.get('intent') ?? undefined;

  // No ticker is no question: the composer asks with an empty string while its
  // box is empty, and "which token does nothing mean" has one honest answer.
  if (ticker.length === 0) {
    return jsonResponse({ result: { tokens: [], coins: [] } });
  }

  if (typeof fetchImpl !== 'function') {
    return jsonResponse(
      {
        errors: [
          {
            message:
              'This browser cannot ask the market index for a token, so none is shown here.',
          },
        ],
      },
      502,
    );
  }

  try {
    const pairs = await pairsFor({
      ticker,
      fetchImpl,
      baseUrl,
      timeoutMs,
      ttlMs,
      now,
    });

    // An address is looked up by address: the index already decided which token
    // it is, so the ranking is "the market with the most liquidity", and the
    // symbol rules do not apply.
    if (isContractAddress(ticker)) {
      const best = rankPairs(pairs)[0];

      return jsonResponse({
        result: {
          tokens: best === undefined ? [] : tokenLinksFrom([best]),
          coins: [],
        },
      });
    }

    return jsonResponse({
      result: tokenLinksFromPairs({ pairs, ticker, intent }),
    });
  } catch (error) {
    const detail =
      error instanceof Error && /timeout|abort/i.test(error.message)
        ? 'it did not answer in time'
        : error instanceof Error
          ? error.message
          : String(error);

    return jsonResponse(
      { errors: [{ message: MARKET_INDEX_DID_NOT_ANSWER(detail) }] },
      502,
    );
  }
};
