/**
 * "Add a brain" as a place you can come back to.
 *
 * The onboarding step and this screen are the same sheet, so the choice someone
 * made on the way in is the choice they see here — and can change without
 * redoing anything.
 *
 * Reachable signed in (inside the Fiddy shell, from the Agent screen) and
 * signed out (where the fork's own chrome frames it), because nothing here
 * needs an account: only connecting a service you run stores anything.
 */

import { ChevronLeft } from 'lucide-react';
import React from 'react';

import { BrainSheet } from '~/components/fiddy/BrainSheet';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';

export const FiddyBrainsPage = () => {
  useFiddyBrandGround();

  return (
    <Page meta={{ title: 'Add a brain' }} className="fiddy-surface fiddy-page">
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
          <h1 className="fiddy-page-title">Add a brain</h1>
          <p className="fiddy-page-sub">
            Your agent can think with anything you already have. Pick what suits
            you — there is no lock-in, and you can change it whenever you like.
          </p>
        </header>

        <BrainSheet />
      </div>
    </Page>
  );
};
