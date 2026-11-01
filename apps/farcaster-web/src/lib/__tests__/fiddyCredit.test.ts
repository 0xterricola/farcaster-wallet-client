// @vitest-environment jsdom
/**
 * The Fiddy balance, measured where it is decided: money as text, the three
 * routes, and the wait after a send.
 *
 * The load-bearing tests here are the ones about what this client REFUSES:
 *
 *   - money never becomes a float (`dollarsToBaseUnits` refuses a third decimal
 *     rather than rounding somebody's money);
 *   - every path is on this origin, with the session cookie riding along — a
 *     cross-origin call would carry neither the cookie nor a CORS grant;
 *   - `credit` sends exactly `{ txHash }`, because the route refuses any other
 *     field on purpose;
 *   - a transfer Base has not confirmed is "still confirming", not a failure and
 *     not a success, and the wait gives up with the server's own code rather
 *     than inventing one;
 *   - a second submit of the same hash is reported as already credited, never as
 *     a second credit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  baseUnitsToUsdcText,
  compareDecimal,
  dollarsToBaseUnits,
  fetchFundingBalance,
  fetchFundingConfig,
  formatUsd,
  type FundingCreditReceipt,
  FundingError,
  fundingFailureCode,
  fundingFailureLine,
  fundingFailureOwnerLine,
  isBelowMinimum,
  parseFundingBalance,
  parseFundingConfig,
  parseFundingCreditReceipt,
  runTopUp,
  submitFundingCredit,
  usdcTextToBaseUnits,
} from '~/lib/fiddyCredit';

const TREASURY = '0xe4c848a6fa503762e95ad862cd1e5f7f9f0aab5f';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const configBody = {
  ok: true,
  chain: { id: 8453, name: 'Base', caip2: 'eip155:8453' },
  asset: { symbol: 'USDC', address: USDC, decimals: 6 },
  treasury: { address: TREASURY, short: '0xe4c8…ab5f' },
  minimum: { usdc: '1.00', baseUnits: '1000000' },
  confirmations: 5,
  presets: [
    { usd: 5, label: 'Top up $5', usdc: '5.00', baseUnits: '5000000' },
    { usd: 10, label: 'Top up $10', usdc: '10.00', baseUnits: '10000000' },
    { usd: 25, label: 'Top up $25', usdc: '25.00', baseUnits: '25000000' },
  ],
  creditNote: 'A top-up becomes a Fiddy balance credit.',
};

const balanceBody = {
  ok: true,
  credit: {
    availableUsdc: '3.50',
    availableBaseUnits: '3500000',
    creditedUsdc: '5.00',
    creditedBaseUnits: '5000000',
    spentUsdc: '1.50',
    spentBaseUnits: '1500000',
  },
  entries: [
    {
      id: 2,
      kind: 'spend',
      status: 'spent',
      amount: { usdc: '1.50', baseUnits: '1500000' },
      txHashShort: null,
      time: '2026-10-23T12:00:00.000Z',
    },
  ],
  note: 'Your Fiddy balance is a platform credit you can spend inside Fiddy.',
};

const creditBody = (patch: Record<string, unknown> = {}) => ({
  ok: true,
  credited: true,
  replayed: false,
  txHash: `0x${'ab'.repeat(32)}`,
  amount: { usdc: '5.00', baseUnits: '5000000' },
  confirmations: 9,
  creditedAt: 1758000000,
  balance: { availableUsdc: '5.00', creditedUsdc: '5.00', spentUsdc: '0.00' },
  note: 'Credited to your Fiddy balance.',
  ...patch,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const failing = (code: string, status: number, retryable = false) =>
  jsonResponse({ ok: false, code, message: code, retryable }, status);

const stubFetch = (handler: (url: string, init?: RequestInit) => Response) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    handler(String(url), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('money is text, never a float', () => {
  it('prints a dollar amount with two decimals', () => {
    expect(formatUsd('5.00')).toBe('$5.00');
    expect(formatUsd('5')).toBe('$5.00');
    expect(formatUsd('3.5')).toBe('$3.50');
  });

  it('turns dollars into the base units the server speaks', () => {
    expect(dollarsToBaseUnits('5')).toEqual({
      baseUnits: '5000000',
      usdc: '5.00',
    });
    expect(dollarsToBaseUnits('12.5')?.baseUnits).toBe('12500000');
    expect(dollarsToBaseUnits('$1')?.baseUnits).toBe('1000000');
  });

  it('refuses a third decimal instead of rounding somebody’s money', () => {
    expect(dollarsToBaseUnits('5.001')).toBeNull();
    expect(dollarsToBaseUnits('five')).toBeNull();
    expect(dollarsToBaseUnits('-5')).toBeNull();
    expect(dollarsToBaseUnits('')).toBeNull();
  });

  it('reads base units back into dollars without losing a cent', () => {
    expect(baseUnitsToUsdcText('5000000')).toBe('5.000000');
    expect(usdcTextToBaseUnits('1.00')).toBe('1000000');
    expect(usdcTextToBaseUnits('5.0000001')).toBeNull();
  });

  it('knows the $1 floor the server enforces', () => {
    expect(isBelowMinimum('999999', '1000000')).toBe(true);
    expect(isBelowMinimum('1000000', '1000000')).toBe(false);
    expect(compareDecimal('5.00', '3.50')).toBe(1);
    expect(compareDecimal('5.00', '5.00')).toBe(0);
    expect(compareDecimal('1.00', '5.00')).toBe(-1);
  });
});

describe('the three routes, all on this origin', () => {
  it('reads the public config with the session cookie, never cross-origin', async () => {
    const fetchMock = stubFetch((url) =>
      url === '/api/fiddy/funding/config'
        ? jsonResponse(configBody)
        : jsonResponse({ ok: false }, 404),
    );

    const config = await fetchFundingConfig();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/fiddy/funding/config');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: 'include',
    });
    expect(config.treasury.address).toBe(TREASURY);
    expect(config.caip19).toBe(`eip155:8453/erc20:${USDC}`);
    expect(config.presets.map((preset) => preset.usd)).toEqual([5, 10, 25]);
    expect(config.minimum.baseUnits).toBe('1000000');
  });

  it('sends exactly the hash, because the route refuses any other field', async () => {
    const fetchMock = stubFetch(() => jsonResponse(creditBody()));
    const hash = `0x${'ab'.repeat(32)}`;

    const receipt = await submitFundingCredit(hash);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/fiddy/funding/credit');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ txHash: hash });
    expect(receipt.credited).toBe(true);
    expect(receipt.amount.usdc).toBe('5.00');
  });

  it('reads the balance, and keeps every amount a string', async () => {
    stubFetch(() => jsonResponse(balanceBody));

    const balance = await fetchFundingBalance();

    expect(balance.credit.availableUsdc).toBe('3.50');
    expect(balance.entries[0].amount.baseUnits).toBe('1500000');
  });

  it('names the server’s code instead of guessing one', async () => {
    stubFetch(() => failing('TRANSFER_TOO_SMALL', 422));

    await expect(submitFundingCredit(`0x${'ab'.repeat(32)}`)).rejects.toThrow(
      FundingError,
    );
    try {
      await submitFundingCredit(`0x${'ab'.repeat(32)}`);
    } catch (error) {
      expect(fundingFailureCode(error)).toBe('TRANSFER_TOO_SMALL');
      expect(fundingFailureOwnerLine(error)).toContain('$1 minimum');
    }
  });

  it('treats an unreadable answer as unreadable, not as an empty balance', async () => {
    stubFetch(() =>
      jsonResponse({ ok: true, credit: { availableUsdc: '3.50' } }),
    );

    await expect(fetchFundingBalance()).rejects.toMatchObject({
      code: 'UNREADABLE',
    });
  });

  it('reads a transfer that has landed, and one that was already credited', () => {
    const replayed = parseFundingCreditReceipt(
      creditBody({ credited: false, replayed: true }),
    );
    expect(replayed.credited).toBe(false);
    expect(replayed.replayed).toBe(true);
  });

  it('keeps the config’s own words for a credit', () => {
    const config = parseFundingConfig(configBody);
    expect(config.creditNote).toBe('A top-up becomes a Fiddy balance credit.');
    expect(parseFundingBalance(balanceBody).note).toContain('platform credit');
  });

  it('has a sentence for every code it can name', () => {
    const codes = [
      'TX_NOT_FOUND',
      'TX_FAILED',
      'NO_MATCHING_TRANSFER',
      'TOKEN_NOT_SUPPORTED',
      'TRANSFER_TOO_SMALL',
      'INSUFFICIENT_CONFIRMATIONS',
      'AUTH_REQUIRED',
      'PRODUCTION_AUTH_REQUIRED',
      'ORIGIN_NOT_ALLOWED',
      'RATE_LIMITED',
      'RPC_UNAVAILABLE',
      'FUNDING_STORE_UNAVAILABLE',
      'TREASURY_NOT_CONFIGURED',
      'NOT_CONNECTED',
      'WRONG_NETWORK',
      'NOT_ENOUGH_USDC',
      'DECLINED',
      'UNREACHABLE',
      'UNREADABLE',
      'ALREADY_CREDITED',
    ] as const;
    for (const code of codes) {
      const line = fundingFailureLine(code);
      expect(line.length).toBeGreaterThan(20);
      // No wallet-balance claim, ever: it is a Fiddy balance.
      expect(line.toLowerCase()).not.toMatch(
        /your funds|held by fiddy|custody/,
      );
    }
  });
});

describe('waiting for a transfer to land', () => {
  const hash = `0x${'cd'.repeat(32)}`;

  const receipt = (patch: Partial<FundingCreditReceipt> = {}) => ({
    credited: true,
    replayed: false,
    txHash: hash,
    amount: { usdc: '5.00', baseUnits: '5000000' },
    confirmations: 9,
    creditedAt: 1758000000,
    balance: { availableUsdc: '5.00', creditedUsdc: '5.00', spentUsdc: '0.00' },
    note: 'ok',
    ...patch,
  });

  const stages: string[] = [];
  const deps = (
    overrides: Partial<Parameters<typeof runTopUp>[0]['deps']> = {},
  ) => ({
    credit: async () => receipt(),
    balance: async () => parseFundingBalance(balanceBody),
    sleep: async () => undefined,
    onStage: (stage: { name: string }) => stages.push(stage.name),
    ...overrides,
  });

  it('re-submits while Base is still confirming, then proves it in the balance', async () => {
    stages.length = 0;
    let attempts = 0;
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        credit: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new FundingError('INSUFFICIENT_CONFIRMATIONS', {
              status: 409,
              retryable: true,
            });
          }
          return receipt();
        },
        balance: async () =>
          parseFundingBalance({
            ...balanceBody,
            credit: { ...balanceBody.credit, creditedUsdc: '5.00' },
          }),
      }),
    });

    expect(attempts).toBe(2);
    expect(outcome.name).toBe('credited');
    // One "checking" for the submit, one "confirming" while Base settles, then
    // the landing: the screen is never told "checking" twice for one wait.
    expect(stages).toEqual(['checking', 'confirming', 'credited']);
  });

  it('waits through a hash Base has not seen yet, then reports it landed', async () => {
    let attempts = 0;
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        credit: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new FundingError('TX_NOT_FOUND', { status: 404 });
          }
          return receipt();
        },
      }),
    });

    expect(attempts).toBe(2);
    expect(outcome.name).toBe('credited');
  });

  it('stops at once on a transfer that cannot be credited', async () => {
    let attempts = 0;
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        credit: async () => {
          attempts += 1;
          throw new FundingError('NO_MATCHING_TRANSFER', { status: 422 });
        },
      }),
    });

    expect(attempts).toBe(1);
    expect(outcome.name).toBe('failed');
    if (outcome.name === 'failed') {
      expect(outcome.error.code).toBe('NO_MATCHING_TRANSFER');
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('gives up with the server’s own code when confirming never finishes', async () => {
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        credit: async () => {
          throw new FundingError('INSUFFICIENT_CONFIRMATIONS', {
            status: 409,
            retryable: true,
          });
        },
        waitBudgetMs: 0,
      }),
    });

    expect(outcome.name).toBe('failed');
    if (outcome.name === 'failed') {
      expect(outcome.error.code).toBe('INSUFFICIENT_CONFIRMATIONS');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('reports a second submit as already credited, never as a second credit', async () => {
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        credit: async () => receipt({ credited: false, replayed: true }),
      }),
    });

    expect(outcome.name).toBe('already-credited');
  });

  it('says the balance has not shown it yet rather than failing', async () => {
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({
        // The ledger credited it (the answer says so) while the balance read
        // still shows the old total: a moment, not a problem.
        balance: async () =>
          parseFundingBalance({
            ...balanceBody,
            credit: { ...balanceBody.credit, creditedUsdc: '0.00' },
          }),
        waitBudgetMs: 0,
      }),
    });

    expect(outcome.name).toBe('credited');
    if (outcome.name === 'credited') {
      expect(outcome.settled).toBe(false);
    }
  });

  it('treats a credit that credits nothing as a failure it can name', async () => {
    const outcome = await runTopUp({
      txHash: hash,
      deps: deps({ credit: async () => receipt({ credited: false }) }),
    });

    expect(outcome.name).toBe('failed');
  });
});
