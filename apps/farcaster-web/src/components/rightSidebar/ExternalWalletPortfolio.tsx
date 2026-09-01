import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import React, { useState } from 'react';
import { Address, Chain } from 'viem';
import { base } from 'viem/chains';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import {
  refreshLifiWallet,
  useLifiAssets,
  useLifiWalletTokens,
} from '~/hooks/useLifiWallet';
import { formatPortfolioUsd } from '~/utils/baseWalletPortfolio';
import { truncateAddress } from '~/utils/ethereumUtils';
import {
  formatLifiBalance,
  isNativeWalletAsset,
  lifiAssetUsd,
} from '~/utils/lifiWallet';

const PAGE_SIZE = 20;

export function ExternalWalletPortfolio({
  address,
  chain = base,
}: {
  address: Address;
  chain?: Chain;
}) {
  const queryClient = useQueryClient();
  const [showUnverified, setShowUnverified] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { data, isPending, isError, isFetching } = useLifiWalletTokens(
    address,
    chain,
  );
  const allTokens = (data?.tokens ?? []).filter(
    (token) => !isNativeWalletAsset(token.address, chain.id),
  );
  const unverifiedCount = allTokens.filter(
    (token) => token.verificationStatus !== 'verified',
  ).length;
  const tokens = allTokens.filter(
    (token) => showUnverified || token.verificationStatus === 'verified',
  );
  const visible = tokens.slice(0, visibleCount);
  const balances = useLifiAssets(
    address,
    visible.map((token) => token.address),
    chain,
  );
  const explorerUrl = chain.blockExplorers?.default.url;
  const initialLoading = isPending && !data && !isError;
  const loadingBalances = visible.some(
    (_, index) => !balances[index]?.data && !balances[index]?.isError,
  );
  const refreshing =
    initialLoading ||
    loadingBalances ||
    isFetching ||
    balances.some((balance) => balance.isFetching);
  const allZero =
    visible.length > 0 &&
    balances.length === visible.length &&
    balances.every(
      (balance) => !balance.isError && balance.data?.balance === 0n,
    );

  return (
    <section
      className="mt-6 rounded-2xl border p-4 border-default"
      aria-label={`${chain.name} token portfolio`}
      aria-busy={Boolean(refreshing)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-default">
            Tokens on {chain.name}
          </h3>
          <p className="mt-1 text-xs text-muted">
            Token balances · Estimated USD value
          </p>
        </div>
        <DefaultButton
          type="button"
          variant="secondary"
          size="sm"
          className="inline-flex shrink-0 items-center gap-2"
          disabled={refreshing}
          onClick={() => void refreshLifiWallet(queryClient, address, chain.id)}
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
          <span>Loading {chain.name} tokens…</span>
        </div>
      )}
      {loadingBalances && !initialLoading && (
        <div
          role="status"
          className="mt-4 flex items-center gap-2 text-xs text-muted"
        >
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Checking token balances on {chain.name}…
        </div>
      )}
      {refreshing && !initialLoading && !loadingBalances && (
        <span role="status" className="sr-only">
          Updating token balances…
        </span>
      )}
      {isError && (
        <p
          className="mt-4 rounded-xl p-3 text-sm leading-relaxed text-muted bg-elevated-nohover"
          role="alert"
        >
          Could not load tokens from LI.FI. Try refreshing.{' '}
          {data ? 'The token list may be out of date.' : ''}
        </p>
      )}
      {data && (
        <>
          {(data.possiblyLimited || data.skipped > 0) && (
            <p className="mt-2 text-xs text-muted">
              LI.FI returned a partial token list. Some holdings may be missing.
            </p>
          )}
          {unverifiedCount > 0 && (
            <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg py-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={showUnverified}
                onChange={(event) => {
                  setShowUnverified(event.target.checked);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
              Show unverified tokens ({unverifiedCount})
            </label>
          )}
          {showUnverified && (
            <p className="mt-2 text-xs text-muted">
              Unverified tokens may include spam. LI.FI verification is not a
              safety guarantee. Check contracts; ignore claim links.
            </p>
          )}
          {(tokens.length === 0 || allZero) && (
            <p className="mt-4 rounded-xl p-4 text-sm leading-relaxed text-muted bg-elevated-nohover">
              No non-zero {chain.name} token balances in this selection. Native{' '}
              {chain.nativeCurrency.symbol} is shown above.
            </p>
          )}
          <ul className="divide-default mt-4 divide-y">
            {visible.map((token, index) => {
              const balance = balances[index];
              if (!balance?.isError && balance?.data?.balance === 0n) {
                return null;
              }
              const asset = balance?.isError ? undefined : balance?.data;
              return (
                <li key={token.address} className="flex items-start gap-3 py-4">
                  <div
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-muted bg-elevated-nohover"
                  >
                    {token.symbol.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-sm font-semibold text-default"
                      title={token.name}
                    >
                      {token.symbol}
                    </div>
                    <div className="mt-1 break-all text-xs tabular-nums text-muted">
                      {asset
                        ? formatLifiBalance(asset)
                        : balance?.isError
                          ? 'Balance unavailable'
                          : 'Checking balance…'}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {explorerUrl ? (
                        <a
                          className="text-accent-primary text-xs hover:underline"
                          href={`${explorerUrl}/token/${token.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View contract ${token.address} on ${chain.name} explorer`}
                        >
                          {truncateAddress(token.address, 4)}
                        </a>
                      ) : (
                        <span className="text-xs text-muted">
                          {truncateAddress(token.address, 4)}
                        </span>
                      )}
                      {token.verificationStatus !== 'verified' && (
                        <span className="rounded-full border px-1.5 py-0.5 text-xs text-muted border-default">
                          Unverified
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="max-w-[45%] shrink-0 break-all text-right text-sm font-medium tabular-nums text-default">
                    {formatPortfolioUsd(
                      asset ? lifiAssetUsd(asset) : undefined,
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {tokens.length > visibleCount && (
            <DefaultButton
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              Show more tokens ({tokens.length - visibleCount} remaining)
            </DefaultButton>
          )}
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Missing a token? LI.FI may not recognize every {chain.name} asset.
          </p>
        </>
      )}
      <details className="mt-4 border-t pt-3 text-xs leading-relaxed text-muted border-default">
        <summary className="cursor-pointer">About these balances</summary>
        <p className="mt-2">
          Token discovery and estimated prices by LI.FI. Balances are checked on
          {chain.name}. Native {chain.nativeCurrency.symbol} is shown above.
        </p>
      </details>
    </section>
  );
}
