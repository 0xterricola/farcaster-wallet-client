/**
 * What Surp charges, asked of Surp.
 *
 * Two live reads, because they answer two different questions:
 *
 *   the price board  `GET /api/price-compare` — Surp's own per-million-token
 *                    rate for every model it routes, beside what the same
 *                    model costs on OpenRouter. This is the board the owner's
 *                    savings line is computed from; every number is read here
 *                    and none is written down in this file.
 *
 *   the request quote `POST /v1/chat/completions` with no payment at all —
 *                    Surp answers a 402 carrying the exact price it will
 *                    charge for that request, minimum included. Nothing is
 *                    spent: an unpaid probe is the reference implementation of
 *                    "ask what it costs". This is the number that matters,
 *                    because Surp bills in whole cents with a floor, so the
 *                    per-million rate alone understates a chat-sized request
 *                    by orders of magnitude. See `savings.ts`.
 *
 * Both parsers refuse anything they do not recognise rather than guessing, so a
 * changed payload shows up as an honest failure instead of a wrong price.
 */

import { asRecord, num, str, surpJson } from './transport';

export interface SurpModelPrice {
  /** Surp's model id, e.g. `claude-sonnet-4.6`. */
  model: string;
  /** What the model is called on a bill. */
  name: string;
  sellers: number;
  isPro: boolean;
  usdPerMillion: number;
  /** The same model's blended OpenRouter rate, for the comparison. */
  openRouterUsdPerMillion: number | null;
  savingsPercent: number | null;
  cheaper: 'surp' | 'openrouter' | 'tie' | null;
}

export interface SurpPriceBoard {
  /** When Surp built the numbers. Shown to the owner, never assumed fresh. */
  generatedAt: string;
  /** Surp's own staleness figure, in seconds. */
  sourceAgeSeconds: number;
  /** The workload mix the blend assumes. */
  inputShare: number;
  models: SurpModelPrice[];
}

export interface SurpRequestQuote {
  /** The exact price for one request at this size, as Surp states it. */
  priceUsd: number;
  /** Which route Surp picked, and the model behind it. */
  combo: string | null;
  routedModel: string | null;
  /** The atomic-USDC amount of the payment Surp is asking for. */
  amountAtomicUsdc: bigint | null;
}

const parseModel = (entry: unknown): SurpModelPrice | null => {
  const row = asRecord(entry);
  if (!row) {
    return null;
  }
  const model = str(row.model);
  const usdPerMillion = num(row.surp_usd_per_1m);
  if (!model || usdPerMillion === null) {
    return null;
  }
  const cheaper = str(row.cheaper);
  return {
    model,
    name: str(row.name) ?? model,
    sellers: num(row.sellers) ?? 0,
    isPro: row.pro === true,
    usdPerMillion,
    openRouterUsdPerMillion: num(row.openrouter_blended_usd_per_1m),
    savingsPercent: num(row.savings_pct),
    cheaper:
      cheaper === 'surp' || cheaper === 'openrouter' || cheaper === 'tie'
        ? cheaper
        : null,
  };
};

export const parsePriceBoard = (
  payload: unknown,
  inputShare: number,
): SurpPriceBoard | null => {
  const body = asRecord(payload);
  const rows = body?.models;
  if (!body || !Array.isArray(rows)) {
    return null;
  }
  const models = rows
    .map(parseModel)
    .filter((model): model is SurpModelPrice => model !== null);
  if (models.length === 0) {
    return null;
  }
  return {
    generatedAt: str(body.generated_at) ?? '',
    sourceAgeSeconds: num(body.source_age_seconds) ?? 0,
    inputShare,
    models,
  };
};

export const fetchPriceBoard = async (
  inputShare = 0.7,
): Promise<SurpPriceBoard> => {
  const payload = await surpJson<unknown>({
    path: '/api/price-compare',
    query: { input_share: inputShare },
  });
  const board = parsePriceBoard(payload, inputShare);
  if (!board) {
    throw new Error('surp-price-board-unreadable');
  }
  return board;
};

/**
 * What Surp will charge for one request of this size, asked without paying.
 * A 402 is the answer, not a failure.
 */
export const fetchRequestQuote = async (
  tokens: number,
  combo = 'surp/value',
): Promise<SurpRequestQuote> => {
  const payload = await surpJson<unknown>(
    {
      path: '/v1/chat/completions',
      method: 'POST',
      body: {
        model: combo,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: Math.max(1, Math.round(tokens)),
      },
    },
    { allow402: true },
  );
  const quote = parseRequestQuote(payload);
  if (!quote) {
    throw new Error('surp-quote-unreadable');
  }
  return quote;
};

/**
 * Read a 402 body as the price it states. Surp writes the number twice — as
 * `price_usd` ("$0.0100") and as the atomic `amount` of the payment it wants —
 * and they agree; the atomic form is preferred because it is exact, with the
 * human string as the fallback for a shape that stops carrying it.
 */
export const parseRequestQuote = (
  payload: unknown,
): SurpRequestQuote | null => {
  const body = asRecord(payload);
  if (!body) {
    return null;
  }
  const accepts = Array.isArray(body.accepts) ? body.accepts : [];
  const first = asRecord(accepts[0]);
  const rawAmount = str(first?.amount);
  const atomic =
    rawAmount && /^\d+$/.test(rawAmount) ? BigInt(rawAmount) : null;
  const priceText = str(body.price_usd); // Surp states it as "$0.0100"
  const priceUsd =
    atomic !== null
      ? Number(atomic) / 1_000_000
      : priceText && priceText.startsWith('$')
        ? Number(priceText.slice(1))
        : NaN;
  if (!Number.isFinite(priceUsd)) {
    return null;
  }
  return {
    priceUsd,
    combo: str(body.combo),
    routedModel: str(body.routed_model),
    amountAtomicUsdc: atomic,
  };
};
