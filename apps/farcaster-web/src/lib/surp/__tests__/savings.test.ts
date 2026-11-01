/**
 * The savings line, on real numbers.
 *
 * `price-board.json` and `chat-402.json` in `fixtures/` are verbatim captures
 * from https://surp.ivc.lol on 2026-10-21 (the 402 is the body of an unpaid
 * probe — asking for the price costs nothing). They are here so the arithmetic
 * is checked against what the service actually said, not against a shape
 * somebody imagined: the point of these tests is that the number the owner
 * reads is the number Surp charges.
 *
 * The load-bearing case is `bills the floor, not the token rate`. Surp's own
 * price page reports ~99% savings per million tokens, and it is right about
 * tokens and wrong about a bill: Surp bills whole cents with a $0.01 floor, so
 * every chat-sized request costs a cent whatever the token rate says. A savings
 * line built on the token rate would be off by orders of magnitude, and that is
 * what the second test pins down.
 */

import { describe, expect, it } from 'vitest';

import { parsePriceBoard, parseRequestQuote } from '~/lib/surp/pricing';
import {
  cheapestRouteFor,
  compareToPlan,
  DEFAULT_USAGE_GUESS,
  PLAN_REFERENCES,
  requestsPerMonth,
  type SavingsComparison,
  savingsSentence,
  tokensPerMonth,
} from '~/lib/surp/savings';

import chat402 from './fixtures/chat-402.json';
import priceBoard from './fixtures/price-board.json';

const board = parsePriceBoard(priceBoard, 0.7);
const quote = parseRequestQuote(chat402);
const claudePro = PLAN_REFERENCES.find((plan) => plan.id === 'claude-pro')!;

describe('the live captures still parse', () => {
  it('reads the price board Surp served', () => {
    expect(board).not.toBeNull();
    expect(board!.models.length).toBeGreaterThan(50);
    expect(board!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads the request price out of an unpaid 402', () => {
    expect(quote).not.toBeNull();
    expect(quote!.priceUsd).toBeCloseTo(0.01, 6);
    expect(quote!.amountAtomicUsdc).toBe(10000n);
  });
});

describe('the arithmetic the owner reads', () => {
  it('bills the floor, not the token rate', () => {
    const route = cheapestRouteFor(board!, claudePro);
    expect(route).not.toBeNull();
    const comparison = compareToPlan(
      claudePro,
      board!,
      DEFAULT_USAGE_GUESS,
      quote!.priceUsd,
    )!;

    // What the token rate alone would predict for a month of this usage.
    const tokenOnly =
      (tokensPerMonth(DEFAULT_USAGE_GUESS) / 1_000_000) * route!.usdPerMillion;
    // A few cents a month, against a bill of dollars: the floor is what is
    // charged and the token rate is noise beside it — a factor of ~500 for this
    // plan, and the factor grows on cheaper models.
    expect(tokenOnly).toBeLessThan(0.05);
    expect(comparison.surpMonthlyUsd).toBeCloseTo(
      0.01 * requestsPerMonth(DEFAULT_USAGE_GUESS),
      6,
    );
    expect(comparison.surpMonthlyUsd / tokenOnly).toBeGreaterThan(100);
  });

  it('uses the charge Surp quoted, and does not round it into a nicer one', () => {
    const comparison = compareToPlan(
      claudePro,
      board!,
      { messagesPerDay: 20, tokensPerMessage: 900 },
      0.0100001,
    )!;
    expect(comparison.perRequestUsd).toBe(0.0100001);
    expect(comparison.surpMonthlyUsd).toBeCloseTo(0.0100001 * 600, 9);
  });

  it('compares like for like, on the plan’s own model', () => {
    const route = cheapestRouteFor(board!, claudePro);
    expect(route!.model.toLowerCase()).toContain('claude');
  });

  it('says nothing when the board does not carry the plan’s model', () => {
    const plan = {
      ...claudePro,
      modelHints: ['a-model-nobody-routes'],
    };
    expect(cheapestRouteFor(board!, plan)).toBeNull();
    // The comparison is still possible — it just cannot name a route, and the
    // sentence must not invent one.
    const comparison = compareToPlan(plan, board!, DEFAULT_USAGE_GUESS, 0.01)!;
    expect(comparison.route).toBeNull();
    expect(savingsSentence(comparison)).not.toContain('claude');
  });

  it('refuses to call a wash a saving', () => {
    const comparison = compareToPlan(
      claudePro,
      board!,
      { messagesPerDay: 2000, tokensPerMessage: 900 },
      0.01,
    )!;
    expect(comparison.savedMonthlyUsd).toBeLessThan(0);
    const line = savingsSentence(comparison);
    // No percentage pitch and no "less" claim when there is nothing saved.
    expect(line).toContain('costs about the same or less');
    expect(line).not.toContain('less this month');
    expect(line).not.toContain('%');
  });

  it('writes the saving in the plan’s own words', () => {
    const comparison: SavingsComparison = compareToPlan(
      claudePro,
      board!,
      DEFAULT_USAGE_GUESS,
      quote!.priceUsd,
    )!;
    const line = savingsSentence(comparison);
    expect(line).toContain(
      'Claude Pro is $20.00 a month whether you use it or not',
    );
    expect(line).toContain('about $6.00 on Surp');
    expect(line).toContain('about 20 messages a day');
  });

  it('has no floor of its own to write down', () => {
    // Whatever the service charges is what a month costs. If this module held a
    // $0.01 assumption, these two months would come out equal.
    const cheap = compareToPlan(
      claudePro,
      board!,
      DEFAULT_USAGE_GUESS,
      0.0001,
    )!;
    const dear = compareToPlan(claudePro, board!, DEFAULT_USAGE_GUESS, 0.01)!;
    expect(cheap.perRequestUsd).toBe(0.0001);
    expect(dear.surpMonthlyUsd / cheap.surpMonthlyUsd).toBeCloseTo(100, 6);
    // ...and the floor the live service really charges is where the quote says
    // it is: the 402's atomic amount, read into dollars.
    expect(quote!.priceUsd).toBeCloseTo(
      Number(quote!.amountAtomicUsdc!) / 1e6,
      9,
    );
    expect(quote!.priceUsd).toBe(0.01);
  });

  it('changes the bill when the usage changes, and says so', () => {
    const light = compareToPlan(
      claudePro,
      board!,
      { messagesPerDay: 2, tokensPerMessage: 900 },
      0.01,
    )!;
    const heavy = compareToPlan(
      claudePro,
      board!,
      { messagesPerDay: 200, tokensPerMessage: 900 },
      0.01,
    )!;
    expect(light.surpMonthlyUsd).toBeLessThan(heavy.surpMonthlyUsd);
    expect(light.requests).toBe(60);
    expect(heavy.requests).toBe(6000);
  });
});
