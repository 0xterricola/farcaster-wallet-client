/**
 * The Fiddy balance: top up with USDC on Base, spend it inside Fiddy.
 *
 * WHAT THE BALANCE IS, IN ONE PARAGRAPH. A Fiddy balance is a **platform
 * credit**. Someone sends USDC on Base to the Fiddy treasury, Fiddy checks that
 * transfer on-chain, and the ledger records what Fiddy owes them in-app. It is
 * not money sitting in a wallet, not custody, and not a redeemable claim — so
 * neither this file nor any screen may call it a wallet balance, a deposit, or
 * "your funds". The copy rule is enforced by the server too
 * (`docs/fiddy/BALANCE-CREDIT.md` on the control plane); this client is the
 * other half of it.
 *
 * WHERE IT TALKS. Same origin, three routes, all proxied to Fiddy's own service
 * by the host that serves this app (`https://fiddy.fun/api/fiddy/funding/*`):
 *
 *   GET  /config   public, no session: where to send, what in, how much is
 *                  enough. Never contains a key.
 *   POST /credit   authenticated: `{ txHash }` and nothing else. Verifies the
 *                  transfer on Base and credits it once.
 *   GET  /balance  authenticated: the available credit plus the ten most recent
 *                  movements.
 *
 * WHY IT IS NOT A CROSS-ORIGIN CALL. There is no CORS grant on the other
 * origin, and the session that authorises a credit is a cookie: a page that
 * reaches another origin carries neither. So every path here is relative, and a
 * test asserts it (`fiddyCredit.test.ts`).
 *
 * MONEY IS A STRING, ALWAYS. USDC has six decimals and the server speaks in
 * integer base units (`"5000000"` is $5). A float would round someone's money,
 * so nothing here parses money into a number: amounts are compared and printed
 * as strings/decimal text, and the only arithmetic is done in `BigInt`.
 *
 * WHAT THIS FILE WILL NOT DO. It never invents an answer: a failure is one of
 * the server's own named codes, mapped to a sentence somebody can act on, and
 * an unreadable body is `UNREADABLE` rather than an empty balance. Waiting is
 * named too — a transfer Base has not finished confirming is "still
 * confirming", not a failure and not a success.
 */

import type { Chain } from 'viem';

export const FUNDING_CONFIG_PATH = '/api/fiddy/funding/config';
export const FUNDING_CREDIT_PATH = '/api/fiddy/funding/credit';
export const FUNDING_BALANCE_PATH = '/api/fiddy/funding/balance';

/** The chain the credit rules are written for. Kept from config, not assumed. */
export interface FundingChain {
  id: number;
  name: string;
  caip2: string;
}

export interface FundingAsset {
  symbol: string;
  address: string;
  decimals: number;
}

export interface FundingPreset {
  usd: number;
  label: string;
  usdc: string;
  baseUnits: string;
}

export interface FundingConfig {
  chain: FundingChain;
  asset: FundingAsset;
  treasury: { address: string; short: string };
  minimum: { usdc: string; baseUnits: string };
  /** How many Base blocks the server waits before it will credit a transfer. */
  confirmations: number;
  presets: readonly FundingPreset[];
  /** The server's own sentence about what a credit is. */
  creditNote: string;
  /** Derived: the CAIP-19 id the Farcaster wallet prompt wants. */
  caip19: string;
}

/** Available = credited − spent, which is what the balance chip shows. */
export interface FundingCredit {
  availableUsdc: string;
  availableBaseUnits: string;
  creditedUsdc: string;
  creditedBaseUnits: string;
  spentUsdc: string;
  spentBaseUnits: string;
}

export interface FundingMovement {
  id: number;
  kind: string;
  status: string;
  amount: { usdc: string; baseUnits: string };
  /** Already shortened by the server (`0x1234abcd…ef5678`), or null. */
  txHashShort: string | null;
  /** ISO-8601. */
  time: string;
}

export interface FundingBalance {
  credit: FundingCredit;
  entries: readonly FundingMovement[];
  note: string;
}

export interface FundingCreditReceipt {
  credited: boolean;
  /** True when this very transfer was credited on an earlier attempt. */
  replayed: boolean;
  txHash: string;
  amount: { usdc: string; baseUnits: string };
  confirmations: number | null;
  creditedAt: number | null;
  balance: {
    availableUsdc: string;
    creditedUsdc: string;
    spentUsdc: string;
  } | null;
  note: string;
}

/**
 * Every code this client can name. The first group is the server's own
 * vocabulary (straight from the funding routes); the rest is what a browser can
 * hit on the way there, plus the two states waiting and a second submit
 * produce.
 */
export type FundingFailureCode =
  // From the verification itself.
  | 'TX_NOT_FOUND'
  | 'TX_FAILED'
  | 'NO_MATCHING_TRANSFER'
  | 'TOKEN_NOT_SUPPORTED'
  | 'TRANSFER_TOO_SMALL'
  | 'INSUFFICIENT_CONFIRMATIONS'
  // From the request gates.
  | 'AUTH_REQUIRED'
  | 'PRODUCTION_AUTH_REQUIRED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'INVALID_TX_HASH'
  | 'INVALID_BODY'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'READ_ONLY'
  // From the server's own configuration.
  | 'TREASURY_NOT_CONFIGURED'
  | 'FUNDING_CONFIG_UNAVAILABLE'
  | 'RPC_NOT_CONFIGURED'
  | 'RPC_UNAVAILABLE'
  | 'FUNDING_STORE_UNAVAILABLE'
  | 'FUNDING_CREDIT_UNAVAILABLE'
  | 'FUNDING_BALANCE_UNAVAILABLE'
  // From the wallet, before anything is broadcast.
  | 'NOT_CONNECTED'
  | 'WRONG_NETWORK'
  | 'NOT_ENOUGH_USDC'
  | 'NOT_ENOUGH_GAS'
  | 'DECLINED'
  | 'SEND_FAILED'
  // From this side of the wire.
  | 'UNREACHABLE'
  | 'UNREADABLE'
  // Never a failure the server sends: the answer to a second submit of a hash
  // that is already in the ledger.
  | 'ALREADY_CREDITED'
  // A custom amount this client refuses to send (below the $1 minimum, or not
  // a dollar amount at all).
  | 'AMOUNT_TOO_SMALL'
  | 'AMOUNT_INVALID';

/**
 * What to say, in words somebody can act on. Nothing here uses a word the
 * person did not bring with them: no allowance, no chain id, no gas, no RPC.
 * The code stays visible beside the sentence — a name to quote back, not
 * jargon to understand.
 */
const OWNER_LINES: Record<FundingFailureCode, string> = {
  TX_NOT_FOUND:
    'That transfer is not on Base yet. Nothing was added to your balance; this screen can check again.',
  TX_FAILED:
    'That transfer did not go through, so nothing moved. Nothing was added to your balance.',
  NO_MATCHING_TRANSFER:
    'That transfer did not go to Fiddy’s address, so nothing was added.',
  TOKEN_NOT_SUPPORTED:
    'That transfer was not USDC, and only USDC can be added here.',
  TRANSFER_TOO_SMALL:
    'That was less than the $1 minimum, so nothing was added. Send at least $1, and Fiddy will add it.',
  INSUFFICIENT_CONFIRMATIONS:
    'Base is still checking that transfer. Nothing is lost — this screen keeps checking on its own.',
  AUTH_REQUIRED:
    'Sign in to Fiddy first, so the top-up can land in your balance.',
  PRODUCTION_AUTH_REQUIRED:
    'This account cannot hold a Fiddy balance yet, so nothing was added. Nothing was charged.',
  ORIGIN_NOT_ALLOWED:
    'Fiddy refused that request from this page, so nothing was added.',
  RATE_LIMITED:
    'That is a lot of checks in one hour. Nothing was lost — try again a little later.',
  INVALID_TX_HASH:
    'That transfer reference does not look like a Base transfer, so nothing was added.',
  INVALID_BODY: 'Fiddy answered with a request it did not understand.',
  INVALID_JSON: 'Fiddy answered with a request it did not understand.',
  PAYLOAD_TOO_LARGE: 'That request was too big for Fiddy to read.',
  READ_ONLY: 'This way of adding funds is closed here.',
  TREASURY_NOT_CONFIGURED:
    'Adding funds is not switched on here yet. Nothing was sent, and nothing was charged.',
  FUNDING_CONFIG_UNAVAILABLE:
    'Adding funds is not switched on here yet. Nothing was sent, and nothing was charged.',
  RPC_NOT_CONFIGURED:
    'Fiddy cannot reach Base to check transfers here yet, so nothing can be added right now.',
  RPC_UNAVAILABLE:
    'Fiddy could not reach Base just now. Nothing was lost — try again in a moment.',
  FUNDING_STORE_UNAVAILABLE:
    'Fiddy could not open its balance book just now. Nothing was lost — nothing was added either.',
  FUNDING_CREDIT_UNAVAILABLE:
    'Fiddy could not add that just now. Your transfer reference is kept below; try again in a moment.',
  FUNDING_BALANCE_UNAVAILABLE:
    'Fiddy could not read your balance just now. Nothing changed.',
  NOT_CONNECTED: 'No wallet is connected here yet, so nothing was sent.',
  WRONG_NETWORK:
    'Your wallet is on another network. Fiddy adds funds on Base, so nothing was sent.',
  NOT_ENOUGH_USDC:
    'Your wallet does not have that much USDC on Base. Nothing was sent.',
  NOT_ENOUGH_GAS:
    'Your wallet has no ETH on Base for the network fee. Nothing was sent.',
  DECLINED: 'That was not approved, so nothing was sent.',
  SEND_FAILED:
    'Your wallet did not send that. Nothing was transferred, and nothing was added.',
  UNREACHABLE:
    'This page could not reach Fiddy’s top-up service. Nothing was sent, and nothing was added.',
  UNREADABLE:
    'Fiddy answered something this screen could not read. Nothing was added.',
  ALREADY_CREDITED:
    'That transfer is already in your Fiddy balance. It was not added twice.',
  AMOUNT_TOO_SMALL:
    'Fiddy adds $1 or more at a time, so this amount was not sent.',
  AMOUNT_INVALID: 'Enter an amount in dollars, like 5 or 12.50.',
};

export const fundingFailureLine = (code: FundingFailureCode): string =>
  OWNER_LINES[code] ?? OWNER_LINES.UNREADABLE;

/** A failure with a name and a sentence, never a bare throw. */
export class FundingError extends Error {
  readonly code: FundingFailureCode;
  readonly status: number;
  /** True for the two states where waiting is the right thing to do. */
  readonly retryable: boolean;
  /** What to show the person, in their words. */
  readonly ownerLine: string;

  constructor(
    code: FundingFailureCode,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(
      code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'FundingError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable =
      options.retryable ??
      (code === 'INSUFFICIENT_CONFIRMATIONS' || code === 'TX_NOT_FOUND');
    this.ownerLine = fundingFailureLine(code);
  }
}

export const isFundingError = (error: unknown): error is FundingError =>
  error instanceof FundingError;

/** The code for anything thrown, so a caller can always name what happened. */
export const fundingFailureCode = (error: unknown): FundingFailureCode =>
  isFundingError(error) ? error.code : 'UNREADABLE';

export const fundingFailureOwnerLine = (error: unknown): string =>
  isFundingError(error) ? error.ownerLine : fundingFailureLine('UNREADABLE');

/**
 * Can this browser add to a Fiddy balance, and if not, what is true instead?
 *
 *   loading      the balance read is still out
 *   ready        the service answered with a balance: a top-up can land
 *   refused      the service will not place this session (sign in, or this
 *                account cannot hold a credit here)
 *   unavailable  the service could not be reached or is not switched on yet
 */
export type FundingSession = 'loading' | 'ready' | 'refused' | 'unavailable';

// ---------------------------------------------------------------------------
// Money, as text
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** `"5.00"` → `"$5.00"`. Never a float, and never fewer than two decimals. */
export const formatUsd = (usdc: string): string => {
  const normalized = normalizeDecimal(usdc);
  return normalized === null ? `$${usdc}` : `$${normalized}`;
};

/**
 * A decimal string with at least two fraction digits and no trailing zeroes
 * beyond them, or null when the input is not a plain non-negative decimal.
 */
export const normalizeDecimal = (
  value: string,
  minimumFraction = 2,
): string | null => {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const kept = fraction.slice(0, Math.max(minimumFraction, fraction.length));
  const padded =
    minimumFraction > kept.length ? kept.padEnd(minimumFraction, '0') : kept;
  return `${whole}.${padded}`;
};

/** `"5.00"` and 6 decimals → `"5000000"`. Null when the text is not a decimal. */
export const usdcTextToBaseUnits = (
  usdc: string,
  decimals = 6,
): string | null => {
  const trimmed = usdc.trim();
  if (
    !DECIMAL_PATTERN.test(trimmed) ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    return null;
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    return null;
  }
  const padded = fraction.padEnd(decimals, '0');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded)).toString();
};

/** `"5000000"` and 6 decimals → `"5.00"`. Null for anything that is not digits. */
export const baseUnitsToUsdcText = (
  baseUnits: string,
  decimals = 6,
): string | null => {
  if (!/^\d+$/.test(baseUnits) || !Number.isInteger(decimals) || decimals < 0) {
    return null;
  }
  if (decimals === 0) {
    return `${baseUnits}`;
  }
  const units = BigInt(baseUnits);
  const divisor = 10n ** BigInt(decimals);
  const whole = (units / divisor).toString();
  const fraction = (units % divisor).toString().padStart(decimals, '0');
  return normalizeDecimal(`${whole}.${fraction}`, decimals) ?? null;
};

/**
 * Dollars and cents from a field a person typed, as integer base units.
 *
 * The custom amount is a *dollar* amount, so it is limited to two decimal
 * places: `12.5` is $12.50 and `12.505` is refused rather than rounded, because
 * rounding someone's money without telling them is the one thing an amount
 * field must not do.
 */
export const dollarsToBaseUnits = (
  dollars: string,
  decimals = 6,
): { baseUnits: string; usdc: string } | null => {
  const trimmed = dollars.trim().replace(/^\$/, '');
  if (!DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }
  const fraction = trimmed.split('.')[1] ?? '';
  if (fraction.length > 2) {
    return null;
  }
  const baseUnits = usdcTextToBaseUnits(trimmed, decimals);
  const usdc = normalizeDecimal(trimmed, 2);
  return baseUnits === null || usdc === null ? null : { baseUnits, usdc };
};

/** Is this amount below the smallest top-up the server will credit? */
export const isBelowMinimum = (
  baseUnits: string,
  minimumBaseUnits: string,
): boolean => {
  try {
    return BigInt(baseUnits) < BigInt(minimumBaseUnits);
  } catch {
    return true;
  }
};

/** The preset for a dollar amount, when the server offers one. */
export const presetFor = (
  config: FundingConfig,
  usd: number,
): FundingPreset | null =>
  config.presets.find((preset) => preset.usd === usd) ?? null;

// ---------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

const readNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const unreadable = (what: string): FundingError =>
  new FundingError('UNREADABLE', {
    status: 0,
    cause: new Error(`unreadable ${what}`),
  });

/** An amount the server sends as `{ usdc, baseUnits }`. */
const readAmount = (
  value: unknown,
): { usdc: string; baseUnits: string } | null => {
  if (!isRecord(value)) {
    return null;
  }
  const usdc = readString(value.usdc);
  const baseUnits = readString(value.baseUnits);
  if (usdc === null || baseUnits === null) {
    return null;
  }
  return { usdc, baseUnits };
};

export const parseFundingConfig = (payload: unknown): FundingConfig => {
  if (!isRecord(payload) || payload.ok !== true) {
    throw fundingErrorFromBody(payload, 'FUNDING_CONFIG_UNAVAILABLE');
  }
  const chain = payload.chain;
  const asset = payload.asset;
  const treasury = payload.treasury;
  const minimum = payload.minimum;
  const presets = payload.presets;
  if (
    !isRecord(chain) ||
    !isRecord(asset) ||
    !isRecord(treasury) ||
    !isRecord(minimum) ||
    !Array.isArray(presets)
  ) {
    throw unreadable('funding config');
  }
  const chainId = readNumber(chain.id);
  const chainName = readString(chain.name);
  const caip2 = readString(chain.caip2);
  const symbol = readString(asset.symbol);
  const assetAddress = readString(asset.address);
  const decimals = readNumber(asset.decimals);
  const treasuryAddress = readString(treasury.address);
  const minimumUsdc = readString(minimum.usdc);
  const minimumBaseUnits = readString(minimum.baseUnits);
  if (
    chainId === null ||
    chainName === null ||
    caip2 === null ||
    symbol === null ||
    assetAddress === null ||
    decimals === null ||
    treasuryAddress === null ||
    minimumUsdc === null ||
    minimumBaseUnits === null
  ) {
    throw unreadable('funding config');
  }
  const readPresets: FundingPreset[] = [];
  for (const raw of presets) {
    if (!isRecord(raw)) {
      throw unreadable('funding preset');
    }
    const usd = readNumber(raw.usd);
    const label = readString(raw.label);
    const usdc = readString(raw.usdc);
    const baseUnits = readString(raw.baseUnits);
    if (usd === null || label === null || usdc === null || baseUnits === null) {
      throw unreadable('funding preset');
    }
    readPresets.push({ usd, label, usdc, baseUnits });
  }
  return {
    chain: { id: chainId, name: chainName, caip2 },
    asset: { symbol, address: assetAddress, decimals },
    treasury: {
      address: treasuryAddress,
      // The server's short form when it sent one; kept because a probe reads it.
      short: readString(treasury.short) ?? shortAddress(treasuryAddress),
    },
    minimum: { usdc: minimumUsdc, baseUnits: minimumBaseUnits },
    confirmations: readNumber(payload.confirmations) ?? 5,
    presets: readPresets,
    creditNote:
      readString(payload.creditNote) ??
      'A top-up becomes a Fiddy balance once Fiddy has checked the transfer on Base. It is spent inside Fiddy and is not money in a wallet.',
    caip19: `${caip2}/erc20:${assetAddress}`,
  };
};

const readCreditSummary = (value: unknown): FundingCreditReceipt['balance'] => {
  if (!isRecord(value)) {
    return null;
  }
  const availableUsdc = readString(value.availableUsdc);
  const creditedUsdc = readString(value.creditedUsdc);
  const spentUsdc = readString(value.spentUsdc);
  if (availableUsdc === null || creditedUsdc === null || spentUsdc === null) {
    return null;
  }
  return { availableUsdc, creditedUsdc, spentUsdc };
};

export const parseFundingCreditReceipt = (
  payload: unknown,
): FundingCreditReceipt => {
  if (!isRecord(payload) || payload.ok !== true) {
    throw fundingErrorFromBody(payload, 'FUNDING_CREDIT_UNAVAILABLE');
  }
  const txHash = readString(payload.txHash);
  const amount = readAmount(payload.amount);
  if (txHash === null || amount === null) {
    throw unreadable('credit answer');
  }
  return {
    credited: payload.credited === true,
    replayed: payload.replayed === true,
    txHash,
    amount,
    confirmations: readNumber(payload.confirmations),
    creditedAt: readNumber(payload.creditedAt),
    balance: readCreditSummary(payload.balance),
    note:
      readString(payload.note) ??
      'The credit is a Fiddy balance, spent inside Fiddy. Fiddy does not hold money in your wallet.',
  };
};

export const parseFundingBalance = (payload: unknown): FundingBalance => {
  if (!isRecord(payload) || payload.ok !== true) {
    throw fundingErrorFromBody(payload, 'FUNDING_BALANCE_UNAVAILABLE');
  }
  const credit = payload.credit;
  if (!isRecord(credit)) {
    throw unreadable('balance answer');
  }
  const fields = {
    availableUsdc: readString(credit.availableUsdc),
    availableBaseUnits: readString(credit.availableBaseUnits),
    creditedUsdc: readString(credit.creditedUsdc),
    creditedBaseUnits: readString(credit.creditedBaseUnits),
    spentUsdc: readString(credit.spentUsdc),
    spentBaseUnits: readString(credit.spentBaseUnits),
  };
  if (Object.values(fields).some((value) => value === null)) {
    throw unreadable('balance answer');
  }
  const entries: FundingMovement[] = [];
  for (const raw of Array.isArray(payload.entries) ? payload.entries : []) {
    if (!isRecord(raw)) {
      continue;
    }
    const amount = readAmount(raw.amount);
    const id = readNumber(raw.id);
    const time = readString(raw.time);
    if (amount === null || id === null || time === null) {
      continue;
    }
    entries.push({
      id,
      kind: readString(raw.kind) ?? 'movement',
      status: readString(raw.status) ?? 'recorded',
      amount,
      txHashShort: readString(raw.txHashShort),
      time,
    });
  }
  return {
    credit: fields as FundingCredit,
    entries,
    note:
      readString(payload.note) ??
      'Your Fiddy balance is a credit you spend inside Fiddy. Fiddy does not hold money in your wallet.',
  };
};

/**
 * The failure behind a `{ ok: false }` answer. The server always names a code;
 * anything else is this client's own `UNREADABLE`, never a guess.
 */
export const fundingErrorFromBody = (
  payload: unknown,
  fallback: FundingFailureCode,
  status = 0,
): FundingError => {
  if (!isRecord(payload)) {
    return new FundingError(fallback, { status: status || 503 });
  }
  const code = readString(payload.code);
  if (code === null) {
    return new FundingError(fallback, { status: status || 503 });
  }
  const known = code in OWNER_LINES;
  if (!known) {
    return new FundingError(fallback, { status: status || 503 });
  }
  return new FundingError(code as FundingFailureCode, {
    status,
    retryable:
      payload.retryable === true ||
      code === 'INSUFFICIENT_CONFIRMATIONS' ||
      code === 'TX_NOT_FOUND',
  });
};

/** `0x1234abcd…ef5678`, for a hash this client has to show. */
export const shortAddress = (address: string): string =>
  address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export const shortHash = (hash: string): string =>
  hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export const fundingChainFor = (config: FundingConfig): Chain => ({
  id: config.chain.id,
  name: config.chain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/**
 * One JSON read against this app's own origin. The session is a cookie, so it
 * rides along on its own — and nothing here ever sends a key or a token.
 */
const readJson = async (
  path: string,
  init: RequestInit | undefined,
  failureCode: FundingFailureCode,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      ...init,
    });
  } catch (error) {
    throw new FundingError('UNREACHABLE', { cause: error });
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw fundingErrorFromBody(body, failureCode, response.status);
  }
  return body;
};

export const fetchFundingConfig = async (
  signal?: AbortSignal,
): Promise<FundingConfig> =>
  parseFundingConfig(
    await readJson(
      FUNDING_CONFIG_PATH,
      signal === undefined ? undefined : { signal },
      'FUNDING_CONFIG_UNAVAILABLE',
    ),
  );

export const fetchFundingBalance = async (
  signal?: AbortSignal,
): Promise<FundingBalance> =>
  parseFundingBalance(
    await readJson(
      FUNDING_BALANCE_PATH,
      signal === undefined ? undefined : { signal },
      'FUNDING_BALANCE_UNAVAILABLE',
    ),
  );

/**
 * The body is exactly `{ txHash }`. The route refuses any other field with
 * `INVALID_BODY`, deliberately: a top-up is one transfer and one hash, and an
 * extra field is a client that believes something else is being sent.
 */
export const submitFundingCredit = async (
  txHash: string,
  signal?: AbortSignal,
): Promise<FundingCreditReceipt> =>
  parseFundingCreditReceipt(
    await readJson(
      FUNDING_CREDIT_PATH,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ txHash }),
        ...(signal === undefined ? {} : { signal }),
      },
      'FUNDING_CREDIT_UNAVAILABLE',
    ),
  );

// ---------------------------------------------------------------------------
// After the send: submit, wait, and prove it landed
// ---------------------------------------------------------------------------

export type TopUpStage =
  /** The transfer hash is being handed to Fiddy. */
  | { name: 'checking' }
  /** Base has not finished confirming it; the server said to try again. */
  | { name: 'confirming'; attempt: number }
  /** In the balance. `settled` is false when the movement is not in the
   *  balance answer yet, which is a moment, not a problem. */
  | { name: 'credited'; receipt: FundingCreditReceipt; settled: boolean }
  /** The same transfer had already been credited — not an error, and not a
   *  second credit. */
  | { name: 'already-credited'; receipt: FundingCreditReceipt }
  | { name: 'failed'; error: FundingError };

export interface TopUpRunDeps {
  credit: (txHash: string) => Promise<FundingCreditReceipt>;
  balance: () => Promise<FundingBalance>;
  /** Injected so a test can wait in no time at all. */
  sleep: (ms: number) => Promise<void>;
  onStage?: (stage: TopUpStage) => void;
  /** How long "still confirming" is worth waiting, in total. */
  waitBudgetMs?: number;
  /** How long between two checks. */
  checkEveryMs?: number;
  isCancelled?: () => boolean;
}

/** Five Base blocks is a handful of seconds; a minute is generous. */
export const DEFAULT_WAIT_BUDGET_MS = 90_000;
export const DEFAULT_CHECK_EVERY_MS = 4_000;

const cancelled = (): FundingError =>
  new FundingError('SEND_FAILED', {
    cause: new Error('top-up check cancelled'),
  });

/**
 * Hand the transfer to Fiddy and stay with it until the balance moves.
 *
 * WHY IT RE-SUBMITS RATHER THAN POLLING ONLY THE BALANCE. A transfer that Base
 * has not confirmed cannot be in the balance yet, so a balance poll at that
 * point would sit on an unchanged number and read as "nothing happened" — the
 * one thing that is not true. `POST /credit` is where the server says whether
 * it can credit *yet* (`409`, `retryable`), and it is what makes the same hash
 * credit exactly once: the ledger's unique index answers the second submit with
 * `{ credited: false, replayed: true }` rather than a duplicate. So the wait
 * goes through the route that knows, and the balance read afterwards is what
 * proves the movement is really in the balance.
 */
export const runTopUp = async ({
  txHash,
  deps,
}: {
  txHash: string;
  deps: TopUpRunDeps;
}): Promise<TopUpStage> => {
  const waitBudgetMs = deps.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;
  const checkEveryMs = deps.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS;
  const startedAt = Date.now();
  let attempt = 0;

  const stage = (next: TopUpStage): TopUpStage => {
    deps.onStage?.(next);
    return next;
  };

  stage({ name: 'checking' });

  for (;;) {
    if (deps.isCancelled?.()) {
      return stage({ name: 'failed', error: cancelled() });
    }
    attempt += 1;

    let receipt: FundingCreditReceipt;
    try {
      receipt = await deps.credit(txHash);
    } catch (error) {
      const failure = isFundingError(error)
        ? error
        : new FundingError('FUNDING_CREDIT_UNAVAILABLE', { cause: error });
      const outOfTime = Date.now() - startedAt >= waitBudgetMs;
      if (failure.retryable && !outOfTime) {
        stage({ name: 'confirming', attempt });
        await deps.sleep(checkEveryMs);
        continue;
      }
      return stage({ name: 'failed', error: failure });
    }

    if (!receipt.credited && receipt.replayed) {
      return stage({ name: 'already-credited', receipt });
    }

    if (!receipt.credited) {
      // A 200 that credits nothing is not a success this screen can name.
      return stage({
        name: 'failed',
        error: new FundingError('FUNDING_CREDIT_UNAVAILABLE', {
          status: 200,
          cause: new Error('credit answer credited nothing'),
        }),
      });
    }

    // Credited. Now let the balance itself say so, because that is the number
    // the person is looking at; a movement the ledger has not surfaced yet is
    // reported as "settled: false" rather than as a failure.
    const settled = await balanceShowsCredit(deps, receipt, {
      startedAt,
      waitBudgetMs,
      checkEveryMs,
      isCancelled: deps.isCancelled,
    });

    return stage({ name: 'credited', receipt, settled });
  }
};

const balanceShowsCredit = async (
  deps: TopUpRunDeps,
  receipt: FundingCreditReceipt,
  window: {
    startedAt: number;
    waitBudgetMs: number;
    checkEveryMs: number;
    isCancelled?: () => boolean;
  },
): Promise<boolean> => {
  const target = receipt.balance?.creditedUsdc ?? null;
  for (;;) {
    if (window.isCancelled?.()) {
      return false;
    }
    try {
      const balance = await deps.balance();
      const credited = balance.credit.creditedUsdc;
      if (target === null || compareDecimal(credited, target) >= 0) {
        return true;
      }
    } catch {
      // A balance read that fails does not un-credit anything; the receipt is
      // still the receipt. It only means "not shown yet".
    }
    if (Date.now() - window.startedAt >= window.waitBudgetMs) {
      return false;
    }
    await deps.sleep(window.checkEveryMs);
  }
};

/** Compare two non-negative decimal strings without a float. */
export const compareDecimal = (left: string, right: string): number => {
  const a = usdcTextToBaseUnits(left, 6);
  const b = usdcTextToBaseUnits(right, 6);
  if (a === null || b === null) {
    return 0;
  }
  const leftUnits = BigInt(a);
  const rightUnits = BigInt(b);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? 1 : -1;
};
