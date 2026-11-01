/**
 * "Connect your Farcaster account" as a place you can come back to.
 *
 * The same sheet the sign-in surface opens, at its own address, so the link can
 * be shared, reloaded, and returned to after an approval that happened on a
 * phone. Reachable signed out on purpose: connecting is something a person does
 * *before* they are signed in here, and approving in their Farcaster app is what
 * makes the sign-in honest.
 *
 * This is the connect-existing-account path. Making a *new* Farcaster account
 * here (its own fee, its own words) is a different screen with a different job;
 * the sign-in surface offers both, and neither is presented as the only way in.
 */

import { ChevronLeft } from 'lucide-react';
import React from 'react';

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';

export const FiddyConnectPage = () => {
  useFiddyBrandGround();

  return (
    <Page
      meta={{ title: 'Connect Farcaster' }}
      className="fiddy-surface fiddy-page"
    >
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
          <h1 className="fiddy-page-title">Connect Farcaster</h1>
          <p className="fiddy-page-sub">
            Let Fiddy post for you with a posting key you grant from your own
            Farcaster app. No fee, no passphrase, and you can take it back
            whenever you like.
          </p>
        </header>

        <ConnectSheet />
      </div>
    </Page>
  );
};
