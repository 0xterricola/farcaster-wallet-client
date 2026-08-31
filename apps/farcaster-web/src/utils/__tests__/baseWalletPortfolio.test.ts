import type { ApiEthFungibleTokenPosition } from 'farcaster-client-data';
import { describe, expect, it } from 'vitest';

import {
  formatPortfolioBalance,
  formatPortfolioUsd,
  selectBasePortfolioPositions,
} from '~/utils/baseWalletPortfolio';

const position = (overrides: Partial<ApiEthFungibleTokenPosition> = {}) =>
  ({
    id: 'test',
    chain: 'base',
    quantity: { int: '1234567', float: 1.234567 },
    decimals: 6,
    ...overrides,
  }) as ApiEthFungibleTokenPosition;

describe('Base portfolio', () => {
  it('excludes native ETH even when hidden tokens are requested', () => {
    const native = position({
      address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      hidden: true,
    });
    expect(selectBasePortfolioPositions([native], false)).toEqual([]);
    expect(selectBasePortfolioPositions([native], true)).toEqual([]);
  });

  it('keeps WETH and ERC-20 contracts named ETH', () => {
    const weth = position({
      id: 'weth',
      symbol: 'WETH',
      address: '0x4200000000000000000000000000000000000006',
    });
    const namedEth = position({
      id: 'named-eth',
      symbol: 'ETH',
      address: '0x1111111111111111111111111111111111111111',
    });
    expect(selectBasePortfolioPositions([weth, namedEth], false)).toEqual([
      weth,
      namedEth,
    ]);
  });

  it('filters other chains and both kinds of hidden flags without mutating input', () => {
    const entries = [
      position({ id: 'small', value: 1 }),
      position({ id: 'other', chain: 'ethereum', value: 1000 }),
      position({ id: 'hidden', hidden: true }),
      position({ id: 'user-hidden', userHidden: true }),
      position({ id: 'large', value: 10 }),
    ];
    expect(
      selectBasePortfolioPositions(entries, false).map((p) => p.id),
    ).toEqual(['large', 'small']);
    expect(entries.map((p) => p.id)).toEqual([
      'small',
      'other',
      'hidden',
      'user-hidden',
      'large',
    ]);
    expect(selectBasePortfolioPositions(entries, true)).toHaveLength(4);
  });

  it('places missing prices after priced positions, including actual zero', () => {
    const entries = [
      position({ id: 'unknown' }),
      position({ id: 'zero', value: 0 }),
    ];
    expect(
      selectBasePortfolioPositions(entries, false).map((p) => p.id),
    ).toEqual(['zero', 'unknown']);
  });

  it.each([undefined, NaN, Infinity, -1])(
    'does not turn invalid USD values into zero: %s',
    (value) => {
      expect(formatPortfolioUsd(value)).toBe('—');
    },
  );

  it('distinguishes zero, dust, and priced holdings', () => {
    expect(formatPortfolioUsd(0)).toBe('$0.00');
    expect(formatPortfolioUsd(0.001)).toBe('<$0.01');
    expect(formatPortfolioUsd(12.345)).toBe('$12.35');
  });

  it('uses integer units and decimals rather than the approximate float balance', () => {
    expect(
      formatPortfolioBalance(
        position({ quantity: { int: '1234567', float: 99 } }),
      ),
    ).toEqual({ display: '1.234567', exact: '1.234567' });
  });

  it('preserves integer balances beyond the safe JS number range', () => {
    expect(
      formatPortfolioBalance(
        position({
          decimals: 0,
          quantity: { int: '900719925474099312345', float: 0 },
        }),
      ),
    ).toEqual({
      display: '900,719,925,474,099,312,345',
      exact: '900719925474099312345',
    });
  });

  it('distinguishes very small balances from zero', () => {
    expect(
      formatPortfolioBalance(
        position({ decimals: 18, quantity: { int: '1', float: 0 } }),
      ).display,
    ).toBe('<0.000001');
    expect(
      formatPortfolioBalance(position({ quantity: { int: '0', float: 0 } }))
        .display,
    ).toBe('0');
  });

  it('marks truncated fractions and retains the exact value', () => {
    expect(
      formatPortfolioBalance(
        position({ decimals: 8, quantity: { int: '123456789', float: 0 } }),
      ),
    ).toEqual({ display: '1.234567…', exact: '1.23456789' });
  });

  it.each([
    position({ decimals: undefined }),
    position({ decimals: -1 }),
    position({ decimals: 1.5 }),
    position({ decimals: 256 }),
    position({ quantity: { int: '1.2', float: 1.2 } }),
  ])('handles malformed balance metadata without throwing', (entry) => {
    expect(formatPortfolioBalance(entry).display).toBe('—');
  });
});
