/**
 * Advanced — where the command line lives, in the product.
 *
 * WHY THIS SURFACE EXISTS NOW
 *
 * The route has been here since the fork and rendered one word ("Advanced"), as
 * did its absence from the settings list: the page was real, reachable only by
 * typing its address, and empty when you got there. Fiddy's agentic half starts
 * on the command line, and a door nothing points at is not a door — so this
 * page says what the Fiddy command is, in the order you run it, with each line
 * copyable, and the settings list links here (see `~/layouts/SettingsNav`).
 *
 * WHAT IT IS CAREFUL ABOUT
 *
 * Two things, both about not over-claiming:
 *
 * * Nothing here is required. Fiddy in the browser is the product; the command
 *   line is for a reader who wants their own machine to answer. The page says
 *   so before it shows a single command.
 * * The agentic extras the command line is for are named as not-here-yet. There
 *   is no button on them, because there is nothing behind one — the panel that
 *   does work today is linked instead.
 *
 * The page holds no state and reads nothing: it is copy, links and two
 * copy-to-clipboard controls, so it renders for a signed-in reader whatever the
 * data layer is doing.
 */

import React, { memo } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { SettingsNav } from '~/layouts/SettingsNav';
import {
  AGENT_CLI_COMING,
  AGENT_CLI_LEAD,
  AGENT_CLI_TITLE,
} from '~/lib/advancedCli';

import { CliEntryCard } from './Component/CliEntryCard';

const SettingsAdvancedPage = memo(() => {
  return (
    <Page meta={{ title: 'Advanced / Fiddy' }}>
      <div className="border-default sm:border-x">
        <PageHeader hideCastButton>
          <div className="flex items-center gap-2">
            <PageTitle>Advanced</PageTitle>
            <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              Optional
            </span>
          </div>
        </PageHeader>
      </div>
      <BorderedMainContent className="flex flex-row">
        <SettingsNav />
        <SettingsPageContent>
          <div className="flex flex-col gap-6">
            <p className="text-sm text-muted">
              Nothing on this page is needed to use Fiddy. It is where the
              command line lives, and where the setup you run yourself starts.
            </p>

            <CliEntryCard />

            <section
              data-fiddy="agent-cli-coming"
              aria-labelledby="fiddy-agent-cli-heading"
              className="rounded-lg border bg-secondary p-4 border-default"
            >
              <h3
                id="fiddy-agent-cli-heading"
                className="mb-2 text-base font-bold text-primary"
              >
                {AGENT_CLI_TITLE}
              </h3>
              <p className="mb-3 text-sm text-primary">{AGENT_CLI_LEAD}</p>
              <ul className="mb-3 flex list-none flex-col gap-2 p-0">
                {AGENT_CLI_COMING.map((entry) => (
                  <li
                    key={entry.label}
                    className="flex items-center gap-2"
                    data-fiddy="agent-cli-coming-row"
                  >
                    <span className="text-sm text-primary">{entry.label}</span>
                    <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                      {entry.note}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to="agent"
                params={{}}
                searchParams={{}}
                title="Your agent, inside Fiddy"
                className="text-sm text-primary underline"
              >
                The agent that works today, inside the app
              </Link>
            </section>

            <section className="rounded-lg border bg-secondary p-4 border-default">
              <h3 className="mb-2 text-base font-bold text-primary">
                The setup you run
              </h3>
              <p className="mb-3 text-sm text-primary">
                Choosing which server answers for you — your own, or one that is
                already open to everyone — and everything that goes with it.
              </p>
              <Link
                to="settingsNode"
                params={{}}
                searchParams={{}}
                title="Your own setup"
                className="text-sm text-primary underline"
              >
                Open your own setup
              </Link>
            </section>
          </div>
        </SettingsPageContent>
      </BorderedMainContent>
    </Page>
  );
});

SettingsAdvancedPage.displayName = 'SettingsAdvancedPage';

export { SettingsAdvancedPage };
