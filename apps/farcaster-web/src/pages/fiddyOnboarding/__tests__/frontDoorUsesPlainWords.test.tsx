// @vitest-environment jsdom
/**
 * The front door, read by someone who came for Fiddy and knows no network names.
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { resetFiddySetup } from '~/lib/fiddySetup';

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

const { FiddyOnboardingPage } =
  await import('~/pages/fiddyOnboarding/FiddyOnboardingPage');

const renderFrontDoor = () =>
  render(
    <MemoryRouter initialEntries={['/welcome']}>
      <Routes>
        <Route path="/welcome" element={<FiddyOnboardingPage step="hi" />} />
      </Routes>
    </MemoryRouter>,
  );

const actionLabels = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-fiddy-step="hi"] button, [data-fiddy-step="hi"] a',
    ),
  ]
    .filter((element) => element.textContent?.trim())
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim());

const frontDoorText = (): string =>
  (document.querySelector('[data-fiddy-step="hi"]')?.textContent ?? '').replace(
    /\s+/g,
    ' ',
  );

beforeEach(() => {
  state.signedIn = false;
  installFakeStorage();
});

afterEach(() => {
  cleanup();
  resetFiddySetup();
});

describe('the first-time visitor front door', () => {
  it('makes reading without an account the primary action', () => {
    renderFrontDoor();

    const primary = document.querySelector(
      '[data-fiddy-step="hi"] .fiddy-primary-btn',
    );
    expect(primary?.textContent).toBe('Look around first');
    expect(primary?.getAttribute('data-fiddy')).toBe('browse-cta');
  });

  it('offers exactly three actions in plain words', () => {
    renderFrontDoor();

    expect(actionLabels()).toEqual([
      'Look around first',
      'Say hi',
      'Already have an account? Sign in',
    ]);
    expect(actionLabels().some((label) => /farcaster/i.test(label))).toBe(
      false,
    );
  });

  it('explains a Fiddy account before naming where it lives', () => {
    renderFrontDoor();

    expect(frontDoorText()).toContain(
      'Your Fiddy account lives on Farcaster, the network Fiddy posts to.',
    );
    expect(frontDoorText()).not.toMatch(
      /New to Farcaster|Already on Farcaster/,
    );
  });
});
