// @vitest-environment jsdom

/**
 * The user-reported bounce, pinned by behaviour rather than by copy: a session
 * that arrives on a setup screen is sent into the client, and the setup flow
 * still opens for someone who is not signed in.
 *
 * Why the second assertion matters as much as the first: the setup flow *is*
 * the front door for a signed-out visitor (the pivot), so a guard that hid it
 * from everyone would fix the bounce by deleting the product.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';

const state = vi.hoisted(() => ({ signedIn: false }));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => state.signedIn,
}));

// The page chrome is not what this test is about.
vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

// Brand plumbing: it dispatches a StorageEvent that jsdom refuses to build
// around a fake storage, and it has nothing to do with where a session lands.
vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

// Same reason the session tests mock it: this file's JSX has no React in scope
// under the test transform, and the footer's links are not what is being
// measured.
vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { FiddyOnboardingPage } =
  await import('~/pages/fiddyOnboarding/FiddyOnboardingPage');

const renderSetupStep = (step: 'hi' | 'ready') => {
  const path = step === 'hi' ? '/welcome' : '/welcome/ready';

  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/welcome/ready"
          element={<FiddyOnboardingPage step="ready" />}
        />
        <Route path="/welcome" element={<FiddyOnboardingPage step="hi" />} />
        <Route path="/" element={<div>the client</div>} />
      </Routes>
    </MemoryRouter>,
  );
};

describe('the setup flow and a signed-in session', () => {
  beforeEach(() => {
    state.signedIn = false;
    // jsdom in this repo has no storage API and the setup file reads one on
    // every render (see fakeStorage).
    installFakeStorage();
  });

  it('sends a signed-in session on to the client instead of the setup', () => {
    state.signedIn = true;

    renderSetupStep('ready');

    expect(screen.getByText('the client')).toBeTruthy();
    expect(screen.queryByText(/is ready\./)).toBeNull();
    expect(document.querySelector('[data-fiddy="onboarding"]')).toBeNull();
  });

  it('sends a signed-in session on to the client from the first screen too', () => {
    state.signedIn = true;

    renderSetupStep('hi');

    expect(screen.getByText('the client')).toBeTruthy();
    expect(document.querySelector('[data-fiddy="onboarding"]')).toBeNull();
  });

  it('still opens the setup for someone who is not signed in', () => {
    state.signedIn = false;

    renderSetupStep('ready');

    expect(screen.queryByText('the client')).toBeNull();
    expect(document.querySelector('[data-fiddy="onboarding"]')).toBeTruthy();
    expect(screen.getByText(/is ready\./)).toBeTruthy();
  });
});
