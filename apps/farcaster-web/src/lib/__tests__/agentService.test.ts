// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentServiceError,
  type AgentServiceSession,
  applyBrain,
  chatWithAgent,
  connectChannel,
  fetchHatchQuote,
  fetchHermesCatalog,
  isUnavailable,
  isValidServiceToken,
  listAgents,
  listChannels,
  normaliseServiceUrl,
  probeBrain,
} from '~/lib/agentService';

const session: AgentServiceSession = {
  baseUrl: 'https://agents.example.com',
  token: 'session-token-1234',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normaliseServiceUrl', () => {
  it('accepts a bare https origin', () => {
    expect(normaliseServiceUrl('https://agents.example.com')).toBe(
      'https://agents.example.com',
    );
  });

  it('refuses anything it would have to "fix"', () => {
    // Repairing these silently would point the client at a host the owner did
    // not choose — a trailing path, a port, credentials, or plain http.
    expect(normaliseServiceUrl('https://agents.example.com/api')).toBeNull();
    expect(normaliseServiceUrl('https://agents.example.com:8443')).toBeNull();
    expect(
      normaliseServiceUrl('https://user:pass@agents.example.com'),
    ).toBeNull();
    expect(normaliseServiceUrl('http://agents.example.com')).toBeNull();
    expect(normaliseServiceUrl('agents.example.com')).toBeNull();
    expect(normaliseServiceUrl('   ')).toBeNull();
  });
});

describe('isValidServiceToken', () => {
  it('takes an opaque single-line token', () => {
    expect(isValidServiceToken('abc12345')).toBe(true);
  });

  it('refuses short, multi-line, or padded tokens', () => {
    expect(isValidServiceToken('short')).toBe(false);
    expect(isValidServiceToken('two words here')).toBe(false);
    expect(isValidServiceToken('a'.repeat(5000))).toBe(false);
  });
});

describe('listAgents', () => {
  it('reads the owners agents and drops rows without an id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: [
          { id: 'a1', name: 'Scout', status: 'running', template: 'hermes' },
          { name: 'no id' },
          null,
        ],
      }),
    );

    const agents = await listAgents(
      session,
      fetchImpl as unknown as typeof fetch,
    );

    expect(agents).toEqual([
      {
        id: 'a1',
        name: 'Scout',
        status: 'running',
        template: 'hermes',
        url: undefined,
        created: undefined,
      },
    ]);
  });

  it('sends the session token as a bearer token and nothing else', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: [] }));

    await listAgents(session, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://agents.example.com/api/agents/instances');
    expect(init.headers.authorization).toBe('Bearer session-token-1234');
    // The whole point of the module: no provider credential ever rides along.
    expect(Object.keys(init.headers).sort()).toEqual([
      'accept',
      'authorization',
    ]);
  });
});

describe('chatWithAgent', () => {
  it('returns the agents reply', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { output_text: 'Done: 3 drafts.' } }),
    );

    await expect(
      chatWithAgent(
        session,
        'a1',
        ' read my mentions ',
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe('Done: 3 drafts.');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe('https://agents.example.com/api/agents/instances/a1/chat');
    expect(JSON.parse(init.body)).toEqual({ message: 'read my mentions' });
  });

  it('refuses an empty message without calling the service', async () => {
    const fetchImpl = vi.fn();
    await expect(
      chatWithAgent(session, 'a1', '   ', fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AgentServiceError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a service error code and keeps the friendly message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, code: 'CHAT_FAILED' }, 502),
    );

    await expect(
      chatWithAgent(session, 'a1', 'hi', fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'CHAT_FAILED', status: 502 });
  });
});

describe('listChannels and connectChannel', () => {
  it('lists toolkits with their connections', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        toolkits: [{ slug: 'farcaster', name: 'Farcaster' }, { slug: '' }],
        connections: [
          {
            id: 'c1',
            toolkitSlug: 'farcaster',
            toolkitName: 'Farcaster',
            status: 'CONNECTED',
          },
        ],
      }),
    );

    const result = await listChannels(
      session,
      'a1',
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.toolkits).toEqual([
      { slug: 'farcaster', name: 'Farcaster', description: undefined },
    ]);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].status).toBe('CONNECTED');
  });

  it('returns the URL the owner finishes the connection on', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        redirectUrl: 'https://accounts.example.com/oauth',
      }),
    );

    await expect(
      connectChannel(
        session,
        'a1',
        'discord',
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe('https://accounts.example.com/oauth');
  });

  it('treats a missing redirect as a failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));

    await expect(
      connectChannel(
        session,
        'a1',
        'discord',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'CHANNEL_CONNECT_FAILED' });
  });
});

describe('fetchHatchQuote', () => {
  it('reads the certificate when hatching is offered', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        hatchEnabled: true,
        certificate: { template: 'hermes', fees: { cribMonthlyCents: 400 } },
      }),
    );

    const quote = await fetchHatchQuote(
      session,
      fetchImpl as unknown as typeof fetch,
    );

    expect(quote.hatchEnabled).toBe(true);
    expect(quote.certificate?.fees?.cribMonthlyCents).toBe(400);
  });

  it('treats a 404 as "not offered here", not as a crash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    let caught: unknown;
    try {
      await fetchHatchQuote(session, fetchImpl as unknown as typeof fetch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentServiceError);
    expect(isUnavailable(caught)).toBe(true);
  });
});

describe('fetchHermesCatalog', () => {
  it('is anonymous: the public catalog needs no token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        items: [{ name: 'songwriting', description: 'Write songs' }],
        counts: { skills: 101246, plugins: 703 },
      }),
    );

    const catalog = await fetchHermesCatalog(
      fetchImpl as unknown as typeof fetch,
    );

    expect(catalog.skills).toBe(101246);
    expect(catalog.plugins).toBe(703);
    expect(catalog.examples[0].name).toBe('songwriting');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.authorization).toBeUndefined();
  });
});

describe('probeBrain', () => {
  it('sends the choice to the service and carries no token when nobody is paired', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        status: 'ok',
        code: 'BRAIN_OK',
        models: ['gpt-one', 'gpt-two', 42],
      }),
    );

    const probe = await probeBrain(
      null,
      {
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-one',
        key: 'sk-0123456789abcdef',
      },
      fetchImpl as unknown as typeof fetch,
    );

    expect(probe).toEqual({
      ok: true,
      status: 'ok',
      code: 'BRAIN_OK',
      models: ['gpt-one', 'gpt-two'],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    // Signed out, the check goes to the default service with no credential of
    // ours attached: the owner's key is the only one in the request.
    expect(url).toBe('https://fiddy.fun/api/agents/brains/probe');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers).sort()).toEqual([
      'accept',
      'content-type',
    ]);
    expect(JSON.parse(init.body)).toMatchObject({
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-one',
      key: 'sk-0123456789abcdef',
    });
  });

  it('reports a refusal as a code the surface can put into words', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: false,
        status: 'key_refused',
        code: 'BRAIN_KEY_REFUSED',
        models: [],
      }),
    );
    const probe = await probeBrain(
      session,
      { kind: 'preset', presetId: 'openai', model: 'gpt-one', key: 'sk-wrong' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(probe).toMatchObject({
      ok: false,
      status: 'key_refused',
      code: 'BRAIN_KEY_REFUSED',
    });
  });
});

describe('applyBrain', () => {
  it("changes the brain on the owner's own agent and reads nothing else back", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        readback: { provider: 'custom:brain', model: 'my-model' },
      }),
    );

    const result = await applyBrain(
      session,
      'ab12cd34ef',
      {
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        model: 'my-model',
        key: 'sk-0123456789abcdef',
      },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.changed).toBe(true);
    expect(result.readback).toMatchObject({ model: 'my-model' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(
      'https://agents.example.com/api/agents/instances/ab12cd34ef/brain',
    );
    expect(init.method).toBe('PUT');
    expect(init.headers.authorization).toBe('Bearer session-token-1234');
    expect(JSON.parse(init.body)).toEqual({
      brain: {
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        model: 'my-model',
        key: 'sk-0123456789abcdef',
      },
    });
  });
});
