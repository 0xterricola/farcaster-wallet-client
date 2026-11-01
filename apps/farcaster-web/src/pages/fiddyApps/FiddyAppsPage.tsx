/**
 * "Connect apps" as a place you can come back to.
 *
 * Same sheet as the onboarding step, so the list cannot say one thing on the
 * way in and another afterwards. Rows Fiddy cannot reach yet stay visible with
 * an honest "soon" tag rather than disappearing.
 */

import { ChevronLeft } from 'lucide-react';
import React from 'react';

import { AppsSheet } from '~/components/fiddy/AppsSheet';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';

export const FiddyAppsPage = () => {
  useFiddyBrandGround();

  return (
    <Page meta={{ title: 'Connect apps' }} className="fiddy-surface fiddy-page">
      <div className="fiddy-page-inner">
        <Link
          to="agent"
          params={{}}
          searchParams={{}}
          title="Your agent"
          className="fiddy-back"
        >
          <ChevronLeft aria-hidden="true" />
          Your agent
        </Link>

        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">Connect apps</h1>
          <p className="fiddy-page-sub">
            The apps your agent is allowed to help with. Turn one on and Fiddy
            can read and reply there — but it always asks you before it posts.
          </p>
        </header>

        <AppsSheet />
      </div>
    </Page>
  );
};
