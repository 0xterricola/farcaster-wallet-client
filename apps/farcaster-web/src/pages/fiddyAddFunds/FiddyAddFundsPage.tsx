/**
 * Add funds, at its own address.
 *
 * Spec: "one screen, one idea", and this is the idea the whole funding surface
 * exists for. It is a real route rather than a modal so that a link to it can be
 * shared, reloaded and returned to — the same reason every other Fiddy screen is
 * one. The way in offers it as a step, and the balance home links to exactly
 * this address, so there is one implementation of "add funds" and not two.
 *
 * Reachable signed in. Signed out, the flow still explains itself: the amount
 * presets and the review are there, and the action that would move money is
 * replaced by the reason it cannot (see `AddFundsSheet`) — because a top-up is a
 * real transfer, and offering one that the service will not credit would move
 * somebody's money to a balance that cannot exist.
 */

import { ChevronLeft } from 'lucide-react';
import React, { Suspense } from 'react';

import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { Page } from '~/components/page/Page';
import { LazyFiddyFundingPanel } from '~/lazy/funding';

const FiddyAddFundsPage = () => {
  useFiddyBrandGround();

  return (
    <Page
      meta={{ title: 'Add funds / Fiddy' }}
      className="fiddy-surface fiddy-page"
    >
      <div className="fiddy-page-inner" data-fiddy="add-funds-page">
        <Link
          to="wallet"
          params={{}}
          searchParams={{}}
          title="Your Fiddy balance"
          className="fiddy-back"
        >
          <ChevronLeft aria-hidden="true" />
          Your Fiddy balance
        </Link>

        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">Add funds</h1>
          <p className="fiddy-page-sub">
            Send USDC on Base from your own wallet. Fiddy checks the transfer
            and adds it to a balance you spend inside Fiddy.
          </p>
        </header>

        {/* Its own chunk: see ~/lazy/funding for why the flow is loaded here
            rather than imported at the top of this page. */}
        <Suspense fallback={<FullScreenLoadingIndicator />}>
          <LazyFiddyFundingPanel />
        </Suspense>
      </div>
    </Page>
  );
};

export { FiddyAddFundsPage };
