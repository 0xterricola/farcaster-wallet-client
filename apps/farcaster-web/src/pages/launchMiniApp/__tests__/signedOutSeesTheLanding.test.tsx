// @vitest-environment jsdom

/**
 * The launch route before a frame read: a signed-out visitor gets the landing.
 *
 * Measured on fiddy.fun at 5ea187d, signed out, 1440x900:
 * `/~/mini-apps/launch?domain=dwr.xyz` painted "Error retrieving data. Please
 * try again." because the page mounted `useFrameDetails` — a SUSPENSE query —
 * before it decided whether anyone was signed in. On the node-backed client
 * there is no node-backed frame reader, so the read rejects and the
 * FullScreenErrorBoundary above the router takes the whole page. The launch
 * route was the only route that rendered the landing, so the landing became
 * unreachable and the 'run your own node →' link it carries could not be seen
 * anywhere on the site.
 *
 * What is pinned here is the ORDER, not the copy: signed out → the landing is
 * painted and the frame read is NEVER mounted; signed in → the read still
 * happens, because resolving the frame is what picks a session's destination.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';

const state = vi.hoisted(() => ({
  signedIn: false,
  frameReads: 0,
  navigations: [] as {
    to: string;
    params?: Record<string, unknown>;
    searchParams?: Record<string, unknown>;
  }[],
  frame: undefined as { harmful?: boolean; homeUrl?: string } | undefined,
}));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => state.signedIn,
}));

// The read this file is about: mounting it is the thing being measured, so the
// stub counts mounts instead of reaching for a node.
vi.mock('farcaster-client-hooks', () => ({
  useFrameDetails: () => {
    state.frameReads += 1;
    return { data: undefined };
  },
  useGloballyCachedFrame: () => state.frame,
}));

vi.mock('~/hooks/navigation/useNavigate', () => ({
  useNavigate:
    () =>
    (navigation: {
      to: string;
      params?: Record<string, unknown>;
      searchParams?: Record<string, unknown>;
    }) => {
      state.navigations.push(navigation);
    },
}));

// The landing's own internals are covered by its own test; here it only has to
// be the surface that gets painted.
vi.mock('~/lazy/pages', () => ({
  HomeLandingPage: () =>
    React.createElement('div', { 'data-fiddy': 'landing' }, 'the landing'),
}));

vi.mock('~/components/loaders/FullScreenLoadingIndicator', () => ({
  FullScreenLoadingIndicator: () =>
    React.createElement('div', { 'data-fiddy': 'loading' }),
}));

const { LaunchMiniAppPage } =
  await import('~/pages/launchMiniApp/LaunchMiniAppPage');

const renderLaunchRoute = () =>
  render(
    <MemoryRouter initialEntries={['/~/miniapps/dwr.xyz/app?domain=dwr.xyz']}>
      <Routes>
        <Route
          path="/~/miniapps/:id/:slug?/*"
          element={<LaunchMiniAppPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

describe('the mini app launch route, signed out', () => {
  beforeEach(() => {
    state.signedIn = false;
    state.frameReads = 0;
    state.navigations = [];
    state.frame = undefined;
    installFakeStorage();
  });

  it('paints the landing without mounting the frame read', () => {
    renderLaunchRoute();

    expect(screen.getByText('the landing')).toBeTruthy();
    // The whole point: no frame read, so nothing can reject and take the page.
    expect(state.frameReads).toBe(0);
    expect(state.navigations).toEqual([]);
  });

  it('still sends a signed-in session through the frame read', () => {
    state.signedIn = true;

    renderLaunchRoute();

    expect(state.frameReads).toBe(1);
    expect(screen.queryByText('the landing')).toBeNull();
  });

  /**
   * The two destinations the launch route has always had, still reached by a
   * session: nowhere to send a session whose frame cannot be resolved (no
   * harmful/absent frame -> the mini apps list), and the feed carrying the
   * frame's URL when there is one.
   */
  it('still sends a session to the mini apps list when the frame is unresolved', () => {
    state.signedIn = true;
    state.frame = undefined;

    renderLaunchRoute();

    expect(state.navigations).toEqual([
      { to: 'miniApps', params: {}, searchParams: {} },
    ]);
  });

  it('still hands a resolved frame to the feed as its launchFrameUrl', () => {
    state.signedIn = true;
    state.frame = { harmful: false, homeUrl: 'https://dwr.xyz/' };

    renderLaunchRoute();

    expect(state.navigations.map(({ to }) => to)).toEqual(['homeFeed']);
    expect(
      String(state.navigations[0]?.searchParams?.launchFrameUrl),
    ).toContain('dwr.xyz');
  });
});
