// @vitest-environment jsdom
/**
 * The audio-room page must not offer a space it cannot make.
 *
 * User-reported 2026-10-23, signed in on fiddy.fun: creating a space threw
 * "createAudioRoom 501 — Fiddy can't do POST /v1/audio-rooms yet: it isn't
 * something your node can carry, so nothing was signed and nothing was sent."
 * The nav entry named "Spaces" pointed at the fork's audio-room list, and that
 * page's "Start a Space" button asked the seam for a write no node can carry.
 * A space in Fiddy is Together; the nav says so now, and this page keeps its
 * own name and offers nothing it cannot do.
 *
 * Pinned here, in the order the bug reads:
 *   1. there is no start/schedule CTA, and no create request is ever made;
 *   2. the entry the page does offer goes to Together — the surface that can
 *      actually create a space and put a board under it;
 *   3. a list the node refuses is shown as the refusal, not as an empty list
 *      (an empty list reads as "nobody is live", which is a different fact).
 */

import { HelmetProvider } from '@dr.pogodin/react-helmet';
import { fireEvent, render, screen } from '@testing-library/react';
import { ApiErrorResponse, HandledFetchError } from 'farcaster-client-data';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  live: {
    data: undefined as unknown,
    isLoading: false,
    error: undefined as unknown,
    refetch: () => undefined,
  },
  scheduled: {
    data: undefined as unknown,
    isLoading: false,
    error: undefined as unknown,
    refetch: () => undefined,
  },
  navigations: [] as { to: string; params?: Record<string, unknown> }[],
  createRequests: 0,
}));

vi.mock('farcaster-client-hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    'farcaster-client-hooks',
  );
  return {
    ...actual,
    useAudioRoomsList: () => state.live,
    useScheduledAudioRoomsList: () => state.scheduled,
    // Mounting the create hook at all is the bug: count the calls.
    useStartAudioRoom:
      () =>
      (..._args: unknown[]) => {
        state.createRequests += 1;
        return Promise.reject(new Error('createAudioRoom 501'));
      },
  };
});

vi.mock('~/hooks/data/useCachedCurrentUser', () => ({
  useCachedCurrentUser: () => undefined,
}));

vi.mock('~/hooks/navigation/useSearchParams', () => ({
  useSearchParams: () => ({ tab: undefined }),
}));

vi.mock('~/hooks/navigation/useNavigate', () => ({
  useNavigate: () => (navigation: { to: string; params?: unknown }) => {
    state.navigations.push(navigation as { to: string });
  },
}));

vi.mock('~/utils/audioSpaceInstrumentation', () => ({
  trackWebAudioSpaceEvent: () => undefined,
}));

// The card is where a listing's join/rsvp writes live; it must not be part of
// what this page mounts today, and its own behaviour is covered elsewhere.
vi.mock('~/components/spaces/SpaceCard', () => ({
  SpaceCard: () => React.createElement('div', { 'data-fiddy': 'room-card' }),
}));

const { SpacesPage } = await import('~/pages/spaces/SpacesPage');

/* The real page shell: `Page` renders a Helmet, so a render outside
   HelmetProvider throws, exactly as the app would. */
const renderPage = () =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/~/spaces']}>
        <SpacesPage />
      </MemoryRouter>
    </HelmetProvider>,
  );

/** The seam's own 501 answer, in the envelope the client already parses. */
function refusedRead(status: number, message: string) {
  return new HandledFetchError('a read your node cannot answer', {
    absoluteUrl: 'https://farcaster.xyz/~api/v1/audio-rooms',
    body: undefined,
    endpointName: 'getAudioRoom',
    hasTimedOut: false,
    isHandled: true,
    isNetworkError: false,
    isOffline: false,
    method: 'GET',
    relativeUrl: '/v1/audio-rooms',
    resolvedTimeout: 1000,
    response: undefined,
    responseData: {
      errors: [{ message, reason: 'node_cannot_answer' }],
    } as unknown as ApiErrorResponse,
    status,
    timeout: 1000,
  });
}

describe('the audio-rooms page', () => {
  beforeEach(() => {
    state.live = {
      data: undefined,
      isLoading: false,
      error: undefined,
      refetch: () => undefined,
    };
    state.scheduled = {
      data: undefined,
      isLoading: false,
      error: undefined,
      refetch: () => undefined,
    };
    state.navigations = [];
    state.createRequests = 0;
  });

  it('offers no way to start or schedule a room, and asks for no create', () => {
    renderPage();

    expect(screen.queryByText('Start a Space')).toBeNull();
    expect(screen.queryByText('Schedule a Space')).toBeNull();
    expect(state.createRequests).toBe(0);

    // It says its own name, and says plainly that it cannot carry one yet.
    expect(screen.getByText('Audio rooms')).toBeTruthy();
    expect(screen.getByText(/carry one yet/)).toBeTruthy();
  });

  it('sends you to the surface that can create a space', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Spaces' }));

    expect(state.navigations).toEqual([{ to: 'together', params: {} }]);
  });

  it('shows the refusal the node gave, not an empty room list', () => {
    state.live.error = refusedRead(
      501,
      'audio rooms are a hosted product, not protocol messages',
    );

    renderPage();

    expect(screen.getByText(/isn.t on your node/)).toBeTruthy();
    expect(
      screen.getByText(
        /Audio rooms are a hosted product, not protocol messages/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/No live audio rooms right now/)).toBeNull();
  });

  it('never offers a retry for a refusal a retry cannot change', () => {
    state.live.error = refusedRead(
      501,
      'audio rooms are a hosted product, not protocol messages',
    );

    renderPage();

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
