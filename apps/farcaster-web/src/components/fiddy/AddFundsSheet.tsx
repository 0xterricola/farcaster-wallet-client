/**
 * Adding funds, as one surface that can be put anywhere.
 *
 * The same component is what the wallet page opens and what the way in offers
 * as its middle step, so a person cannot meet two versions of this flow with two
 * different sets of words. It is handed everything it shows — the config, the
 * wallet choices, the progress of a transfer — and it decides only two things
 * itself: which amount is selected, and whether the review is open. Everything
 * that touches money is a callback.
 *
 * THE FOUR THINGS IT REFUSES TO DO.
 *   1. It never sends without a review. The amount step's primary action opens
 *      a sheet that names the amount, the currency, the network and the address
 *      the money goes to — with the full address one press away.
 *   2. It never offers a send the service cannot credit. When the balance route
 *      will not place this session (`session !== 'ready'`), the send is replaced
 *      by the reason, because a USDC transfer to Fiddy's address that cannot be
 *      credited is somebody's money with no balance behind it.
 *   3. It never words a failure as a surprise. Every failure prints the server's
 *      own code beside a sentence, and a failure that still has a transfer hash
 *      offers "check again" — which costs nothing — rather than a second send.
 *   4. It never calls the balance a wallet. A Fiddy balance is a credit spent
 *      inside Fiddy; the copy here says so and never says "deposit", "held by
 *      Fiddy" or "your funds".
 *
 * No infrastructure words: no allowance, no chain id, no gas, no RPC, no
 * nonce. "Base" and "USDC" are named because that is what the person will see
 * in their own wallet, and matching their wallet's words is the whole point.
 */

import { Check, ChevronLeft, Copy, RefreshCw } from 'lucide-react';
import React, { memo, useEffect, useRef, useState } from 'react';

import type { TopUpProgress } from '~/hooks/fiddy/useFiddyTopUp';
import {
  dollarsToBaseUnits,
  formatUsd,
  type FundingConfig,
  type FundingSession,
  isBelowMinimum,
} from '~/lib/fiddyCredit';
import type { PendingTopUp } from '~/lib/fiddyPendingTopUp';
import { type TopUpSource, treasuryLine } from '~/lib/fiddyTopUpSend';

export interface AddFundsWalletOption {
  source: TopUpSource;
  label: string;
  line: string;
  available: boolean;
}

export interface AddFundsSheetProps {
  config: FundingConfig | null;
  /** Why the config could not be read, when it could not be. Null otherwise. */
  configLine: string | null;
  session: FundingSession;
  /** Why a send cannot be offered yet; null once it can. */
  sessionLine: string | null;
  sessionCode: string | null;
  walletOptions: readonly AddFundsWalletOption[];
  pending: PendingTopUp | null;
  progress: TopUpProgress;
  busy: boolean;
  onSend: (usd: string, source: TopUpSource) => void;
  onCheckPending: () => void;
  onForgetPending: () => void;
  /** Put the flow back to the amount step, after a transfer has ended. */
  onDone: () => void;
  /** The way out: "Add later" in the way in, "Back to your balance" elsewhere. */
  quiet?: { label: string; onClick: () => void } | null;
}

/** Within the flow: pick an amount, or look over what is about to happen. */
type SheetStep = 'amount' | 'review';

const isProgressing = (progress: TopUpProgress): boolean =>
  progress.name === 'sending' ||
  progress.name === 'checking' ||
  progress.name === 'confirming' ||
  progress.name === 'credited' ||
  progress.name === 'already-credited';

/** How a validation line reads: the field's own problem, or null when fine. */
export const amountProblem = (
  config: FundingConfig | null,
  input: string,
): string | null => {
  if (config === null) {
    return null;
  }
  const parsed = dollarsToBaseUnits(input, config.asset.decimals);
  if (parsed === null) {
    return 'Enter an amount in dollars, like 5 or 12.50.';
  }
  if (isBelowMinimum(parsed.baseUnits, config.minimum.baseUnits)) {
    return `Fiddy adds ${formatUsd(config.minimum.usdc)} or more at a time.`;
  }
  return null;
};

const CopyAddress = memo<{ address: string; label: string }>(
  ({ address, label }) => {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
      if (!copied) {
        return undefined;
      }
      const timer = window.setTimeout(() => setCopied(false), 2000);
      return () => window.clearTimeout(timer);
    }, [copied]);

    return (
      <button
        type="button"
        className="fiddy-copy-btn"
        data-fiddy="copy-recipient"
        data-fiddy-copied={copied ? 'true' : 'false'}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        title={address}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(address)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    );
  },
);

CopyAddress.displayName = 'CopyAddress';

export const AddFundsSheet = memo<AddFundsSheetProps>(
  ({
    config,
    configLine,
    session,
    sessionLine,
    sessionCode,
    walletOptions,
    pending,
    progress,
    busy,
    onSend,
    onCheckPending,
    onForgetPending,
    onDone,
    quiet = null,
  }) => {
    const [step, setStep] = useState<SheetStep>('amount');
    const [usd, setUsd] = useState<string>(() =>
      config === null
        ? '5.00'
        : (config.presets[0]?.usdc ?? config.minimum.usdc),
    );
    const [custom, setCustom] = useState('');
    const [source, setSource] = useState<TopUpSource>(
      () => walletOptions[0]?.source ?? 'wallet',
    );
    const titleRef = useRef<HTMLHeadingElement>(null);

    // The chosen amount follows the server's own first preset once it arrives:
    // the config is public and can land after this component mounts.
    useEffect(() => {
      if (config !== null && custom === '') {
        setUsd(config.presets[0]?.usdc ?? config.minimum.usdc);
      }
    }, [config, custom]);

    useEffect(() => {
      if (step === 'review') {
        titleRef.current?.focus();
      }
    }, [step]);

    const effectiveUsd = custom === '' ? usd : custom;
    const effectiveProblem =
      custom === '' ? null : amountProblem(config, effectiveUsd);
    const canReview =
      config !== null &&
      session === 'ready' &&
      effectiveProblem === null &&
      dollarsToBaseUnits(effectiveUsd, config.asset.decimals) !== null;
    const payerSource = walletOptions.some(
      (option) => option.source === source && option.available,
    )
      ? source
      : (walletOptions.find((option) => option.available)?.source ?? source);
    const payer = walletOptions.find((option) => option.source === payerSource);

    // A transfer in flight, or a finished one, owns the screen until it is
    // dismissed — the form underneath it would invite a second send.
    if (isProgressing(progress) || progress.name === 'failed') {
      return (
        <div
          className="fiddy-top-up"
          data-fiddy="top-up-progress"
          data-fiddy-stage={progress.name}
        >
          <AddFundsProgress
            progress={progress}
            pending={pending}
            busy={busy}
            onCheckPending={onCheckPending}
            onForgetPending={onForgetPending}
            onDone={() => {
              setStep('amount');
              onDone();
            }}
          />
        </div>
      );
    }

    if (step === 'review' && config !== null && payer) {
      return (
        <div className="fiddy-top-up" data-fiddy="top-up-review">
          <header className="fiddy-top-up-head">
            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-inline"
              data-fiddy="review-back"
              onClick={() => setStep('amount')}
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Change the amount
            </button>
            <h2 className="fiddy-top-up-title" ref={titleRef} tabIndex={-1}>
              Sending {formatUsd(effectiveUsd)} to Fiddy
            </h2>
            <p className="fiddy-top-up-sub">
              Check the three lines below, then approve it in {payer.label}.
            </p>
          </header>

          <dl className="fiddy-review">
            <div className="fiddy-review-row">
              <dt className="fiddy-review-label">Amount</dt>
              <dd className="fiddy-review-value" data-fiddy="review-amount">
                {formatUsd(effectiveUsd)}
              </dd>
            </div>
            <div className="fiddy-review-row">
              <dt className="fiddy-review-label">What</dt>
              <dd className="fiddy-review-value" data-fiddy="review-asset">
                {config.asset.symbol} on {config.chain.name}
              </dd>
            </div>
            <div className="fiddy-review-row">
              <dt className="fiddy-review-label">To</dt>
              <dd className="fiddy-review-value">
                <code
                  data-fiddy="review-recipient"
                  title={config.treasury.address}
                >
                  {treasuryLine(config)}
                </code>
                <CopyAddress
                  address={config.treasury.address}
                  label="Fiddy's address"
                />
              </dd>
            </div>
            <div className="fiddy-review-row">
              <dt className="fiddy-review-label">Paid with</dt>
              <dd className="fiddy-review-value" data-fiddy="review-payer">
                {payer.label}
              </dd>
            </div>
          </dl>

          <button
            type="button"
            className="fiddy-primary-btn fiddy-primary-btn-hot"
            data-fiddy="top-up-send"
            disabled={busy}
            onClick={() => onSend(effectiveUsd, payerSource)}
          >
            {busy
              ? 'Waiting for your wallet…'
              : `Send ${formatUsd(effectiveUsd)}`}
          </button>

          <p className="fiddy-honest-note">
            <span>
              Fiddy waits until Base has settled the transfer, then adds it to
              your Fiddy balance — a credit you spend inside Fiddy. Fiddy never
              holds your wallet or its keys, and nothing is added twice.
            </span>
          </p>
        </div>
      );
    }

    return (
      <div className="fiddy-top-up" data-fiddy="top-up-amount">
        <header className="fiddy-top-up-head">
          <h2 className="fiddy-top-up-title">
            Add funds to your Fiddy balance
          </h2>
          <p className="fiddy-top-up-sub">
            Your own wallet pays. Fiddy adds it to a balance you spend inside
            Fiddy, and you can stop at any point.
          </p>
        </header>

        {configLine !== null ? (
          <p
            className="fiddy-honest-note"
            data-fiddy="top-up-config-line"
            role="status"
          >
            <span>{configLine}</span>
          </p>
        ) : null}

        {config !== null ? (
          <>
            <div className="fiddy-amounts" role="group" aria-label="Amount">
              {config.presets.map((preset) => {
                const selected = custom === '' && preset.usdc === usd;
                return (
                  <button
                    key={preset.usd}
                    type="button"
                    className={`fiddy-amount${selected ? ' fiddy-amount-selected' : ''}`}
                    aria-pressed={selected}
                    aria-label={preset.label}
                    data-fiddy-amount={preset.usd}
                    onClick={() => {
                      setCustom('');
                      setUsd(preset.usdc);
                    }}
                  >
                    ${preset.usd}
                  </button>
                );
              })}
            </div>

            <label className="fiddy-field">
              <span className="fiddy-field-label">Another amount</span>
              <span className="fiddy-amount-field">
                <span aria-hidden="true">$</span>
                <input
                  className="fiddy-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="1"
                  value={custom}
                  data-fiddy="top-up-custom"
                  onChange={(event) =>
                    setCustom(event.target.value.replace(/[^0-9.]/g, ''))
                  }
                />
              </span>
            </label>
            {effectiveProblem !== null ? (
              <p
                className="fiddy-honest-note"
                data-fiddy="top-up-problem"
                role="status"
              >
                <span>{effectiveProblem}</span>
              </p>
            ) : (
              <p className="fiddy-honest-note">
                <span>
                  Smallest top-up is {formatUsd(config.minimum.usdc)}. Nothing
                  is charged until you approve it in your wallet.
                </span>
              </p>
            )}
          </>
        ) : null}

        {walletOptions.length > 0 ? (
          <div>
            <span className="fiddy-field-label">Pay with</span>
            <ul className="fiddy-card-list">
              {walletOptions.map((option) => {
                const selected =
                  option.source === payerSource && option.available;
                return (
                  <li key={option.source}>
                    <button
                      type="button"
                      className={`fiddy-brain-card${selected ? ' fiddy-brain-card-selected' : ''}`}
                      aria-pressed={selected}
                      disabled={!option.available}
                      data-fiddy-payer={option.source}
                      onClick={() => setSource(option.source)}
                    >
                      <span className="fiddy-card-head">
                        <span className="fiddy-card-title">{option.label}</span>
                        <span
                          className={`fiddy-tag fiddy-tag-${option.available ? 'live' : 'soon'}`}
                        >
                          {option.available ? 'ready' : 'not here'}
                        </span>
                      </span>
                      <span className="fiddy-card-line">{option.line}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {pending !== null ? (
          <div className="fiddy-pending" data-fiddy="top-up-pending">
            <span>
              A transfer from earlier is not in your balance yet:{' '}
              {formatUsd(pending.usdc)}. Fiddy can check it again — that costs
              nothing and sends nothing.
            </span>
            <div className="fiddy-pending-actions">
              <button
                type="button"
                className="fiddy-secondary-btn"
                data-fiddy="pending-check"
                disabled={busy}
                onClick={onCheckPending}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Check again
              </button>
              <button
                type="button"
                className="fiddy-quiet-btn fiddy-quiet-btn-inline"
                data-fiddy="pending-forget"
                onClick={onForgetPending}
              >
                Stop asking
              </button>
            </div>
          </div>
        ) : null}

        {session !== 'ready' ? (
          <p
            className="fiddy-honest-note"
            data-fiddy="top-up-session-line"
            data-fiddy-session={session}
            role="status"
            aria-live="polite"
          >
            <span>
              {session === 'loading'
                ? 'Checking whether this account can hold a balance…'
                : (sessionLine ??
                  'Fiddy cannot add to a balance for this account yet, so nothing can be sent from here.')}
              {sessionCode !== null && session !== 'loading'
                ? ` (${sessionCode})`
                : ''}
            </span>
          </p>
        ) : null}

        <button
          type="button"
          className={`fiddy-primary-btn${canReview ? ' fiddy-primary-btn-hot' : ''}`}
          data-fiddy="top-up-review-open"
          data-highlighted={canReview ? 'true' : undefined}
          disabled={!canReview}
          onClick={() => setStep('review')}
        >
          Review {formatUsd(effectiveUsd)}
        </button>

        {quiet ? (
          <button
            type="button"
            className="fiddy-quiet-btn"
            data-fiddy="top-up-later"
            onClick={quiet.onClick}
          >
            {quiet.label}
          </button>
        ) : null}
      </div>
    );
  },
);

AddFundsSheet.displayName = 'AddFundsSheet';

/** The waiting, the landing, and the two ways a transfer can end badly. */
export const AddFundsProgress = memo<{
  progress: TopUpProgress;
  pending: PendingTopUp | null;
  busy: boolean;
  onCheckPending: () => void;
  onForgetPending: () => void;
  onDone: () => void;
}>(({ progress, pending, busy, onCheckPending, onForgetPending, onDone }) => {
  if (progress.name === 'sending') {
    return (
      <p
        className="fiddy-progress"
        data-fiddy="top-up-sending"
        role="status"
        aria-live="polite"
      >
        <span>
          Approve the transfer in your wallet. Nothing has moved yet — the
          amount and the address are the ones you just reviewed.
        </span>
      </p>
    );
  }

  if (progress.name === 'checking') {
    return (
      <p
        className="fiddy-progress"
        data-fiddy="top-up-checking"
        role="status"
        aria-live="polite"
      >
        <span>Sent. Fiddy is checking that transfer on Base.</span>
      </p>
    );
  }

  if (progress.name === 'confirming') {
    return (
      <p
        className="fiddy-progress"
        data-fiddy="top-up-confirming"
        role="status"
        aria-live="polite"
      >
        <span>
          Base is still settling that transfer, so it is not in your balance
          yet. Fiddy keeps checking — nothing is lost, and you can leave this
          screen open.
        </span>
      </p>
    );
  }

  if (progress.name === 'credited') {
    return (
      <div className="fiddy-connected" data-fiddy="top-up-credited">
        <span className="fiddy-connected-dot" aria-hidden="true" />
        <span>
          Added {formatUsd(progress.usdc)} to your Fiddy balance.
          {progress.settled
            ? ''
            : ' Your balance will show it the next time this screen reads it.'}
        </span>
      </div>
    );
  }

  if (progress.name === 'already-credited') {
    return (
      <div className="fiddy-connected" data-fiddy="top-up-already-credited">
        <span className="fiddy-connected-dot" aria-hidden="true" />
        <span>
          That transfer is already in your Fiddy balance — it was not added
          twice. Nothing else is needed.
        </span>
      </div>
    );
  }

  if (progress.name === 'failed') {
    return (
      <div
        className="fiddy-failure"
        data-fiddy="top-up-failed"
        data-fiddy-code={progress.code}
      >
        <p className="fiddy-honest-note" role="status" aria-live="polite">
          <span>{progress.line}</span>
        </p>
        <p className="fiddy-failure-code">
          <code data-fiddy="top-up-code">{progress.code}</code>
        </p>

        {progress.txHash !== null ? (
          <>
            <p className="fiddy-honest-note">
              <span>
                Your transfer is on Base and Fiddy has not added it yet. Keep
                this reference — checking it again sends nothing:
              </span>
            </p>
            <code className="fiddy-failure-hash" data-fiddy="top-up-hash">
              {progress.txHash}
            </code>
            <button
              type="button"
              className="fiddy-secondary-btn"
              data-fiddy="top-up-check-again"
              disabled={busy}
              onClick={onCheckPending}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Check that transfer again
            </button>
            <CopyAddress
              address={progress.txHash}
              label="the transfer reference"
            />
          </>
        ) : null}

        <div className="fiddy-sheet-actions">
          <button
            type="button"
            className="fiddy-quiet-btn"
            data-fiddy="top-up-back-to-amount"
            onClick={onDone}
          >
            {progress.txHash === null ? 'Try again' : 'Back to amounts'}
          </button>
          {pending !== null ? (
            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-inline"
              data-fiddy="top-up-forget"
              onClick={onForgetPending}
            >
              Stop asking about it
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // Nothing to report: an idle stage is the form's business, not this one's.
  return null;
});

AddFundsProgress.displayName = 'AddFundsProgress';

/** Named here so a caller can type a `session` without reaching into a hook. */
export type { FundingSession };
