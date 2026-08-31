import { useWalletPositionsQuery } from 'farcaster-client-hooks';
import React, { useState } from 'react';
import { Address, isAddress } from 'viem';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import {
  formatPortfolioBalance,
  formatPortfolioUsd,
  isBasePortfolioToken,
  isPortfolioPositionHidden,
  selectBasePortfolioPositions,
} from '~/utils/baseWalletPortfolio';
import { truncateAddress } from '~/utils/ethereumUtils';

const PAGE_SIZE = 20;

export function ExternalWalletPortfolio({ address }: { address: Address }) {
  const isSignedIn = useIsSignedIn();
  const [showHidden, setShowHidden] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { data, isPending, isError, isFetching, refetch } =
    useWalletPositionsQuery({
      params: { address: address.toLowerCase() },
      enabled: isSignedIn,
      keepPreviousData: false,
      staleTime: 30_000,
      refetchInterval: 60_000,
    });
  const basePositions = (data?.positions ?? []).filter(isBasePortfolioToken);
  const hiddenCount = basePositions.filter(isPortfolioPositionHidden).length;
  const positions = selectBasePortfolioPositions(basePositions, showHidden);

  return (
    <section className="mt-6" aria-label="Base token portfolio">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-default">Tokens on Base</h3>
        <DefaultButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={!isSignedIn || isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? 'Refreshing…' : 'Refresh tokens'}
        </DefaultButton>
      </div>
      <p className="mt-2 text-xs text-muted">
        Balances and USD estimates from Farcaster may be delayed. Missing prices
        are shown as —, not zero. Native ETH is shown separately above.
      </p>

      {!isSignedIn ? (
        <p className="mt-3 text-sm text-muted">
          Sign in to Farcaster to load token holdings.
        </p>
      ) : (
        <>
          {isPending && !isError && (
            <p className="mt-3 text-sm text-muted" role="status">
              Loading Base tokens…
            </p>
          )}
          {isError && (
            <p className="mt-3 text-sm text-muted" role="alert">
              {data
                ? 'Could not refresh tokens. Displayed balances may be out of date.'
                : 'Could not load Base tokens. Try refreshing.'}
            </p>
          )}
          {data && (
            <>
              {hiddenCount > 0 && (
                <label className="mt-3 flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(event) => {
                      setShowHidden(event.target.checked);
                      setVisibleCount(PAGE_SIZE);
                    }}
                  />
                  Show hidden tokens ({hiddenCount})
                </label>
              )}
              {showHidden && hiddenCount > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Hidden flags come from the source or wallet preferences, not a
                  safety guarantee. Token names are untrusted; ignore claim
                  links.
                </p>
              )}
              {positions.length === 0 ? (
                <p className="mt-3 text-sm text-muted">
                  {hiddenCount > 0
                    ? 'All returned Base tokens are hidden.'
                    : 'No Base token holdings to show. Native ETH is shown above.'}
                </p>
              ) : (
                <ul className="divide-default mt-3 divide-y">
                  {positions.slice(0, visibleCount).map((position) => {
                    const balance = formatPortfolioBalance(position);
                    const contract = position.address;
                    return (
                      <li
                        key={`base:${contract ?? position.id}:${position.id}`}
                        className="flex items-start justify-between gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate text-sm font-semibold text-default"
                            title={
                              position.symbol ??
                              position.name ??
                              'Unknown token'
                            }
                          >
                            {position.symbol ??
                              position.name ??
                              'Unknown token'}
                          </div>
                          <div
                            className="break-all text-xs text-muted"
                            title={balance.exact}
                          >
                            {balance.display}
                          </div>
                          {contract && isAddress(contract) ? (
                            <a
                              className="text-accent-primary text-xs hover:underline"
                              href={`https://basescan.org/token/${contract}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`View contract ${contract} on BaseScan`}
                            >
                              {truncateAddress(contract, 4)}
                            </a>
                          ) : null}
                          {isPortfolioPositionHidden(position) && (
                            <span className="ml-2 text-xs text-muted">
                              Hidden
                            </span>
                          )}
                        </div>
                        <div className="shrink-0 text-sm text-default">
                          {formatPortfolioUsd(position.value)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {positions.length > visibleCount && (
                <DefaultButton
                  type="button"
                  variant="secondary"
                  className="mt-3 w-full"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                >
                  Show more tokens ({positions.length - visibleCount} remaining)
                </DefaultButton>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
