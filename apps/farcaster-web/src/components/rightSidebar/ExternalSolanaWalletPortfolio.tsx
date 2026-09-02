import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useSolanaTokenPortfolio } from '~/hooks/useSolanaTokenPortfolio';
import { formatPortfolioUsd } from '~/utils/baseWalletPortfolio';
import {
  formatSolanaTokenAmount,
  solanaAddressUrl,
  solanaTokenUsd,
} from '~/utils/solanaWallet';

const PAGE_SIZE = 20;

export function ExternalSolanaWalletPortfolio({
  address,
}: {
  address: string;
}) {
  const [showUnrecognized, setShowUnrecognized] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const portfolio = useSolanaTokenPortfolio(address);
  const recognized = useMemo(
    () => (portfolio.data ?? []).filter((asset) => asset.recognized),
    [portfolio.data],
  );
  const unrecognized = useMemo(
    () => (portfolio.data ?? []).filter((asset) => !asset.recognized),
    [portfolio.data],
  );
  const selected = showUnrecognized
    ? [...recognized, ...unrecognized]
    : recognized;
  const visible = selected.slice(0, visibleCount);
  const initialLoading = portfolio.isPending && !portfolio.data;
  const refreshing = portfolio.isFetching;

  return (
    <section
      aria-busy={refreshing}
      aria-label="Solana token portfolio"
      className="mt-6 rounded-2xl border p-4 border-default"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-default">
            Tokens on Solana
          </h3>
          <p className="mt-1 text-xs text-muted">
            SPL token balances · Estimated USD value
          </p>
        </div>
        <DefaultButton
          className="inline-flex shrink-0 items-center gap-2"
          disabled={refreshing}
          onClick={() => void portfolio.refetch()}
          size="sm"
          type="button"
          variant="secondary"
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={`size-3.5 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
          {refreshing ? 'Refreshing…' : 'Refresh tokens'}
        </DefaultButton>
      </div>

      {initialLoading && (
        <div
          className="mt-4 flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl p-6 text-sm text-muted bg-elevated-nohover"
          role="status"
        >
          <LoaderCircleIcon
            aria-hidden="true"
            className="text-accent-primary size-6 animate-spin motion-reduce:animate-none"
          />
          <span>Loading Solana tokens…</span>
        </div>
      )}

      {portfolio.isError && (
        <p
          className="mt-4 rounded-xl p-3 text-sm leading-relaxed text-muted bg-elevated-nohover"
          role="alert"
        >
          Could not load SPL tokens. Try refreshing.
        </p>
      )}

      {portfolio.data && (
        <>
          {unrecognized.length > 0 && (
            <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg py-1 text-xs text-muted">
              <input
                checked={showUnrecognized}
                onChange={(event) => {
                  setShowUnrecognized(event.target.checked);
                  setVisibleCount(PAGE_SIZE);
                }}
                type="checkbox"
              />
              Show unrecognized tokens ({unrecognized.length})
            </label>
          )}
          {showUnrecognized && (
            <p className="mt-2 text-xs text-muted">
              Unrecognized assets may be spam. Do not follow token names or
              claim links, and verify the mint before using an asset.
            </p>
          )}
          {selected.length === 0 && (
            <p className="mt-4 rounded-xl p-4 text-sm leading-relaxed text-muted bg-elevated-nohover">
              No recognized non-zero SPL token balances were found. Native SOL
              is shown above.
            </p>
          )}
          <ul className="divide-default mt-4 divide-y">
            {visible.map((asset) => (
              <li className="flex items-start gap-3 py-4" key={asset.mint}>
                <div
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-muted bg-elevated-nohover"
                >
                  {asset.symbol.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm font-semibold text-default"
                    title={asset.name}
                  >
                    {asset.symbol}
                  </div>
                  <div className="mt-1 break-all text-xs tabular-nums text-muted">
                    {formatSolanaTokenAmount(asset)}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <a
                      aria-label={`View mint ${asset.mint} on Solana Explorer`}
                      className="text-accent-primary text-xs hover:underline"
                      href={solanaAddressUrl(asset.mint)}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {`${asset.mint.slice(0, 4)}…${asset.mint.slice(-4)}`}
                    </a>
                    {!asset.recognized && (
                      <span className="rounded-full border px-1.5 py-0.5 text-xs text-muted border-default">
                        Unrecognized
                      </span>
                    )}
                  </div>
                </div>
                <div className="max-w-[45%] shrink-0 break-all text-right text-sm font-medium tabular-nums text-default">
                  {formatPortfolioUsd(solanaTokenUsd(asset))}
                </div>
              </li>
            ))}
          </ul>
          {selected.length > visibleCount && (
            <DefaultButton
              className="mt-3 w-full"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              type="button"
              variant="secondary"
            >
              Show more tokens ({selected.length - visibleCount} remaining)
            </DefaultButton>
          )}
        </>
      )}

      <details className="mt-4 border-t pt-3 text-xs leading-relaxed text-muted border-default">
        <summary className="cursor-pointer">About these balances</summary>
        <p className="mt-2">
          Token accounts and balances are read from Solana Mainnet. Recognition
          and estimated prices come from LI.FI. Native SOL is shown above.
        </p>
      </details>
    </section>
  );
}
