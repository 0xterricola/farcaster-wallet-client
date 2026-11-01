// @vitest-environment jsdom
/**
 * The agent surface, end to end within the client: hatch card, pairing, and a
 * live agent's three tabs. The agent service is mocked at the module boundary —
 * what is under test is the client's own behaviour: which state renders, what
 * the schedule request says, and that a channel needs an approval click first.
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

const chatWithAgent = vi.fn();
const connectChannel = vi.fn();
const listAgents = vi.fn();
const listChannels = vi.fn();
const fetchHatchQuote = vi.fn();
const fetchHermesCatalog = vi.fn();
const fetchServiceHealth = vi.fn();
const probeAgentService = vi.fn();

const { AgentServiceError } =
  await vi.importActual<typeof import('~/lib/agentService')>(
    '~/lib/agentService',
  );

vi.mock('~/lib/agentService', async () => {
  const actual =
    await vi.importActual<typeof import('~/lib/agentService')>(
      '~/lib/agentService',
    );
  return {
    ...actual,
    chatWithAgent: (...args: unknown[]) => chatWithAgent(...args),
    connectChannel: (...args: unknown[]) => connectChannel(...args),
    listAgents: (...args: unknown[]) => listAgents(...args),
    listChannels: (...args: unknown[]) => listChannels(...args),
    fetchHatchQuote: (...args: unknown[]) => fetchHatchQuote(...args),
    fetchHermesCatalog: (...args: unknown[]) => fetchHermesCatalog(...args),
    fetchServiceHealth: (...args: unknown[]) => fetchServiceHealth(...args),
    probeAgentService: (...args: unknown[]) => probeAgentService(...args),
  };
});

const agentSession = {
  session: null as null | { baseUrl: string; token: string },
  pair: vi.fn(),
  forget: vi.fn(),
};

vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: agentSession.session ? 'paired' : 'unpaired',
    session: agentSession.session,
    pair: agentSession.pair,
    forget: agentSession.forget,
  }),
}));

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/utils/errorUtils', () => ({ trackError: () => undefined }));

// The surface reads the signed-in account to decide whether it can be paired
// automatically; these tests are about the states either side of that, so the
// account is signed out (`fid: 0`). See agentAutopairLanding.test.tsx.
vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => ({ fid: 0 }),
}));

const { AgentPage } = await import('~/pages/agent/AgentPage');

const scheduleStore = new Map<string, unknown>();

vi.mock('~/lib/agentSchedules', async () => {
  const actual = await vi.importActual<typeof import('~/lib/agentSchedules')>(
    '~/lib/agentSchedules',
  );
  return {
    ...actual,
    loadSchedules: async (agentId: string) => scheduleStore.get(agentId) ?? [],
    saveSchedules: async (agentId: string, value: unknown) => {
      scheduleStore.set(agentId, value);
    },
  };
});

beforeEach(() => {
  scheduleStore.clear();
  agentSession.session = null;
  agentSession.pair.mockClear();
  chatWithAgent.mockReset();
  connectChannel.mockReset();
  listAgents.mockReset();
  listChannels.mockReset();
  fetchHatchQuote.mockReset();
  fetchHermesCatalog.mockReset();

  fetchHermesCatalog.mockResolvedValue({
    skills: 101246,
    plugins: 703,
    examples: [],
  });
  listAgents.mockResolvedValue([
    { id: 'a1', name: 'Scout', status: 'running', template: 'hermes' },
  ]);
  listChannels.mockResolvedValue({
    toolkits: [{ slug: 'farcaster', name: 'Farcaster' }],
    connections: [],
  });
  fetchHatchQuote.mockRejectedValue(new AgentServiceError('HTTP_404', 404));
  fetchServiceHealth.mockResolvedValue({ mode: 'demo' });
  probeAgentService.mockResolvedValue({ reachable: true, mode: 'demo' });
  chatWithAgent.mockResolvedValue('Scheduled for 09:00 every day.');
  connectChannel.mockResolvedValue('https://accounts.example.com/oauth');
});

afterEach(cleanup);

/**
 * The agent surface carries the two pivot entries as real links ("Add a brain",
 * "Connect apps"). This renders each one as an anchor whose href is the real
 * route path — read from the app's own route table, not hard-coded — instead of
 * mounting `Link` itself, which needs a router and the app's JSX runtime (this
 * suite has neither). It also means the new test below can be a single test
 * covering both links from a shared helper rather than a second renderer.
 */
vi.mock('~/components/links/Link', async () => {
  const { routes } =
    await vi.importActual<typeof import('~/constants/routes')>(
      '~/constants/routes',
    );
  return {
    Link: ({
      to,
      title,
      children,
      className,
    }: {
      to: keyof typeof routes;
      title?: string;
      children?: React.ReactNode;
      className?: string;
    }) =>
      React.createElement(
        'a',
        { href: routes[to].path, title, className },
        children,
      ),
  };
});

describe('not paired', () => {
  it('offers the hatch action and says honestly that hatching depends on the service', async () => {
    render(<AgentPage />);

    expect(
      await screen.findByText('Your agent, on your accounts'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Hatch your Fiddy · soon' }),
    ).toBeTruthy();
    // Unpaired, the client has asked nothing but /api/health: it must not claim
    // hatching is closed, and it must not claim it is open either.
    expect(
      await screen.findByText(/Hatching is managed by your agent service/),
    ).toBeTruthy();
    // The live catalog receipt is real data, not decoration.
    expect(screen.getByText(/101,246 skills/)).toBeTruthy();
  });

  it('says the service is unreachable rather than offering a dead hatch', async () => {
    probeAgentService.mockResolvedValueOnce({ reachable: false, mode: null });
    render(<AgentPage />);

    expect(
      await screen.findByText(/not answering, so hatching cannot start/),
    ).toBeTruthy();
  });

  it('pairs with a service after validating the address and token', async () => {
    render(<AgentPage />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'I run my own agent service — pair it',
      }),
    );

    const url = screen.getByLabelText(
      'Agent service address',
    ) as HTMLInputElement;
    const token = screen.getByLabelText('Session token') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://agents.example.com' } });
    fireEvent.change(token, { target: { value: 'session-token-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(agentSession.pair).toHaveBeenCalledWith({
        baseUrl: 'https://agents.example.com',
        token: 'session-token-1234',
      });
    });
  });

  it('refuses an address it would have to repair', async () => {
    render(<AgentPage />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'I run my own agent service — pair it',
      }),
    );

    const url = screen.getByLabelText(
      'Agent service address',
    ) as HTMLInputElement;
    const token = screen.getByLabelText('Session token') as HTMLInputElement;
    fireEvent.change(url, {
      target: { value: 'https://agents.example.com/api' },
    });
    fireEvent.change(token, { target: { value: 'session-token-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(screen.getByText(/no path, no port, no credentials/)).toBeTruthy();
    expect(agentSession.pair).not.toHaveBeenCalled();
  });
});

describe('paired with a running agent', () => {
  beforeEach(() => {
    agentSession.session = {
      baseUrl: 'https://agents.example.com',
      token: 'session-token-1234',
    };
  });

  it('shows the agent, its status and the service it runs on', async () => {
    render(<AgentPage />);

    expect(await screen.findByRole('heading', { name: 'Scout' })).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText(/runs on agents\.example\.com/)).toBeTruthy();
  });

  it('sends a plain-English schedule to the agent and keeps the request', async () => {
    render(<AgentPage />);
    fireEvent.click(
      await screen.findByRole('tab', { name: 'Scheduled tasks' }),
    );

    fireEvent.change(
      screen.getByPlaceholderText(/read my mentions and draft replies/),
      { target: { value: 'Every morning at 9, read my mentions' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));

    await waitFor(() => {
      expect(chatWithAgent).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://agents.example.com' }),
        'a1',
        'Schedule this recurring task for me, then confirm it in one line: Every morning at 9, read my mentions',
      );
    });

    // The record keeps the owner's words and the agent's answer, and says the
    // request was sent rather than claiming a task is running.
    expect(
      await screen.findByText('Every morning at 9, read my mentions'),
    ).toBeTruthy();
    expect(await screen.findByText('agent answered')).toBeTruthy();
    expect(screen.getByText('Scheduled for 09:00 every day.')).toBeTruthy();
  });

  it('says where a request came from when an app, not the owner, asked', async () => {
    // A `remind` a mini app made through the reader's own approval
    // (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.4): it lands in this same log,
    // with the app's own words and the app's domain on the row, so the log never
    // makes somebody else's words look like the owner's.
    scheduleStore.set('a1', [
      {
        id: 's-app',
        agentId: 'a1',
        prompt: 'remind me at nine every morning',
        domain: 'beep.works',
        state: 'answered',
        createdAt: 1_792_000_000_000,
        reply: 'Done — nine every morning.',
      },
    ]);

    render(<AgentPage />);
    fireEvent.click(
      await screen.findByRole('tab', { name: 'Scheduled tasks' }),
    );

    expect(
      await screen.findByText('remind me at nine every morning'),
    ).toBeTruthy();
    expect(screen.getByText(/from beep\.works/)).toBeTruthy();
    expect(screen.getByText('agent answered')).toBeTruthy();
  });

  it('requires an approval click before a channel can be connected', async () => {
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Channels' }));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve connection' }),
    );
    expect(connectChannel).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Finish on agent side →' }),
    );
    await waitFor(() => {
      expect(connectChannel).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://agents.example.com' }),
        'a1',
        'farcaster',
      );
    });
  });

  it('says which Hermes channels this service has not exposed yet', async () => {
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Channels' }));

    expect(await screen.findByText('iMessage · soon')).toBeTruthy();
    expect(screen.getByText('WhatsApp · soon')).toBeTruthy();
  });

  it('offers the two pivot surfaces as real links, with the choices that were made', async () => {
    // The agent screen is where "Add a brain" and "Connect apps" live after
    // onboarding, so both have to be reachable from it and both have to show
    // the state the setup file holds rather than a generic label.
    render(<AgentPage />);

    const brains = await screen.findByRole('link', { name: /Add a brain/ });
    const apps = screen.getByRole('link', { name: /Connect apps/ });

    expect(brains.getAttribute('href')).toBe('/~/agent/brains');
    expect(apps.getAttribute('href')).toBe('/~/agent/apps');
    // Nothing has been chosen in this test, so the built-in brain and the
    // default single permission are what the tiles must own up to.
    expect(screen.getByText('Fiddy, built in')).toBeTruthy();
    expect(screen.getByText(/1 on — the list you choose from/)).toBeTruthy();
  });
});
