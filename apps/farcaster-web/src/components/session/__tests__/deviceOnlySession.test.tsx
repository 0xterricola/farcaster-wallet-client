// @vitest-environment jsdom

/**
 * The decision this file guards: when does the client treat a session as
 * device-only, what does it say about it, and does the landing offer a retry
 * that could never succeed? Getting any of those wrong is what produced the
 * bare "Could not reach Farcaster" page this card is about, so they are pinned
 * here rather than left to the end-to-end probe alone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react';
import { ApiErrorResponse, HandledFetchError } from 'farcaster-client-data';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routes } from '~/constants/routes';
import { LOCAL_SESSION_SECRET_PREFIX } from '~/lib/siwfSession';

const state = vi.hoisted(() => ({
  authToken: undefined as { secret: string; expiresAt: number } | undefined,
  localApiEnabled: false,
  // The node-backed client: the adapter on, and a node actually named.
  nodeBackedClient: false,
  nodeNamed: false,
  user: undefined as
    | { fid?: number; username?: string; displayName?: string }
    | undefined,
  signOut: vi.fn(async () => undefined),
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ authToken: state.authToken, signOut: state.signOut }),
}));

vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({
    result: { state: { user: state.user } },
  }),
}));

vi.mock('~/constants/api', () => ({
  get localApiEnabled() {
    return state.localApiEnabled;
  },
}));

vi.mock('~/snapchain/nodeApi/nodeBackedClientFlag', () => ({
  isNodeBackedClientEnabled: () => state.nodeBackedClient,
}));

vi.mock('~/snapchain/nodeEnv', () => ({
  isNodeExplicitlyConfigured: () => state.nodeNamed,
}));

vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { describeDeviceOnlyAccount, useDeviceOnlySession } =
  await import('~/components/session/useDeviceOnlySession');
const { DeviceOnlySessionPage } =
  await import('~/components/session/DeviceOnlySessionPage');
const { ShellSectionErrorBoundary } =
  await import('~/components/errors/ShellSectionErrorBoundary');
const { DeviceOnlySessionLanding, isAccountFreeDeviceOnlyPath } =
  await import('~/components/session/DeviceOnlySessionLanding');

const localToken = {
  secret: `${LOCAL_SESSION_SECRET_PREFIX}4242:abc`,
  expiresAt: 0,
};
const serverToken = { secret: 'a-real-token', expiresAt: 0 };

beforeEach(() => {
  state.authToken = undefined;
  state.localApiEnabled = false;
  state.nodeBackedClient = false;
  state.nodeNamed = false;
  state.user = undefined;
  state.signOut.mockClear();
});

describe('useDeviceOnlySession', () => {
  it('is device-only for a local marker with no API that can serve it', () => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy', displayName: 'Fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
    expect(result.current).toMatchObject({
      fid: 4242,
      username: 'fiddy',
      displayName: 'Fiddy',
    });
  });

  it('is NOT device-only when the dev mock API is serving the app', () => {
    // The escape hatch exists so the shell can be worked on; a local marker
    // with the mock API behind it is a session that works, and must not be
    // sent to the "nothing can serve this" landing.
    state.authToken = localToken;
    state.localApiEnabled = true;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(false);
  });

  it('is NOT device-only for a server-backed session', () => {
    state.authToken = serverToken;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(false);
  });

  it('is NOT device-only when the node is the data source and one is named', () => {
    // The whole point of the node adapter: the shell no longer needs a
    // farcaster.xyz session, so a local sign-in runs the real client.
    state.authToken = localToken;
    state.nodeBackedClient = true;
    state.nodeNamed = true;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(false);
  });

  it('stays device-only when the adapter is on but no node is named', () => {
    // Nothing to read from: the landing is still the honest screen.
    state.authToken = localToken;
    state.nodeBackedClient = true;
    state.nodeNamed = false;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
  });

  it('stays device-only when the node adapter is switched off', () => {
    state.authToken = localToken;
    state.nodeBackedClient = false;
    state.nodeNamed = true;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
  });

  it('survives a session with no cached identity at all', () => {
    state.authToken = localToken;

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
    expect(describeDeviceOnlyAccount(result.current)).toBe('');
  });
});

describe('describeDeviceOnlyAccount', () => {
  it('names handle and fid the way the sign-in screen does', () => {
    expect(
      describeDeviceOnlyAccount({
        isDeviceOnly: true,
        fid: 4242,
        username: 'fiddy',
      }),
    ).toBe('@fiddy · fid 4242');
  });

  it('falls back to the display name, then to the fid alone', () => {
    expect(
      describeDeviceOnlyAccount({
        isDeviceOnly: true,
        fid: 4242,
        displayName: 'Fiddy Tester',
      }),
    ).toBe('Fiddy Tester');

    expect(describeDeviceOnlyAccount({ isDeviceOnly: true, fid: 4242 })).toBe(
      'fid 4242',
    );
  });

  it('says nothing for a normal session', () => {
    expect(describeDeviceOnlyAccount({ isDeviceOnly: false })).toBe('');
  });
});

describe('DeviceOnlySessionPage', () => {
  beforeEach(() => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy', displayName: 'Fiddy' };
  });

  it('names the account and says what is missing', () => {
    const { getByText, queryByText } = render(<DeviceOnlySessionPage />);

    expect(getByText('@fiddy · fid 4242')).toBeTruthy();
    expect(
      getByText(/Farcaster signed this device in, and that sign-in is real/),
    ).toBeTruthy();
    expect(getByText(/Not reachable from this device yet/)).toBeTruthy();

    // Never the fork's generic network page, and never a retry that cannot
    // succeed for a session with nothing behind it.
    expect(queryByText(/Could not reach Farcaster/)).toBeNull();
    expect(queryByText(/Try again/)).toBeNull();
  });

  it('offers the account-free surfaces and a single way out', () => {
    const { getByText } = render(<DeviceOnlySessionPage />);

    expect(getByText('Add a brain')).toBeTruthy();
    expect(getByText('Connect apps')).toBeTruthy();

    getByText(/Sign out/).click();
    expect(state.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('ShellSectionErrorBoundary', () => {
  const Thrower = () => {
    throw new Error('the region could not load');
  };

  /**
   * The node adapter's own refusals, built the way the client builds them
   * (`HandledFetchError` with the hosted API's error envelope).
   */
  const makeNodeRefusal = (message: string, status: number) =>
    new HandledFetchError('a read your node cannot answer', {
      absoluteUrl: undefined,
      body: undefined,
      endpointName: 'searchCasts',
      hasTimedOut: false,
      isHandled: true,
      isNetworkError: false,
      isOffline: false,
      method: 'GET',
      relativeUrl: '/v2/search-casts',
      resolvedTimeout: 1000,
      response: undefined,
      responseData: { errors: [{ message }] } as unknown as ApiErrorResponse,
      status,
      timeout: 1000,
    });

  const ThrowNodeCannotAnswer = () => {
    throw makeNodeRefusal('a read node keeps no search index', 501);
  };

  const ThrowNodeDidNotAnswer = () => {
    throw makeNodeRefusal(
      'Your node did not answer this read: fetch failed',
      502,
    );
  };

  const renderBoundary = (label: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ShellSectionErrorBoundary label={label}>
          <Thrower />
        </ShellSectionErrorBoundary>
      </QueryClientProvider>,
    );

  const renderBoundaryAround = (label: string, child: React.ReactNode) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ShellSectionErrorBoundary label={label}>
          {child}
        </ShellSectionErrorBoundary>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('degrades in place, and with a device-only session offers no false retry', () => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy' };

    const { getByText, queryByText } = renderBoundary('Channels');

    expect(getByText('Channels needs a server session')).toBeTruthy();
    expect(queryByText(/Try again/)).toBeNull();
  });

  it('keeps a real retry for a normal session', () => {
    state.authToken = serverToken;

    const { getByText } = renderBoundary('Channels');

    expect(getByText('Channels couldn’t load')).toBeTruthy();
    expect(getByText(/Try again/)).toBeTruthy();
  });

  it('shows the node’s own sentence for a read the node cannot answer', () => {
    // MEASURED against a live node (search, /~/channels, /~/apps/trending):
    // the region used to say "Error retrieving data. Please try again." and
    // never the reason the adapter wrote. The sentence is the honest answer.
    state.authToken = serverToken;

    const { getByText, queryByText } = renderBoundaryAround(
      'Search',
      <ThrowNodeCannotAnswer />,
    );

    expect(getByText('Search isn’t on your node')).toBeTruthy();
    expect(getByText(/A read node keeps no search index/)).toBeTruthy();
    expect(queryByText(/Error retrieving data/)).toBeNull();
    // Nothing about a node that cannot answer this read improves on a retry.
    expect(queryByText(/Try again/)).toBeNull();
  });

  it('keeps a real retry when the node did not answer at all', () => {
    // A node that is down is a different thing: the retry is honest there.
    state.authToken = serverToken;

    const { getByText } = renderBoundaryAround(
      'Feed',
      <ThrowNodeDidNotAnswer />,
    );

    expect(getByText(/Your node did not answer this read/)).toBeTruthy();
    expect(getByText(/Try again/)).toBeTruthy();
  });
});

describe('a device-only session on the two account-free surfaces', () => {
  /**
   * The defect this guards (review round 1, measured on the real API): the
   * landing offered "Add a brain" and "Connect apps" while the layout's
   * device-only short-circuit swallowed both routes, so clicking one changed
   * the URL to /~/agent/brains and re-rendered the landing, byte for byte. The
   * old test asserted the label was present — presence of copy is not
   * reachability, and the layout that swallowed the route was not mounted. So:
   * mount the layout, at the real route paths, and assert the *surface* comes
   * up.
   */
  beforeEach(() => {
    state.authToken = localToken;
    state.localApiEnabled = false;
    state.user = { fid: 4242, username: 'fiddy', displayName: 'Fiddy' };
  });

  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<DeviceOnlySessionLanding />}>
              <Route
                path={routes.fiddyBrains.path}
                element={<div>THE BRAINS SURFACE</div>}
              />
              <Route
                path={routes.fiddyApps.path}
                element={<div>THE APPS SURFACE</div>}
              />
              <Route
                path={routes.homeFeed.path}
                element={<div>THE FEED SURFACE</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('renders the brains surface itself instead of the landing again', () => {
    const { getByText, queryByText } = renderAt(routes.fiddyBrains.path);

    expect(getByText('THE BRAINS SURFACE')).toBeTruthy();
    expect(queryByText(/Not reachable from this device yet/)).toBeNull();
  });

  it('renders the apps surface itself instead of the landing again', () => {
    const { getByText, queryByText } = renderAt(routes.fiddyApps.path);

    expect(getByText('THE APPS SURFACE')).toBeTruthy();
    expect(queryByText(/Not reachable from this device yet/)).toBeNull();
  });

  it('keeps the account and one way back on screen around the surface', () => {
    const { getByText, queryByText } = renderAt(routes.fiddyBrains.path);

    expect(getByText('@fiddy · fid 4242')).toBeTruthy();
    expect(getByText(/Signed in on this device/)).toBeTruthy();
    expect(queryByText(/Could not reach Farcaster/)).toBeNull();
  });

  it('still lands on the device-only screen everywhere else', () => {
    const { getByText, queryByText } = renderAt(routes.homeFeed.path);

    expect(getByText(/Not reachable from this device yet/)).toBeTruthy();
    expect(queryByText('THE FEED SURFACE')).toBeNull();
  });

  it('licenses exactly those two paths, read off the route table', () => {
    expect(isAccountFreeDeviceOnlyPath(routes.fiddyBrains.path)).toBe(true);
    expect(isAccountFreeDeviceOnlyPath(routes.fiddyApps.path)).toBe(true);
    // Same screen, written with a trailing slash.
    expect(isAccountFreeDeviceOnlyPath(`${routes.fiddyApps.path}/`)).toBe(true);

    expect(isAccountFreeDeviceOnlyPath(routes.agent.path)).toBe(false);
    expect(isAccountFreeDeviceOnlyPath(routes.homeFeed.path)).toBe(false);
    expect(
      isAccountFreeDeviceOnlyPath(`${routes.fiddyBrains.path}/anything`),
    ).toBe(false);
  });
});
