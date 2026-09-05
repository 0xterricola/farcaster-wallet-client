import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, LoaderCircleIcon } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useSolanaBalance } from '~/hooks/useSolanaBalance';
import { useSolanaTokenPortfolio } from '~/hooks/useSolanaTokenPortfolio';
import {
  assertFreshSolanaQuote,
  decodeLifiSolanaTransaction,
  estimatedSolanaNetworkFee,
  fetchLifiSolanaQuote,
  formatSolanaSwapUnits,
  isHighCostSolanaQuote,
  LifiSolanaQuote,
  SOLANA_NATIVE_MINT,
  SOLANA_USDC_MINT,
  SolanaSwapAsset,
} from '~/utils/solanaSwap';
import {
  simulateSolanaTransaction,
  solanaTransactionUrl,
  submitSignedSolanaTransaction,
  waitForSolanaConfirmation,
} from '~/utils/solanaTransfer';

const SOL: SolanaSwapAsset = {
  amount: '0',
  decimals: 9,
  mint: SOLANA_NATIVE_MINT,
  name: 'Solana',
  symbol: 'SOL',
};

const USDC: SolanaSwapAsset = {
  amount: '0',
  decimals: 6,
  mint: SOLANA_USDC_MINT,
  name: 'USD Coin',
  symbol: 'USDC',
};

type Review = {
  amount: bigint;
  from: SolanaSwapAsset;
  quote: LifiSolanaQuote;
  quotedAt: number;
  to: SolanaSwapAsset;
};

const QUOTE_FRESHNESS_MS = 15_000;

export function ExternalSolanaWalletSwap({
  address,
  initialBuyToken,
  onBack,
  signTransaction,
}: {
  address: string;
  initialBuyToken?: SolanaSwapAsset;
  onBack: () => void;
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
}) {
  const queryClient = useQueryClient();
  const balance = useSolanaBalance(address);
  const portfolio = useSolanaTokenPortfolio(address);
  const [fromMint, setFromMint] = useState(SOLANA_NATIVE_MINT);
  const [toMint, setToMint] = useState(
    initialBuyToken?.mint ?? SOLANA_USDC_MINT,
  );
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<Review>();
  const [acknowledgeHighCost, setAcknowledgeHighCost] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [signature, setSignature] = useState<string>();

  const assets = useMemo(() => {
    const tokens = (portfolio.data ?? []).filter((asset) => asset.recognized);
    const sol = { ...SOL, amount: String(balance.data ?? 0) };
    const usdc =
      tokens.find((asset) => asset.mint === SOLANA_USDC_MINT) ?? USDC;
    const baseAssets = [
      sol,
      usdc,
      ...tokens.filter((asset) => asset.mint !== SOLANA_USDC_MINT),
    ];
    return initialBuyToken &&
      !baseAssets.some((asset) => asset.mint === initialBuyToken.mint)
      ? [...baseAssets, initialBuyToken]
      : baseAssets;
  }, [balance.data, initialBuyToken, portfolio.data]);
  const from = assets.find((asset) => asset.mint === fromMint);
  const to = assets.find((asset) => asset.mint === toMint);
  const available = from
    ? `${formatSolanaSwapUnits(from.amount, from.decimals)} ${from.symbol}`
    : 'Unavailable';
  const highCost = review ? isHighCostSolanaQuote(review.quote) : false;

  const edit = () => {
    setReview(undefined);
    setError(undefined);
    setAcknowledgeHighCost(false);
    setProgress(undefined);
  };

  const getQuote = async () => {
    if (!from || !to) {
      setError('Token balances are still loading.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setSignature(undefined);
    try {
      const result = await fetchLifiSolanaQuote(address, from, to, amount);
      setReview({ ...result, from, quotedAt: Date.now(), to });
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  const changeAsset = () => {
    setReview(undefined);
    setError(undefined);
  };

  const swap = async () => {
    if (!review) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setSignature(undefined);
    try {
      let execution = { amount: review.amount, quote: review.quote };
      if (Date.now() - review.quotedAt > QUOTE_FRESHNESS_MS) {
        setProgress('Refreshing quote…');
        const refreshed = await fetchLifiSolanaQuote(
          address,
          review.from,
          review.to,
          amount,
        );
        try {
          assertFreshSolanaQuote(review.quote, refreshed.quote);
        } catch {
          setReview({
            ...refreshed,
            from: review.from,
            quotedAt: Date.now(),
            to: review.to,
          });
          setAcknowledgeHighCost(false);
          throw new Error(
            'Quote updated. Review the new route and amounts before swapping.',
          );
        }
        execution = refreshed;
      }
      if (isHighCostSolanaQuote(execution.quote) && !acknowledgeHighCost) {
        setReview({
          ...execution,
          from: review.from,
          quotedAt: Date.now(),
          to: review.to,
        });
        setAcknowledgeHighCost(false);
        throw new Error(
          'Network costs now exceed the estimated output. Review and acknowledge the updated quote.',
        );
      }
      const transaction = decodeLifiSolanaTransaction(
        execution.quote.transactionRequest.data,
        address,
      );
      setProgress('Simulating route…');
      await simulateSolanaTransaction(transaction);
      setProgress('Check your wallet…');
      const signed = await signTransaction(transaction);
      const nextSignature = await submitSignedSolanaTransaction(signed);
      setSignature(nextSignature);
      setProgress('Confirming swap…');
      await waitForSolanaConfirmation(nextSignature);
      await queryClient.invalidateQueries({
        queryKey: ['solana-wallet'],
      });
      await queryClient.invalidateQueries({
        queryKey: ['solana-wallet-balance', address],
      });
      setReview(undefined);
      setAmount('');
      setProgress('Swap confirmed.');
    } catch (failure) {
      if (isWalletRejection(failure)) {
        setReview(undefined);
        setAcknowledgeHighCost(false);
      }
      setError(message(failure));
      setProgress(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          aria-label="Back to Solana wallet"
          className="flex size-8 items-center justify-center rounded-full hover:bg-overlay-light"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="font-semibold text-default">Trade on Solana</div>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          Sell asset
          <select
            className="rounded-xl border px-3 py-2.5 bg-app border-default"
            disabled={busy || Boolean(review)}
            onChange={(event) => {
              setFromMint(event.target.value);
              setAmount('');
              changeAsset();
            }}
            value={fromMint}
          >
            {assets
              .filter((asset) => BigInt(asset.amount) > 0n)
              .map((asset) => (
                <option key={asset.mint} value={asset.mint}>
                  {asset.symbol}
                </option>
              ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          Buy asset
          <select
            className="rounded-xl border px-3 py-2.5 bg-app border-default"
            disabled={busy || Boolean(review)}
            onChange={(event) => {
              setToMint(event.target.value);
              changeAsset();
            }}
            value={toMint}
          >
            {assets.map((asset) => (
              <option key={asset.mint} value={asset.mint}>
                {asset.symbol}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          Amount
          <input
            className="rounded-xl border px-3 py-2.5 tabular-nums bg-app border-default"
            disabled={busy || Boolean(review)}
            inputMode="decimal"
            onChange={(event) => {
              setAmount(event.target.value);
              edit();
            }}
            placeholder="0"
            value={amount}
          />
          <span className="text-xs font-normal text-muted">
            Available: {available}
          </span>
        </label>

        {review && (
          <div className="rounded-xl border p-3 text-sm bg-elevated-nohover border-default">
            <div className="font-semibold text-default">Review quote</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted">Selling</dt>
              <dd className="text-right font-medium text-default">
                {amount} {review.from.symbol}
              </dd>
              <dt className="text-muted">Estimated receive</dt>
              <dd className="text-right font-medium text-default">
                {formatSolanaSwapUnits(
                  review.quote.estimate.toAmount,
                  review.to.decimals,
                )}{' '}
                {review.to.symbol}
              </dd>
              <dt className="text-muted">Minimum receive</dt>
              <dd className="text-right font-medium text-default">
                {formatSolanaSwapUnits(
                  review.quote.estimate.toAmountMin,
                  review.to.decimals,
                )}{' '}
                {review.to.symbol}
              </dd>
              <dt className="text-muted">Route</dt>
              <dd className="text-right font-medium text-default">
                {review.quote.tool}
              </dd>
              {estimatedSolanaNetworkFee(review.quote) && (
                <>
                  <dt className="text-muted">Estimated network fee</dt>
                  <dd className="text-right font-medium text-default">
                    {estimatedSolanaNetworkFee(review.quote)} SOL
                  </dd>
                </>
              )}
            </dl>
            {highCost && (
              <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
                <strong>High network cost:</strong> the estimated network fee
                exceeds the estimated value received.
                <label className="mt-2 flex cursor-pointer items-start gap-2">
                  <input
                    checked={acknowledgeHighCost}
                    disabled={busy}
                    onChange={(event) =>
                      setAcknowledgeHighCost(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>I understand and still want to swap.</span>
                </label>
              </div>
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted">
              The quote will be refreshed and simulated before your wallet is
              asked to sign.
            </p>
          </div>
        )}

        {progress && (
          <div
            className="rounded-xl p-3 text-sm text-muted bg-elevated-nohover"
            role="status"
          >
            {progress}
          </div>
        )}

        {error && (
          <div
            className="rounded-xl bg-red-50 p-3 text-sm text-red-600"
            role="alert"
          >
            {error}
          </div>
        )}

        {signature && (
          <a
            className="rounded-xl p-3 text-center text-sm font-semibold text-accent bg-elevated-nohover hover:underline"
            href={solanaTransactionUrl(signature)}
            rel="noopener noreferrer"
            target="_blank"
          >
            View swap on Solana Explorer
          </a>
        )}

        {review ? (
          <div className="grid grid-cols-2 gap-3">
            <DefaultButton
              disabled={busy}
              onClick={edit}
              type="button"
              variant="secondary"
            >
              Edit trade
            </DefaultButton>
            <DefaultButton
              disabled={busy || (highCost && !acknowledgeHighCost)}
              onClick={() => void swap()}
              type="button"
            >
              {busy && (
                <LoaderCircleIcon className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" />
              )}
              {busy ? 'Working…' : highCost ? 'Swap anyway' : 'Swap'}
            </DefaultButton>
          </div>
        ) : (
          <DefaultButton
            disabled={busy || !amount || !from || !to}
            onClick={() => void getQuote()}
            type="button"
          >
            {busy && (
              <LoaderCircleIcon className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" />
            )}
            {busy ? 'Getting quote…' : 'Get quote'}
          </DefaultButton>
        )}
      </div>
    </div>
  );
}

function message(error: unknown): string {
  if (isWalletRejection(error)) {
    return 'Transaction rejected in your wallet.';
  }
  return error instanceof Error
    ? error.message
    : 'Could not get a Solana quote.';
}

function isWalletRejection(error: unknown): boolean {
  const details =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown; name?: unknown })
      : undefined;
  if (details?.code === 4001) {
    return true;
  }
  const text = [
    error instanceof Error ? error.message : undefined,
    details?.message,
    details?.name,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /reject|denied|declined|cancel(?:ed|led)|user_rejected/i.test(text);
}
