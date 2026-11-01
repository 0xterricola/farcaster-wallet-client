// @vitest-environment jsdom
/**
 * What a signed-in owner actually sees on `/~/agent`.
 *
 * The bug this file pins down: somebody who signed in and picked the built-in
 * brain was shown "Hatch your Fiddy · soon" and a form asking for an agent
 * service address and a session token. Now the service is asked for their owner
 * session on arrival, they land in Chat under the name they chose, and the
 * conversation they already had before signing in is still there.
 *
 * When starting an agent is closed on that service, the header says so in one
 * sentence — and the URL field does not exist until they ask for it.
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
    // Re-read on every render, so a pair() inside the page is visible to it.
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

const TRIAL_EXCHANGE = {
  agentName: 'Flo',
  message: 'What can you do for me on Farcaster?',
  reply: 'I read your mentions and draft replies. Shall I start?',
  note: 'That answer came from Fiddy’s own brain.',
  at: 1_792_600_000_000,
};

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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // This repo's jsdom exposes no storage of its own; the setup file, the trial
  // exchange and the sign-in proof all live in these two maps.
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

const trialSeeded = () =>
  window.localStorage.setItem('fiddy.trial', JSON.stringify(TRIAL_EXCHANGE));

describe('a signed-in owner with the built-in brain', () => {
  it('asks for the owner session, lands in Chat, and keeps the conversation they already had', async () => {
    seedSetup();
    trialSeeded();
    window.sessionStorage.setItem('fiddy.siwf.proof', JSON.stringify(PROOF));

    render(<AgentPage />);

    // No form, no address field, no token field — at any point.
    expect(screen.queryByLabelText('Session token')).toBeNull();
    expect(document.querySelector('input[type="url"]')).toBeNull();

    await waitFor(() => {
      expect(agentSession.pair).toHaveBeenCalledWith({
        baseUrl: expect.stringContaining('https://'),
        token: 'owner-session-token-1234',
      });
    });

    // The proof was asked for once, with the identity and the name the owner chose.
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(String(url)).toMatch(/\/api\/fiddy\/owner-session$/);
    expect(JSON.parse(init.body)).toMatchObject({
      proof: { fid: 4242 },
      agent: { name: 'Flo', brain: { kind: 'default' } },
    });

    // The paired surface, on the Chat tab, with the trial exchange at the top.
    expect(await screen.findByText('Chat')).toBeTruthy();
    expect(await screen.findByText(TRIAL_EXCHANGE.message)).toBeTruthy();
    expect(await screen.findByText(TRIAL_EXCHANGE.reply)).toBeTruthy();
    expect(screen.getByPlaceholderText('Message your agent…')).toBeTruthy();

    // The exchange is adopted once, not re-seeded on a later visit.
    expect(window.localStorage.getItem('fiddy.trial')).toBeNull();
    // And the proof is spent.
    expect(window.sessionStorage.getItem('fiddy.siwf.proof')).toBeNull();
  });

  it('shows the service’s own sentence, not a form, when starting an agent is closed', async () => {
    seedSetup();
    trialSeeded();
    window.sessionStorage.setItem('fiddy.siwf.proof', JSON.stringify(PROOF));
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        {
          ok: false,
          code: 'OWNER_SESSION_NOT_OPEN',
          message:
            'This service cannot start your agent yet. Nothing was changed.',
        },
        503,
      ),
    );

    render(<AgentPage />);

    // Said, in the header, in one sentence — with the name they chose.
    expect(
      await screen.findByText(
        'This service cannot start your agent yet. Nothing was changed.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Flo' })).toBeTruthy();
    expect(screen.getByText('Not awake yet')).toBeTruthy();

    // Still a chat: what they already said is on screen, and there is no URL
    // field or token field anywhere.
    expect(screen.getByText(TRIAL_EXCHANGE.message)).toBeTruthy();
    expect(screen.queryByLabelText('Session token')).toBeNull();
    expect(document.querySelector('input[type="url"]')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Hatch your Fiddy · soon' }),
    ).toBeNull();
    expect(agentSession.pair).not.toHaveBeenCalled();

    // The pairing form is one disclosure away, for a self-hoster.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'I run my own agent service — pair it',
      }),
    );
    expect(await screen.findByLabelText('Session token')).toBeTruthy();
  });

  it('says one more sign-in is needed when there is no proof left to spend', async () => {
    seedSetup();

    render(<AgentPage />);

    expect(await screen.findByText(/one more sign-in/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="url"]')).toBeNull();
  });

  it('leaves a brain the owner brought themselves to the pairing form', async () => {
    seedSetup({ brain: 'openai' });
    window.sessionStorage.setItem('fiddy.siwf.proof', JSON.stringify(PROOF));

    render(<AgentPage />);

    expect(
      await screen.findByText('Your agent, on your accounts'),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentSession.pair).not.toHaveBeenCalled();
  });
});
