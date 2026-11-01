// @vitest-environment jsdom

/**
 * Together, pinned where a browser probe cannot pin it.
 *
 * What matters here is not that the screen looks right (the probe measures
 * that) but that the boring, easy-to-break contract holds: the session token
 * travels as a bearer and nowhere else, a dead service becomes a sentence
 * rather than a stack trace, a spent invite says so, and moving a card is one
 * PATCH with the version it read.
 */

import { HelmetProvider } from '@dr.pogodin/react-helmet';
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
import {
  togetherBaseUrl,
  TogetherError,
  togetherRequest,
} from '~/lib/together';
// A test renders the page component itself: the lazy wrapper in ~/lazy/pages
// exists to keep the production bundle split, and awaiting it here would test
// the wrapper, not the surface.
// eslint-disable-next-line no-restricted-imports
import { TogetherJoinPage } from '~/pages/together/TogetherJoinPage';
// eslint-disable-next-line no-restricted-imports
import { TogetherPage } from '~/pages/together/TogetherPage';

/**
 * The pages read and write the stored session through `storageUtils`, which is
 * localforage: real in a browser, "no available storage method" in jsdom. The
 * tests want the value, not the driver, so this stands in for it.
 */
const stored = vi.hoisted(() => new Map<string, unknown>());

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    stored.has(key) ? stored.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    stored.set(key, value);
  },
  deleteItem: async (key: string) => {
    stored.delete(key);
  },
}));

vi.mock('~/lazy/components', () => ({
  LoginQRCode: ({ url }: { url: string }) => <div data-testid="qr">{url}</div>,
}));

/**
 * The brand-ground hook paints the document and dispatches a StorageEvent with
 * a real Storage. jsdom cannot construct one from the fake storage the other
 * Fiddy tests install, so it is stubbed here; what it does to the document is
 * measured in the browser probe instead, which is the only place it matters.
 */
vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

const SESSION = {
  token: 'session-token',
  fid: 42,
  username: 'elena',
  pfp_url: null,
  space_id: 'space-1',
};

const SPACE = {
  id: 'space-1',
  name: 'Fiddy launch',
  channel: 'fiddy',
  owner_fid: 42,
  about: '',
  role: 'owner',
};

const MEMBER = {
  space_id: 'space-1',
  fid: 42,
  username: 'elena',
  pfp_url: null,
  role: 'owner',
  joined_at: 1,
};

const CARD = {
  id: 'card-1',
  space_id: 'space-1',
  title: 'Ship the Together surface',
  note: '',
  status: 'todo',
  assignee_fid: null,
  created_by_fid: 42,
  version: 1,
  created_at: 1,
  updated_at: 1,
};

/** Records what the page asked for, so the assertions can read the wire. */
type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The real page shell: `Page` renders `PageMeta`, which is a Helmet — so a
 * render outside HelmetProvider throws, exactly as the app would.
 */
const Shell = ({
  children,
  entries,
}: {
  children: React.ReactNode;
  entries: string[];
}) => (
  <HelmetProvider>
    <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
  </HelmetProvider>
);

let calls: Call[] = [];

const respond = (
  routes: (url: string, call: Call) => Response | undefined,
): void => {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const answer = routes(url, call);

      if (!answer) {
        throw new TypeError('Failed to fetch');
      }

      return answer;
    },
  );
};

const statePayload = (cards: (typeof CARD)[] = [CARD]) => ({
  space: SPACE,
  me: { fid: 42, username: 'elena', pfp_url: null, role: 'owner' },
  members: [MEMBER],
  cards,
  cursor: 5,
  pending_announcements: 0,
});

beforeEach(() => {
  // jsdom in this repo exposes no window.localStorage, and Fiddy's surfaces
  // read it (the brand ground pins the client dark). Same helper the Fiddy
  // setup tests use.
  installFakeStorage();
  stored.clear();
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Together client', () => {
  it('reads the service origin from the build, and falls back to loopback', () => {
    // The fallback is what a self-hosted alpha needs: open the app and the
    // space service is on this machine, not on somebody's domain.
    expect(togetherBaseUrl()).toContain('127.0.0.1:8766');
  });

  it('sends the session token as a bearer header and nothing else', async () => {
    respond(() => json(200, { ok: true }));
    await togetherRequest('/state', { token: 'session-token' });
    expect(calls[0].url).toContain('/spaces/state');
    expect(calls[0].headers.authorization).toBe('Bearer session-token');
    expect(JSON.stringify(calls[0])).not.toContain('session-token&');
  });

  it('turns an unreachable service into a sentence, not a stack trace', async () => {
    respond(() => undefined);
    await expect(togetherRequest('/state')).rejects.toThrow(TogetherError);
    await expect(togetherRequest('/state')).rejects.toThrow(
      /could not reach the space service/i,
    );
  });

  it('passes on what the service said when it refuses', async () => {
    respond(() =>
      json(409, { detail: 'Someone else moved this card — refresh' }),
    );
    await expect(togetherRequest('/cards/card-1', {})).rejects.toThrow(
      'Someone else moved this card — refresh',
    );
  });
});

describe('Together — the front door', () => {
  it('offers the Farcaster door and says what it will never hold', async () => {
    respond(() => json(200, { fid: 42, space_id: null, spaces: [] }));
    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );

    expect(
      await screen.findByRole('button', { name: 'Sign in with Farcaster' }),
    ).toBeTruthy();
    expect(screen.getByText(/never keys, never seed phrases/i)).toBeTruthy();
    expect(screen.getByText(/one project, one board/i)).toBeTruthy();
  });

  it('shows the QR the service minted when someone starts signing in', async () => {
    respond((url) =>
      url.endsWith('/spaces/auth')
        ? json(200, {
            request_id: 'req-1',
            url: 'https://farcaster.xyz/~/siwf?channel=1',
            expires_at: 1,
            verifier: 'relay',
          })
        : json(200, { state: 'pending' }),
    );

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with Farcaster' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('qr').textContent).toContain(
        'https://farcaster.xyz/~/siwf?channel=1',
      ),
    );
    expect(calls[0].body).toContain('"domain"');
  });
});

describe('Together — the board', () => {
  const renderBoard = async () => {
    stored.set('together-space-session', SESSION);
    respond((url, _call) => {
      if (url.includes('/spaces/mine')) {
        return json(200, { fid: 42, space_id: 'space-1', spaces: [SPACE] });
      }

      if (url.includes('/spaces/state')) {
        return json(200, statePayload());
      }

      if (url.includes('/spaces/events')) {
        return json(200, { cursor: 5, latest: 5, events: [] });
      }

      if (url.includes('/spaces/cards/')) {
        return json(200, { ...CARD, status: 'doing', version: 2 });
      }

      return json(200, {});
    });

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    await screen.findByText('Ship the Together surface');
  };

  it('renders the shared board with every member on it', async () => {
    await renderBoard();
    expect(screen.getByText('Fiddy launch')).toBeTruthy();
    expect(screen.getByText('#fiddy')).toBeTruthy();
    expect(screen.getByText(/@elena · owner/)).toBeTruthy();
    expect(screen.getByText('To do')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(
      screen.getByText(/each card is worked by whoever picks it up/i),
    ).toBeTruthy();
  });

  it('moves a card with the version it read, so two people cannot clobber each other', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            call.url.includes('/spaces/cards/card-1'),
        ),
      ).toBe(true),
    );
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      status: 'doing',
      version: 1,
    });
    expect(patch?.headers.authorization).toBe('Bearer session-token');
  });
});

describe('Together — the other end of an invite link', () => {
  const renderJoin = (token = 'invite-token') =>
    render(
      <Shell entries={[`/~/together/join/${token}`]}>
        <Routes>
          <Route
            element={<TogetherJoinPage />}
            path="/~/together/join/:token"
          />
          <Route element={<TogetherPage />} path="/~/together" />
        </Routes>
      </Shell>,
    );

  it('says whose space it is before asking for anything', async () => {
    respond(() =>
      json(200, {
        space: { id: 'space-1', name: 'Fiddy launch', channel: 'fiddy' },
        invited_by_fid: 42,
        invited_by_username: 'elena',
        expires_at: 9,
        uses_left: 1,
      }),
    );

    renderJoin();
    await screen.findByText('Fiddy launch');
    expect(screen.getByText(/@elena invited you/)).toBeTruthy();
    expect(screen.getByText(/1 use left/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Sign in with Farcaster and join/ }),
    ).toBeTruthy();
    expect(screen.getByText(/no email, no password, no keys/i)).toBeTruthy();
  });

  it('reads a spent link as a sentence', async () => {
    respond(() => json(410, { detail: 'This invite link has expired' }));
    renderJoin('spent');
    expect(
      await screen.findByText('That invite is spent or expired.'),
    ).toBeTruthy();
  });

  it('joins with the session the handshake produced', async () => {
    respond((url, _call) => {
      if (url.includes('/spaces/invites/invite-token/join')) {
        return json(200, {
          space: SPACE,
          already_member: false,
          session_token: 'session-token',
        });
      }

      if (url.includes('/spaces/invites/')) {
        return json(200, {
          space: { id: 'space-1', name: 'Fiddy launch', channel: 'fiddy' },
          invited_by_fid: 42,
          invited_by_username: 'elena',
          expires_at: 9,
          uses_left: 1,
        });
      }

      if (url.endsWith('/spaces/auth')) {
        return json(200, {
          request_id: 'req-1',
          url: 'https://farcaster.xyz/x',
        });
      }

      if (url.includes('/spaces/auth/')) {
        return json(200, {
          state: 'completed',
          session_token: 'session-token',
          fid: 42,
          username: 'elena',
          pfp_url: null,
          space_id: 'space-1',
        });
      }

      return json(200, {});
    });

    // A stored session skips the QR entirely: somebody already signed in on
    // this device, and asking them to scan twice would be a bug.
    stored.set('together-space-session', SESSION);

    renderJoin();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Sign in with Farcaster and join/,
      }),
    );

    expect(await screen.findByText('You joined the space.')).toBeTruthy();
    const join = calls.find((call) => call.url.includes('/join'));
    expect(join?.headers.authorization).toBe('Bearer session-token');
    expect(screen.getByRole('link', { name: 'Open the board' })).toBeTruthy();
  });
});
