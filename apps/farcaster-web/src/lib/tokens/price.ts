/**
 * What a `$cashtag` is worth right now: one read-only lookup, cached for a
 * minute, with honest failure.
 *
 * This module is imported **on demand** (the chip in a cast body pulls it in
 * only when a price is actually asked for), because the main bundle is already
 * large and a feed full of cashtags should not pay for a price nobody looked at.
 *
 * Design decisions worth naming:
 *
 * - One provider, no key: Dexscreener's public API answers by contract address
 *   (exact) and by symbol search (best match). No signup, nothing to leak, and no
 *   server of ours in the middle.
 * - A cast that carries a token mention carries its contract address, so that
 *   path is used whenever it is available. When we only have a ticker, the
 *   lookup says *which* market it picked, rather than implying the ticker is
 *   unique on the internet (it is not: there are many `$DOGE`s).
 * - Failure is a value, not an exception: `reason` is a sentence a reader can
 *   see, and the chip renders the ticker without a price.
 * - `fetch` is injectable so this is testable without touching the network.
 */

export interface TokenPrice {
  usd: number;
  symbol: string;
  chainId: string;
  /** The market this price came from — shown as the source of the number. */
  url: string;
  fetchedAt: number;
}

export interface TokenPriceQuery {
  /** `$TICKER` without the `$`. */
  ticker: string;
  /** A contract address, when the cast knew one — this path is exact. */
  address?: string;
  /** The chain the address lives on, when the cast said. */
  chain?: string;
}

export interface TokenPriceResult {
  price: TokenPrice | null;
  /** Plain words for the reader when `price` is null. */
  reason: string | null;
}

export interface PriceLookupOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

const PRICE_API = 'https://api.dexscreener.com';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * `AbortSignal.timeout` is the whole timeout mechanism, and it is not in every
 * browser this client runs in (Safari before 16.4). Rather than refuse to ask
 * for a price there, a browser without it asks without a timeout: a hanging
 * request is the browser's own problem to time out, and a chip that never
 * answers is worse than a chip that answers slowly.
 */
const timeoutSignal = (timeoutMs: number): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

/** Chains this client's world actually trades on, most likely first. */
const CHAIN_PREFERENCE = [
  'base',
  'solana',
  'ethereum',
  'optimism',
  'arbitrum',
  'polygon',
  'zora',
];

interface DexPair {
  chainId?: string;
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { symbol?: string; address?: string };
}

const cache = new Map<
  string,
  { result: TokenPriceResult; expiresAt: number }
>();
const inFlight = new Map<string, Promise<TokenPriceResult>>();

const cacheKey = (query: TokenPriceQuery): string =>
  query.address
    ? `addr:${(query.chain ?? '').toLowerCase()}:${query.address.toLowerCase()}`
    : `sym:${query.ticker.toLowerCase()}`;

const priceFromPair = (pair: DexPair, fetchedAt: number): TokenPrice | null => {
  const usd = Number.parseFloat(pair.priceUsd ?? '');

  if (!Number.isFinite(usd) || usd <= 0) {
    return null;
  }

  return {
    usd,
    symbol: pair.baseToken?.symbol ?? '',
    chainId: pair.chainId ?? '',
    url: pair.url ?? '',
    fetchedAt,
  };
};

const liquidityOf = (pair: DexPair): number =>
  Number.isFinite(pair.liquidity?.usd) ? (pair.liquidity?.usd ?? 0) : 0;

const bestByLiquidity = (pairs: DexPair[]): DexPair | null => {
  const ranked = [...pairs].sort(
    (left, right) => liquidityOf(right) - liquidityOf(left),
  );

  return ranked[0] ?? null;
};

/** The market whose own symbol matches what was written in the cast. */
export const bestSymbolMatch = (
  pairs: DexPair[],
  ticker: string,
): DexPair | null => {
  const wanted = ticker.replace(/^\$/, '').toLowerCase();
  const matching = pairs.filter(
    (pair) => (pair.baseToken?.symbol ?? '').toLowerCase() === wanted,
  );

  if (matching.length === 0) {
    return null;
  }

  const preferenceRank = (pair: DexPair): number => {
    const index = CHAIN_PREFERENCE.indexOf((pair.chainId ?? '').toLowerCase());

    return index === -1 ? CHAIN_PREFERENCE.length : index;
  };

  const ranked = [...matching].sort((left, right) => {
    const byChain = preferenceRank(left) - preferenceRank(right);

    return byChain !== 0 ? byChain : liquidityOf(right) - liquidityOf(left);
  });

  return ranked[0] ?? null;
};

const askProvider = async (
  query: TokenPriceQuery,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DexPair[]> => {
  const url = query.address
    ? `${PRICE_API}/latest/dex/tokens/${encodeURIComponent(query.address)}`
    : `${PRICE_API}/latest/dex/search?q=${encodeURIComponent(
        query.ticker.replace(/^\$/, ''),
      )}`;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: timeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`the price service answered ${response.status}`);
  }

  const payload = (await response.json()) as { pairs?: DexPair[] | null };

  return Array.isArray(payload.pairs) ? payload.pairs : [];
};

const lookupUncached = async (
  query: TokenPriceQuery,
  options: Required<
    Pick<PriceLookupOptions, 'fetchImpl' | 'now' | 'timeoutMs'>
  >,
): Promise<TokenPriceResult> => {
  const symbol = query.ticker.replace(/^\$/, '').toUpperCase();

  if (query.address === undefined && symbol.trim() === '') {
    return { price: null, reason: 'there is no ticker to look up' };
  }

  try {
    const pairs = await askProvider(
      query,
      options.fetchImpl,
      options.timeoutMs,
    );

    if (pairs.length === 0) {
      return {
        price: null,
        reason: `no market was found for $${symbol}`,
      };
    }

    const pair = query.address
      ? bestByLiquidity(pairs)
      : bestSymbolMatch(pairs, query.ticker);

    if (pair === null) {
      return {
        price: null,
        reason: `no market with the ticker $${symbol} was found (other $${symbol} tokens exist, and none of them is this one)`,
      };
    }

    const price = priceFromPair(pair, options.now());

    if (price === null) {
      return {
        price: null,
        reason: `the market for $${symbol} did not quote a price`,
      };
    }

    return { price, reason: null };
  } catch (error) {
    return {
      price: null,
      reason:
        error instanceof Error && /timeout|abort/i.test(error.message)
          ? 'the price service did not answer in time'
          : 'the price service could not be reached',
    };
  }
};

/** The one call a surface makes. Never throws. */
export const lookupTokenPrice = async (
  query: TokenPriceQuery,
  options: PriceLookupOptions = {},
): Promise<TokenPriceResult> => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = cacheKey(query);

  if (typeof fetchImpl !== 'function') {
    return { price: null, reason: 'this browser cannot ask for a price' };
  }

  const cached = cache.get(key);

  if (cached !== undefined && cached.expiresAt > now()) {
    return cached.result;
  }

  const alreadyAsking = inFlight.get(key);

  if (alreadyAsking !== undefined) {
    return alreadyAsking;
  }

  const asking = lookupUncached(query, { fetchImpl, now, timeoutMs }).then(
    (result) => {
      cache.set(key, { result, expiresAt: now() + ttlMs });
      inFlight.delete(key);

      return result;
    },
  );

  inFlight.set(key, asking);

  return asking;
};

/** Forget every cached price — for tests, and for a "refresh" affordance. */
export const clearPriceCache = (): void => {
  cache.clear();
  inFlight.clear();
};

/**
 * A price a person reads at a glance: `$1,234.56`, `$0.01234`, `$0.00000042`.
 * Small numbers keep their significant digits, because rounding a memecoin to
 * `$0.00` is worse than showing nothing.
 */
export const formatUsdPrice = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return '—';
  }

  if (usd >= 1000) {
    return `$${usd.toLocaleString('en-US', {
      maximumFractionDigits: 0,
    })}`;
  }

  if (usd >= 1) {
    return `$${usd.toFixed(2)}`;
  }

  const decimals = usd >= 0.01 ? 4 : usd >= 0.0001 ? 6 : 8;

  return `$${usd.toFixed(decimals)}`;
};
