/**
 * The honest savings line.
 *
 * The claim this module refuses to make: "99% cheaper than the plan you pay
 * for". Surp's own price page makes it (per-million-token, blended), and it is
 * true about tokens and false about a bill. Measured against the live service
 * on 2026-10-21, Surp answers an unpaid request with its actual price — and
 * every size of chat request, from 5 tokens to 4000, came back as `$0.0100`,
 * because Surp bills in whole cents with a floor (`floor_cents = 1`) and rounds
 * up. A chat-sized request costs about a millionth of a cent in tokens and is
 * still billed a cent.
 *
 * So the bill is dominated by the per-request charge, and that is the number a
 * savings line has to use:
 *
 *   Surp, per month  =  (what Surp charges for one request) x (requests/month)
 *   the plan         =  what the plan costs whether you use it or not
 *
 * What is live: the per-request charge (asked of Surp on the day, or from the
 * live quote the caller already holds) and the per-million rate on the board.
 * What is not live, and says so on screen: the plan's price, because a
 * subscription price is a fact about someone else's website. It is carried with
 * its source URL and the day it was read, and the surface shows both.
 *
 * The comparison is like-for-like where the board has the model: a Claude plan
 * is compared against the cheapest Surp route for Claude, not against the
 * cheapest route of any kind.
 */

import type { SurpPriceBoard, SurpModelPrice } from './pricing';

/**
 * A subscription somebody is paying for, carried with where the number came
 * from. These are read from the vendor's public pricing page; nothing here is
 * a live read, and nothing here is ever presented as one.
 */
export interface PlanReference {
  id: string;
  /** What the owner calls the plan. */
  label: string;
  /** The plan's own monthly price in whole US dollars. */
  usdPerMonth: number;
  /** Where that price is published. Shown to the owner, next to the number. */
  source: string;
  /** The day it was read. Shown next to the number. */
  readOn: string;
  /** Which models on the board stand in for that plan, best first. */
  modelHints: readonly string[];
}

export const PLAN_REFERENCES: readonly PlanReference[] = [
  {
    id: 'claude-pro',
    label: 'Claude Pro',
    usdPerMonth: 20,
    source: 'https://www.anthropic.com/pricing',
    readOn: '2026-10-21',
    modelHints: ['claude-sonnet-4.6', 'claude-opus-4.6'],
  },
  {
    id: 'chatgpt-plus',
    label: 'ChatGPT Plus',
    usdPerMonth: 20,
    source: 'https://openai.com/chatgpt/pricing/',
    readOn: '2026-10-21',
    modelHints: ['gpt-5.2', 'gpt-5'],
  },
];

/** How much somebody uses their agent, in the two numbers they can picture. */
export interface UsageGuess {
  messagesPerDay: number;
  tokensPerMessage: number;
}

/** 20 messages a day, a medium paragraph in and out each way. */
export const DEFAULT_USAGE_GUESS: UsageGuess = {
  messagesPerDay: 20,
  tokensPerMessage: 900,
};

export const requestsPerMonth = (usage: UsageGuess): number =>
  Math.max(0, usage.messagesPerDay) * 30;

export const tokensPerMonth = (usage: UsageGuess): number =>
  requestsPerMonth(usage) * Math.max(0, usage.tokensPerMessage);

/**
 * The cheapest Surp route for a plan's model, from the live board — or null if
 * the board does not carry that model, in which case the surface says so
 * instead of comparing against something else and calling it the same thing.
 */
export const cheapestRouteFor = (
  board: SurpPriceBoard,
  plan: PlanReference,
): SurpModelPrice | null => {
  const wanted = plan.modelHints.map((hint) => hint.toLowerCase());
  const matches = board.models.filter((model) =>
    wanted.some((hint) => model.model.toLowerCase() === hint),
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, next) =>
    next.usdPerMillion < best.usdPerMillion ? next : best,
  );
};

export interface SavingsComparison {
  plan: PlanReference;
  /** The model on the board standing in for the plan, when there is one. */
  route: SurpModelPrice | null;
  usage: UsageGuess;
  requests: number;
  /** What one request is billed — the charge Surp quoted, floor included. */
  perRequestUsd: number;
  /** per-request charge x requests a month. */
  surpMonthlyUsd: number;
  planMonthlyUsd: number;
  /** Signed: positive is a saving over the plan. */
  savedMonthlyUsd: number;
  savedPercent: number;
  /**
   * How many requests a month the plan's own price would buy on Surp. The
   * number that makes the trade-off legible without any percentages.
   */
  requestsThePlanWouldBuy: number;
}

/**
 * The month is `the charge Surp quoted` x `requests`. The charge is used
 * exactly as Surp stated it — no rounding of our own, in either direction,
 * because inventing a rounder number than the invoice is still inventing one.
 * The floor is already inside the quote: it is what Surp answered when asked.
 */
export const compareToPlan = (
  plan: PlanReference,
  board: SurpPriceBoard,
  usage: UsageGuess,
  perRequestUsd: number,
): SavingsComparison | null => {
  if (!Number.isFinite(perRequestUsd) || perRequestUsd <= 0) return null;
  const route = cheapestRouteFor(board, plan);
  const requests = requestsPerMonth(usage);
  const surpMonthlyUsd = perRequestUsd * requests;
  const savedMonthlyUsd = plan.usdPerMonth - surpMonthlyUsd;
  return {
    plan,
    route,
    usage,
    requests,
    perRequestUsd,
    surpMonthlyUsd,
    planMonthlyUsd: plan.usdPerMonth,
    savedMonthlyUsd,
    savedPercent:
      plan.usdPerMonth > 0 ? (savedMonthlyUsd / plan.usdPerMonth) * 100 : 0,
    requestsThePlanWouldBuy: Math.floor(plan.usdPerMonth / perRequestUsd),
  };
};

const money = (value: number): string => `$${value.toFixed(2)}`;

/**
 * The line the owner reads. Plain words, the plan first (that is what they are
 * paying now), the honest arithmetic second, and no percentage when the month
 * is close to the plan's price — a 4% saving is not a pitch.
 */
export const savingsSentence = (comparison: SavingsComparison): string => {
  const { plan, usage, surpMonthlyUsd, planMonthlyUsd, savedMonthlyUsd } =
    comparison;
  const use = `about ${usage.messagesPerDay} messages a day`;
  if (savedMonthlyUsd <= 0) {
    return `${plan.label} is ${money(planMonthlyUsd)} a month like this. At ${use} you would pay about ${money(surpMonthlyUsd)} on Surp, so keeping your ${plan.label} plan costs about the same or less.`;
  }
  return `${plan.label} is ${money(planMonthlyUsd)} a month whether you use it or not. At ${use} the same work costs about ${money(surpMonthlyUsd)} on Surp — about ${money(savedMonthlyUsd)} less this month.`;
};

/** Where the numbers came from, in one line the owner can check. */
export const savingsProvenance = (
  board: SurpPriceBoard,
  plan: PlanReference,
): string =>
  `Surp's prices were read from surp.ivc.lol on ${board.generatedAt.slice(0, 10) || 'the day you looked'}; ${plan.label}'s price was read from ${plan.source} on ${plan.readOn}.`;