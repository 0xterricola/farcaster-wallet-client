// @vitest-environment jsdom
/**
 * The last screen, held to the one thing it promises.
 *
 * The flow says "No account needed for this part" on the front door and then
 * asks for a Farcaster sign-in on the last screen. Between those two sentences
 * the visitor now actually speaks to the agent they named. This file measures
 * that the trial is really on the ready sheet, that the primary action is the
 * ordinary sign-in until it has been answered, and that it becomes the named
 * "Save <name> & sign in" — visibly the loud one — the moment a reply lands.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { resetFiddySetup, saveFiddySetup } from '~/lib/fiddySetup';

const state = vi.hoisted(() => ({ signedIn: false }));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => state.signedIn,
}));

vi.mock('~/lib/agentService', () => ({
  AgentServiceError: class AgentServiceError extends Error {},
  probeBrain: vi.fn(),
  applyBrain: vi.fn(),
  listAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

vi.mock('~/components/modals/LoginModal', () => ({
  LoginModal: () =>
    React.createElement('div', { 'data-testid': 'login' }, 'sign in'),
}));

const { FiddyOnboardingPage } =
  await import('~/pages/fiddyOnboarding/FiddyOnboardingPage');

const renderReady = () =>
  render(
    <MemoryRouter initialEntries={['/welcome/ready']}>
      <Routes>
        <Route path="/welcome" element={<FiddyOnboardingPage step="hi" />} />
        <Route
          path="/welcome/ready"
          element={<FiddyOnboardingPage step="ready" />}
        />
      </Routes>
    </MemoryRouter>,
  );

const primary = () =>
  document.querySelector('.fiddy-primary-btn') as HTMLElement | null;

beforeEach(() => {
  state.signedIn = false;
  installFakeStorage();
  saveFiddySetup({ agentName: 'Pip' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFiddySetup();
});

describe('the ready sheet', () => {
  it('carries one message to the agent by name, before the sign-in', () => {
    renderReady();

    expect(screen.getByText('Pip is ready.')).toBeTruthy();
    expect(document.querySelector('[data-fiddy="trial"]')).toBeTruthy();
    expect(screen.getByText('Say hi to Pip…')).toBeTruthy();
    expect(
      screen.getByText('What can you do for me on Farcaster?'),
    ).toBeTruthy();
  });

  it('offers the ordinary way in until the agent has answered', () => {
    renderReady();

    expect(primary()?.textContent).toBe('Go social — sign in with Farcaster');
    expect(primary()?.getAttribute('data-highlighted')).toBeNull();
  });

  it('calls account creation a Fiddy account, not a network prompt', () => {
    renderReady();

    expect(
      document.querySelector('[data-fiddy="create-account-entry"]')
        ?.textContent,
    ).toBe('New here? Make your Fiddy account');
    expect(
      screen.getByText(/Your Fiddy account is what keeps your agent/),
    ).toBeTruthy();
  });

  it('makes the sign-in the named one, and loud, once a real reply lands', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          reply: 'I can watch your mentions.',
          note: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    renderReady();

    fireEvent.click(screen.getByText('Watch my mentions'));

    await waitFor(() =>
      expect(screen.getByText('I can watch your mentions.')).toBeTruthy(),
    );
    expect(primary()?.textContent).toBe('Save Pip & sign in with Farcaster');
    expect(primary()?.getAttribute('data-highlighted')).toBe('true');
  });

  it('still opens the sign-in, and remembers the exchange across a reload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, reply: 'Standing by.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const first = renderReady();
    fireEvent.click(screen.getByText('Watch my mentions'));
    await waitFor(() => expect(screen.getByText('Standing by.')).toBeTruthy());
    first.unmount();

    // A reload: the same browser, the same screen, no second message spent.
    renderReady();
    expect(screen.getByText('Standing by.')).toBeTruthy();
    expect(primary()?.textContent).toBe('Save Pip & sign in with Farcaster');

    fireEvent.click(primary() as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('login')).toBeTruthy());
  });
});
