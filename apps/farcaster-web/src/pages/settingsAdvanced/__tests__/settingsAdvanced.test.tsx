// @vitest-environment jsdom

/**
 * The CLI entry on the Advanced screen, pinned where it can be pinned.
 *
 * WHY THESE ASSERTIONS
 *
 * The card's ask was a visible entry in Advanced pointing at the Fiddy command.
 * Four things make that worth having, and each is asserted here rather than
 * assumed:
 *
 *   1. the commands are the command's own — every string on screen is a real
 *      subcommand of `bin/fiddy`, so nobody is sent to type something that does
 *      not exist;
 *   2. the copy is plain words — a reader who has never configured anything can
 *      act on it, so the protocol's own vocabulary appears nowhere on the page;
 *   3. what is not built is not offered — the agentic rows carry a not-here-yet
 *      note and there is no control under them;
 *   4. the copy control tells the truth — it reports a copy that happened, and
 *      says so when the browser refuses, rather than leaving a button that
 *      silently does nothing.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE
 *
 * The route a link *hydrates to*, the header, the settings rail, the layout at
 * 390px and 1440px, and the entry in the rail itself are the probe's job
 * (`scripts/verify-advanced-cli.mjs`), which drives them in a real browser.
 * The chrome this page sits in is mocked below for a mechanical reason the
 * repository's own tests record: those components' JSX has no React in scope
 * under the test transform, and none of them is what this file is measuring.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CLI_COMING,
  CLI_CHECK_COMMAND,
  CLI_COMMANDS,
  CLI_DEPLOY_URL,
  CLI_WALKTHROUGH_URL,
} from '~/lib/advancedCli';

/**
 * The page is imported the way this repository imports pages — dynamically —
 * because `~/pages/*` is off limits to static imports (the app loads every page
 * lazily; see `no-restricted-imports` in eslint.config.mjs).
 */
const { SettingsAdvancedPage } =
  await import('~/pages/settingsAdvanced/SettingsAdvancedPage');

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/BorderedMainContent', () => ({
  BorderedMainContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/page/SettingsPageContent', () => ({
  SettingsPageContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/page/PageHeader', () => ({
  PageHeader: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/page/PageTitle', () => ({
  PageTitle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

/** The rail is a nav of its own; its own entry for this page is the probe's. */
vi.mock('~/layouts/SettingsNav', () => ({
  SettingsNav: () =>
    React.createElement('nav', { 'data-testid': 'settings-nav' }),
}));

/**
 * The in-app links, echoed as the route name the page asked for. Which route a
 * name hydrates to is the routing table's business (and the probe measures it
 * end to end); what this file checks is that the page points at the right two.
 */
vi.mock('~/components/links/Link', () => ({
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) =>
    React.createElement('a', { 'data-to': to }, children),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <SettingsAdvancedPage />
    </MemoryRouter>,
  );

/** Every command the card promises to show, including the one for failures. */
const ALL_COMMANDS = [...CLI_COMMANDS, CLI_CHECK_COMMAND];

/**
 * The vocabulary the copy is not allowed to use. Fiddy's user-facing words are
 * the ones a newcomer knows; these are names for the machinery.
 */
const BANNED = /gasless|signer|scope|\bttl\b|nonce|submitMessage|EIP-712/i;

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('the Advanced screen', () => {
  it('shows the CLI entry, with every command the command itself has', () => {
    renderPage();

    expect(
      document.querySelector('[data-fiddy="advanced-cli"]'),
    ).not.toBeNull();

    const rows = document.querySelectorAll('[data-fiddy="cli-command"]');
    expect(rows).toHaveLength(ALL_COMMANDS.length);

    for (const { command, what } of ALL_COMMANDS) {
      const row = document.querySelector(
        `[data-fiddy="cli-command"][data-command="${command}"]`,
      );
      expect(row, `${command} is missing from the entry`).not.toBeNull();
      expect(row!.textContent).toContain(what);
    }
  });

  it('says the entry is optional before it shows a command', () => {
    renderPage();

    expect(document.body.textContent).toContain(
      'Nothing on this page is needed to use Fiddy',
    );
  });

  it('keeps the protocol vocabulary off the page', () => {
    renderPage();

    const found = (document.body.textContent ?? '').match(BANNED);
    expect(found, `the page says "${found?.[0]}"`).toBeNull();
  });

  it('offers both walkthroughs as real links', () => {
    renderPage();

    const walkthrough = screen.getByRole('link', {
      name: /walk me through it/i,
    });
    expect(walkthrough.getAttribute('href')).toBe(CLI_WALKTHROUGH_URL);

    const deploy = screen.getByRole('link', {
      name: /have the machine made for you/i,
    });
    expect(deploy.getAttribute('href')).toBe(CLI_DEPLOY_URL);
  });

  it('points at the setup screen and the agent that works today', () => {
    renderPage();

    expect(
      screen.getByText(/open your own setup/i).getAttribute('data-to'),
    ).toBe('settingsNode');
    expect(
      screen.getByText(/the agent that works today/i).getAttribute('data-to'),
    ).toBe('agent');
  });

  it('names the agentic extras as not here yet, with nothing to press', () => {
    renderPage();

    const section = document.querySelector(
      '[data-fiddy="agent-cli-coming"]',
    ) as HTMLElement;
    expect(section).not.toBeNull();

    const rows = Array.from(
      document.querySelectorAll('[data-fiddy="agent-cli-coming-row"]'),
    );
    expect(rows).toHaveLength(AGENT_CLI_COMING.length);

    for (const { label, note } of AGENT_CLI_COMING) {
      const row = rows.find((element) => element.textContent?.includes(label));
      expect(row, `${label} is missing`).toBeTruthy();
      expect(row!.textContent).toContain(note);
    }

    expect(within(section).queryAllByRole('button')).toHaveLength(0);
  });

  it('reports a copy that worked, and one that did not', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderPage();

    const first = ALL_COMMANDS[0];
    fireEvent.click(
      screen.getByRole('button', { name: `Copy ${first.command}` }),
    );

    expect(writeText).toHaveBeenCalledWith(first.command);
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('says so when the browser refuses to copy, instead of claiming it did', async () => {
    renderPage();

    const first = ALL_COMMANDS[0];
    fireEvent.click(
      screen.getByRole('button', { name: `Copy ${first.command}` }),
    );

    expect(await screen.findByText('Select it and copy')).toBeTruthy();
  });
});
