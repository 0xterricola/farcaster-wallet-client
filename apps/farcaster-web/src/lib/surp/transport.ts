/**
 * One place that talks to Surp, and one honest answer when it cannot.
 *
 * Surp (surp.ivc.lol) is a pay-as-you-go inference router: it charges per
 * request in USDC on Base, and it also hands out prepaid API keys. Both rails
 * are spoken to from the browser, so this module is the single seam that knows
 * the addresses, the deadline, and what a refusal means.
 *
 * THE CROSS-ORIGIN FACT THIS MODULE EXISTS TO STATE PLAINLY:
 * a page served from fiddy.fun cannot read surp.ivc.lol. Surp's responses carry
 * no `access-control-allow-origin`, so the browser refuses the response before
 * any of this code sees it, and a cross-origin POST is refused at the preflight
 * (surp answers OPTIONS with 404). Every call here therefore fails with the
 * same, specific sentence naming that cause — never a generic "something went
 * wrong", and never a silent empty board that would read as "there is nothing
 * there". Read it out of `SurpUnreachableError.code === 'CROSS_ORIGIN'`.
 *
 * The fix is on the other side (surp must send the header for the fiddy.fun
 * origin), so this module is written to become live the moment it does, and the
 * surfaces that use it report the blocked state honestly until then.
 */

/** The service. One constant, so a test can point at a recorder instead. */
export const SURP_BASE_URL = 'https://surp.ivc.lol';

/** How long a page waits before it calls the service unreachable. */
export const SURP_TIMEOUT_MS = 8000;

export type SurpFailureCode =
  | 'CROSS_ORIGIN'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'MALFORMED';

export class SurpUnreachableError extends Error {
  constructor(
    public code: SurpFailureCode,
    /** What the owner can do about it, in their words. */
    public ownerLine: string,
    public status?: number,
  ) {
    super(code);
    this.name = 'SurpUnreachableError';
  }
}

/**
 * A browser tells one cross-origin tale and it is always a TypeError with no
 * status — the network refusal and the CORS refusal are indistinguishable from
 * inside the page. Because every call here is cross-origin by construction, the
 * truthful label for a statusless failure is the cross-origin one: a same-origin
 * address would have answered with a status.
 */
const networkRefusal = (caught: unknown): SurpUnreachableError => {
  if (caught instanceof Error && caught.name === 'TimeoutError') {
    return new SurpUnreachableError(
      'TIMEOUT',
      'Surp took too long to answer. Try again in a moment.',
    );
  }
  return new SurpUnreachableError(
    'CROSS_ORIGIN',
    'Your browser blocked this page from reading Surp directly. Surp has to allow fiddy.fun before this can work — nothing is wrong with your wallet or your key.',
  );
};

const refusalFor = (status: number): SurpUnreachableError => {
  const ownerLine =
    status === 402
      ? 'Surp asked to be paid for that request.'
      : status === 404
        ? 'That address answered, but not with what was asked for. Surp may have moved it.'
        : status >= 500
          ? 'Surp itself is having trouble right now. Try again in a moment.'
          : 'Surp refused that request.';
  return new SurpUnreachableError('REFUSED', ownerLine, status);
};

/**
 * AbortSignal.timeout is not in every runtime this bundle can meet (jsdom in
 * tests, older Safari). A missing deadline is better than a thrown TypeError:
 * the request still happens, it just has no client-side timeout. Same guard the
 * agent-service module uses.
 */
export const timeoutSignal = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;

/** The three shape checks every parser in this folder shares. */
export const asRecord = (
  value: unknown,
): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

export const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export interface SurpRequest {
  path: string;
  method?: 'GET' | 'POST';
  /** Query values, joined and encoded here so callers never build a URL. */
  query?: Record<string, string | number>;
  body?: unknown;
  /** Headers the caller needs (a Bearer key, or the x402 payment header). */
  headers?: Record<string, string>;
}

export const surpUrl = (
  path: string,
  query?: Record<string, string | number>,
): string => {
  const url = new URL(path, SURP_BASE_URL);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  return url.toString();
};

/**
 * Ask Surp something and return its JSON — or throw a sentence that says why
 * not. A 402 is NOT an error case for the price probe, so callers that expect
 * one ask for `allow402`.
 */
export const surpJson = async <T>(
  request: SurpRequest,
  options: { allow402?: boolean; timeoutMs?: number } = {},
): Promise<T> => {
  const { path, method = 'GET', query, body, headers } = request;
  let response: Response;
  try {
    response = await fetch(surpUrl(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeoutSignal(options.timeoutMs ?? SURP_TIMEOUT_MS),
    });
  } catch (caught) {
    throw networkRefusal(caught);
  }

  if (!response.ok && !(options.allow402 && response.status === 402)) {
    throw refusalFor(response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new SurpUnreachableError(
      'MALFORMED',
      'Surp answered with something this page could not read.',
    );
  }
};