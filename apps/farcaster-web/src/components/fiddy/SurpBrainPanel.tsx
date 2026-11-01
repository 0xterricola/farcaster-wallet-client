/**
 * The Surp option, inside "Add a brain".
 *
 * Three things live here, in this order, because this is the order the owner
 * needs them in:
 *
 *   1. what it would actually cost   the honest savings line, computed from
 *                                    Surp's live prices and the request charge
 *                                    Surp quotes, against the plan they are
 *                                    paying for today. Both numbers say where
 *                                    they came from; the plan's price is dated
 *                                    and sourced because it is a fact about
 *                                    somebody else's website, not a live feed.
 *   2. a key, made here              one press, no account, and the key shown
 *                                    once with the balance it really has.
 *   3. what paying looks like        the live request Surp will charge for, and
 *                                    the sentence the owner reads before their
 *                                    wallet is asked to approve anything.
 *
 * It reads Surp directly. When the browser blocks that — Surp does not yet
 * allow this origin, see `lib/surp/transport.ts` — the panel says so in one
 * sentence and does not show a made-up price. A pricing panel that invents
 * numbers when it cannot reach the pricer is worse than one that admits it.
 *
 * Wallet state is a prop, not a hook: this component is rendered by the brain
 * sheet, which is reachable signed out, and it must not require a wallet
 * connection to be on screen. The wallet home (`FiddyWalletHome`) is where the
 * connection is real.
 */

import { Loader2 } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  createSurpKey,
  readSurpKey,
  readSurpKeyBalance,
  type SurpKeyBalance,
  surpKeyMask,
  type SurpKeyRecord,
} from '~/lib/surp/keys';
import {
  fetchPriceBoard,
  fetchRequestQuote,
  type SurpPriceBoard,
  type SurpRequestQuote,
} from '~/lib/surp/pricing';
import {
  compareToPlan,
  DEFAULT_USAGE_GUESS,
  PLAN_REFERENCES,
  type PlanReference,
  type SavingsComparison,
  savingsProvenance,
  savingsSentence,
  type UsageGuess,
} from '~/lib/surp/savings';
import { SurpUnreachableError } from '~/lib/surp/transport';

export interface SurpPricingDeps {
  loadBoard: () => Promise<SurpPriceBoard>;
  loadQuote: (tokens: number) => Promise<SurpRequestQuote>;
}

const liveDeps: SurpPricingDeps = {
  loadBoard: () => fetchPriceBoard(0.7),
  loadQuote: (tokens) => fetchRequestQuote(tokens),
};

type PricingState =
  | { status: 'reading' }
  | { status: 'live'; board: SurpPriceBoard; quote: SurpRequestQuote }
  | { status: 'blocked'; line: string }
  | { status: 'failed'; line: string };

const failureLine = (caught: unknown): string =>
  caught instanceof SurpUnreachableError
    ? caught.ownerLine
    : 'Surp did not answer in a way this page could read. Nothing was charged.';

export interface SurpBrainPanelProps {
  /** Injected in tests; the live reads by default. */
  deps?: SurpPricingDeps;
  /** How the owner uses their agent. */
  usage?: UsageGuess;
  /**
   * Called with a key this panel made (or already had from last time), so the
   * sheet around it can put the same string in its own key field and go on to
   * test or apply it. The panel keeps its own copy; the sheet keeps state.
   */
  onKey?: (key: string) => void;
}

export const SurpBrainPanel = memo(
  ({
    deps = liveDeps,
    usage = DEFAULT_USAGE_GUESS,
    onKey,
  }: SurpBrainPanelProps) => {
    const [pricing, setPricing] = useState<PricingState>({
      status: 'reading',
    });
    const [planId, setPlanId] = useState(PLAN_REFERENCES[0].id);
    const [guess, setGuess] = useState<UsageGuess>(usage);
    const [key, setKey] = useState<SurpKeyRecord | null>(() => readSurpKey());
    const [balance, setBalance] = useState<SurpKeyBalance | null>(null);
    const [keyBusy, setKeyBusy] = useState(false);
    const [keyLine, setKeyLine] = useState<string | null>(null);

    /**
     * A key that already exists on this device is handed straight to the sheet
     * around this panel, so its fields work without the owner pasting a string
     * that is sitting right there. It fires again when a new key is made, which
     * is exactly when the sheet needs the new one.
     */
    const keyValue = key?.key ?? null;
    useEffect(() => {
      if (keyValue) {
        onKey?.(keyValue);
      }
    }, [keyValue, onKey]);

    useEffect(() => {
      let alive = true;
      const read = async () => {
        try {
          const [board, quote] = await Promise.all([
            deps.loadBoard(),
            deps.loadQuote(guess.tokensPerMessage),
          ]);
          if (alive) {
            setPricing({ status: 'live', board, quote });
          }
        } catch (caught) {
          if (!alive) {
            return;
          }
          setPricing(
            caught instanceof SurpUnreachableError &&
              caught.code === 'CROSS_ORIGIN'
              ? { status: 'blocked', line: caught.ownerLine }
              : { status: 'failed', line: failureLine(caught) },
          );
        }
      };
      void read();
      return () => {
        alive = false;
      };
      // The quote depends on the request size, so it is re-asked when the size
      // changes; the board does not, and is fetched again only on mount.
    }, [deps, guess.tokensPerMessage]);

    const plan: PlanReference =
      PLAN_REFERENCES.find((candidate) => candidate.id === planId) ??
      PLAN_REFERENCES[0];

    const comparison: SavingsComparison | null = useMemo(() => {
      if (pricing.status !== 'live') {
        return null;
      }
      return compareToPlan(plan, pricing.board, guess, pricing.quote.priceUsd);
    }, [pricing, plan, guess]);

    const makeKey = useCallback(async () => {
      setKeyBusy(true);
      setKeyLine(null);
      setBalance(null);
      try {
        const record = await createSurpKey('fiddy');
        setKey(record);
        setKeyLine(
          'Saved on this device. Copy it now if you want it somewhere else — this is the only time it is shown in full.',
        );
      } catch (caught) {
        setKeyLine(failureLine(caught));
      } finally {
        setKeyBusy(false);
      }
    }, []);

    const checkBalance = useCallback(async () => {
      if (!key) {
        return;
      }
      setKeyBusy(true);
      try {
        setBalance(await readSurpKeyBalance(key.key));
      } catch (caught) {
        setKeyLine(failureLine(caught));
      } finally {
        setKeyBusy(false);
      }
    }, [key]);

    return (
      <div className="fiddy-connect" data-fiddy="surp">
        <div
          className="fiddy-honest-note"
          role="status"
          aria-live="polite"
          data-fiddy-surp="pricing"
          data-state={pricing.status}
        >
          {pricing.status === 'reading' ? (
            <span className="flex items-center gap-2">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Reading Surp&rsquo;s live prices…
            </span>
          ) : null}
          {pricing.status === 'blocked' || pricing.status === 'failed'
            ? pricing.line
            : null}
          {pricing.status === 'live' && comparison ? (
            <span data-fiddy-surp="savings">{savingsSentence(comparison)}</span>
          ) : null}
        </div>

        {pricing.status === 'live' && comparison ? (
          <>
            <div className="fiddy-field">
              <span className="fiddy-field-label">What you pay for today</span>
              <div role="radiogroup" aria-label="Your current plan">
                {PLAN_REFERENCES.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={candidate.id === plan.id}
                    className={`fiddy-quiet-btn${
                      candidate.id === plan.id ? '' : ' fiddy-quiet-btn-outline'
                    }`}
                    data-fiddy-surp-plan={candidate.id}
                    onClick={() => setPlanId(candidate.id)}
                  >
                    {candidate.label} · ${candidate.usdPerMonth}/month
                  </button>
                ))}
              </div>
            </div>

            <div className="fiddy-field">
              <label className="fiddy-field-label" htmlFor="surp-per-day">
                How much you use it
              </label>
              <input
                id="surp-per-day"
                className="fiddy-input"
                type="number"
                min={1}
                max={500}
                inputMode="numeric"
                value={guess.messagesPerDay}
                data-fiddy-surp="per-day"
                onChange={(event) =>
                  setGuess((current) => ({
                    ...current,
                    messagesPerDay: Math.max(
                      1,
                      Math.min(500, Number(event.target.value) || 1),
                    ),
                  }))
                }
              />
              <span className="fiddy-honest-note">
                messages a day. Surp charges for each request — about{' '}
                {new Intl.NumberFormat(undefined, {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 4,
                }).format(comparison.perRequestUsd)}{' '}
                each — and nothing when you use nothing.
              </span>
            </div>

            <p className="fiddy-honest-note" data-fiddy-surp="provenance">
              {savingsProvenance(pricing.board, plan)}
            </p>
          </>
        ) : null}

        <div className="fiddy-field">
          <span className="fiddy-field-label">Your own key for Surp</span>
          {key ? (
            <div
              className="fiddy-connected"
              role="status"
              aria-live="polite"
              data-fiddy-surp="key"
            >
              <span className="fiddy-connected-dot" aria-hidden="true" />
              <span>
                A key is saved on this device: {surpKeyMask(key.key)}
                {balance
                  ? ` — ${balance.balanceUsdCents}¢ left, ${balance.totalRequests} requests so far.`
                  : ''}
              </span>
              <button
                type="button"
                className="fiddy-quiet-btn fiddy-quiet-btn-inline"
                onClick={() => void checkBalance()}
                disabled={keyBusy}
              >
                Check what is left
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="fiddy-secondary-btn"
              onClick={() => void makeKey()}
              disabled={keyBusy}
              data-fiddy-surp="make-key"
            >
              {keyBusy ? 'Making your key…' : 'Make me a key'}
            </button>
          )}
          {keyLine ? (
            <p role="status" aria-live="polite" className="fiddy-honest-note">
              <span>{keyLine}</span>
            </p>
          ) : null}
          <p className="fiddy-honest-note">
            <span>
              The key is yours, it is kept in this browser and nowhere else, and
              it starts empty — you decide what to put behind it.
            </span>
          </p>
        </div>

        <div className="fiddy-advanced">
          <span className="fiddy-honest-note" data-fiddy-surp="wallet-note">
            <span>
              Which wallet pays is chosen once, in your wallet settings. Fiddy
              never holds it, and nothing is ever paid without your approval.
            </span>
          </span>
        </div>
      </div>
    );
  },
);

SurpBrainPanel.displayName = 'SurpBrainPanel';
