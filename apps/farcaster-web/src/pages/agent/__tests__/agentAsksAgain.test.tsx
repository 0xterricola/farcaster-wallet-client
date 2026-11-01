// @vitest-environment jsdom
/**
 * The Agent tab asks again.
 *
 * The bug this file pins down, measured live: an owner hatched their agent and
 * the tab still said "Not awake yet" — the surface read the service once per
 * visit, so an agent that started existing while the tab was open (hatched in
 * another tab, or the service coming back) was invisible until a reload. The
 * card's words: "the client never learns the agent exists".
 *
 * So: a return to the tab, or the "Check again" button, is a new reading — the
 * agent list when paired, one more ask for the owner session when the last ask
 * failed for a reason a retry can change, and nothing at all when there is no
 * proof left to spend (asking again would say the same sentence).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';

const listAgents = vi.fn();
const fetchHatchQuote = vi.fn();
const fetchHermesCatalog = vi.fn();
const fetchServiceHealth = vi.fn();
const probeAgentService = vi.fn();

vi.mock('~/lib/agentService', async () => {
  const actual =
    await vi.importActual<typeof import('~/lib/agentService')>(
      '~/lib/agentService',
    );
  return {
    ...actual,
    listAgents: (...args: unknown[]) => listAgents(...args),
    fetchHatchQuote: (...args: unknown[]) => fetchHatchQuote(...args),
    fetchHermesCatalog: (...args: unknown[]) => fetchHermesCatalog(...args),
    fetchServiceHealth: (...args: unknown[]) => fetchServiceHealth(...args),
    probeAgentService: (...args: unknown[]) => probeAgentService(...args),
  };
});

const agentSession = {
  session: null as null | { baseUrl: string; token: string },
  pair: vi.fn(async (session: { baseUrl: string; token: string }) => {
    agentSession.session = session;
  }),
  forget: vi.fn(async () => {
    agentSession.session = null;
  }),
};

vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: agentSession.session ? 'paired' : 'unpaired',
    session: agentSession.session,
    pair: agentSession.pair,
    forget: agentSession.forget,
  }),
}));

vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => ({ fid: 4242 }),
}));

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/links/Link', async () => {
  const { routes } =
    await vi.importActual<typeof import('~/constants/routes')>(
      '~/constants/routes',
    );
  return {
    Link: ({
      to,
      children,
    }: {
      to: keyof typeof routes;
      children?: React.ReactNode;
    }) => React.createElement('a', { href: routes[to].path }, children),
  };
});

vi.mock('~/utils/errorUtils', () => ({ trackError: () => undefined }));

vi.mock('~/lib/agentSchedules', async () => {
  const actual = await vi.importActual<typeof import('~/lib/agentSchedules')>(
    '~/lib/agentSchedules',
  );
  return {
    ...actual,
    loadSchedules: async () => [],
    saveSchedules: async () => undefined,
  };
});

const { AgentPage } = await import('~/pages/agent/AgentPage');

const PROOF = {
  fid: 4242,
  message: 'fiddy.fun wants you to sign in with your Ethereum account: 0xabc',
  signature: `0x${'a'.repeat(130)}`,
  at: Date.now(),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const OPEN_REPLY = {
  ok: true,
  session: {
    token: 'owner-session-token-1234',
    expiresAt: Date.now() + 1_000_000,
    fid: 4242,
    name: 'Flo',
  },
  agent: { name: 'Flo', brain: { kind: 'default' } },
  provisioning: {
    open: false,
    code: 'HATCH_NOT_ENABLED',
    message:
      'Your agent is not awake on this service yet — starting one is not open here.',
  },
};

const AWAY = {
  ok: false,
  code: 'OWNER_SESSION_NOT_OPEN',
  message: 'This service cannot start your agent yet. Nothing was changed.',
};

const seedSetup = (patch: Record<string, unknown> = {}) => {
  window.localStorage.setItem(
    'fiddy.setup',
    JSON.stringify({
      agentName: 'Flo',
      brain: 'fiddy',
      channels: { farcaster: true },
      completedAt: Date.now(),
      ...patch,
    }),
  );
};

const paired = (baseUrl = 'https://fiddy.fun') => {
  agentSession.session = { baseUrl, token: 'owner-session-token-1234' };
};

/** A return to the tab, the way the browser reports one. */
const comeBack = () => {
  fireEvent(window, new Event('focus'));
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installFakeStorage();
  window.localStorage.clear();
  window.sessionStorage.clear();
  agentSession.session = null;
  agentSession.pair.mockClear();
  listAgents
    .mockReset()
    .mockResolvedValue([{ id: 'a1', name: 'Flo', status: 'running' }]);
  fetchHatchQuote
    .mockReset()
    .mockResolvedValue({ hatchEnabled: false, certificate: null });
  fetchHermesCatalog
    .mockReset()
    .mockResolvedValue({ skills: 101_246, plugins: 40, examples: [] });
  fetchServiceHealth.mockReset().mockResolvedValue({ mode: 'demo' });
  probeAgentService
    .mockReset()
    .mockResolvedValue({ reachable: true, mode: 'demo' });
  fetchMock = vi.fn(async () => jsonResponse(OPEN_REPLY));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the agent surface asks the service again', () => {
  it('shows the agent that appeared while the tab was open', async () => {
    paired();
    listAgents
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'a1', name: 'Flo', status: 'running' }]);

    render(<AgentPage />);

    expect(
      await screen.findByText('No agent on this service yet'),
    ).toBeTruthy();
    expect(listAgents).toHaveBeenCalledTimes(1);

    comeBack();

    expect(await screen.findByText('Chat')).toBeTruthy();
    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('No agent on this service yet')).toBeNull();
  });

  it('reads the service again when the owner presses "Check again"', async () => {
    paired();
    listAgents
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'a1', name: 'Flo', status: 'running' }]);

    render(<AgentPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

    expect(await screen.findByText('Chat')).toBeTruthy();
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('asks for the owner session again when the last ask failed for a reason a retry can change', async () => {
    seedSetup();
    window.sessionStorage.setItem('fiddy.siwf.proof', JSON.stringify(PROOF));
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(AWAY, 503))
      .mockResolvedValueOnce(jsonResponse(OPEN_REPLY));
    vi.stubGlobal('fetch', fetchMock);

    render(<AgentPage />);

    // The service's own sentence, once — and no session, so nothing paired.
    expect(
      await screen.findByText(
        'This service cannot start your agent yet. Nothing was changed.',
      ),
    ).toBeTruthy();
    expect(agentSession.pair).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    comeBack();

    await waitFor(() => {
      expect(agentSession.pair).toHaveBeenCalledTimes(1);
    });
    const asks = () =>
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith('/api/fiddy/owner-session'),
      ).length;
    expect(asks()).toBe(2);
    // The proof was spent by the answer that worked, and only by that one.
    expect(window.sessionStorage.getItem('fiddy.siwf.proof')).toBeNull();
  });

  it('does not ask again when the failure was the missing proof', async () => {
    seedSetup();

    render(<AgentPage />);

    expect(await screen.findByText(/one more sign-in/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    comeBack();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/one more sign-in/)).toBeTruthy();
  });

  it('makes one new reading per return, not a loop', async () => {
    seedSetup();
    window.sessionStorage.setItem('fiddy.siwf.proof', JSON.stringify(PROOF));
    fetchMock = vi.fn(async () => jsonResponse(AWAY, 503));
    vi.stubGlobal('fetch', fetchMock);

    render(<AgentPage />);

    await screen.findByText(
      'This service cannot start your agent yet. Nothing was changed.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Two returns inside the rate-limit window are one reading: a surface that
    // asked on every event would hammer the service from a single alt-tab.
    comeBack();
    comeBack();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // And a failure does not restart itself: nothing more is asked until the
    // owner returns again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
