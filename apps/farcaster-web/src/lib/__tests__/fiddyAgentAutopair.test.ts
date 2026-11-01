// @vitest-environment jsdom
/**
 * Turning your agent on without a URL and a token.
 *
 * What is under test is the decision (which setup may be paired automatically)
 * and the reading of the service's answer (which failures are sentences, and
 * which successful-looking answers are still unusable). The signature and the
 * FID are the service's business; the client's business is never inventing
 * either.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_SERVICE_URL } from '~/lib/agentService';
import {
  AUTOPAIR_SENTENCES,
  autopairBrain,
  openOwnerSession,
  ownerSessionUrl,
  shouldAutopair,
} from '~/lib/fiddyAgentAutopair';
import { defaultFiddySetup, type FiddySetup } from '~/lib/fiddySetup';

const setupWith = (patch: Partial<FiddySetup> = {}): FiddySetup => ({
  ...defaultFiddySetup(),
  agentName: 'Flo',
  ...patch,
});

const proof = {
  fid: 4242,
  message: 'fiddy.fun wants you to sign in with your Ethereum account: 0x…',
  signature: `0x${'a'.repeat(130)}`,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const reply = (patch: Record<string, unknown> = {}) => {
  const { session, ...rest } = patch as {
    session?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ok: true,
    agent: { name: 'Flo', brain: { kind: 'default' } },
    provisioning: {
      open: false,
      code: 'HATCH_NOT_ENABLED',
      message:
        'Your agent is not awake on this service yet — starting one is not open here.',
    },
    ...rest,
    session:
      session === null
        ? null
        : {
            token: 'owner-session-token-1234',
            expiresAt: Date.now() + 1_000_000,
            fid: 4242,
            subject: 'farcaster:4242',
            name: 'Flo',
            baseUrl: 'https://agents.example.com',
            ...session,
          },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('which setups are paired automatically', () => {
  it('pairs the brains Fiddy provides, for a signed-in account', () => {
    expect(
      shouldAutopair({ setup: setupWith({ brain: 'fiddy' }), fid: 4242 }),
    ).toBe(true);
    expect(
      shouldAutopair({ setup: setupWith({ brain: 'surp' }), fid: 4242 }),
    ).toBe(true);
  });

  it.each([
    ['a brain the owner brought themselves', setupWith({ brain: 'openai' })],
    ['a custom service', setupWith({ brain: 'custom' })],
    ['another preset', setupWith({ brain: 'anthropic' })],
  ])('leaves %s to the pairing form', (_label, setup) => {
    expect(shouldAutopair({ setup, fid: 4242 })).toBe(false);
  });

  it('does nothing when nobody is signed in', () => {
    for (const fid of [undefined, null, 0]) {
      expect(shouldAutopair({ setup: setupWith(), fid })).toBe(false);
    }
  });

  it('describes the chosen brain the way the route takes it', () => {
    expect(autopairBrain(setupWith({ brain: 'fiddy' }))).toEqual({
      kind: 'default',
    });
    expect(autopairBrain(setupWith({ brain: 'surp' }))).toEqual({
      kind: 'preset',
      presetId: 'surp',
    });
  });
});

describe('where the session is asked for', () => {
  it('uses this origin by default, so the browser never makes a cross-origin call', () => {
    expect(ownerSessionUrl({}, 'https://fiddy.fun')).toBe(
      'https://fiddy.fun/api/fiddy/owner-session',
    );
  });

  it('prefers an address the deployment configured', () => {
    expect(
      ownerSessionUrl(
        { VITE_FIDDY_OWNER_SESSION_URL: 'https://staging.example/api/owner' },
        'https://fiddy.fun',
      ),
    ).toBe('https://staging.example/api/owner');
  });
});

describe('reading the service’s answer', () => {
  const ask = async (
    response: Response | Error,
    { proof: given = proof, setup = setupWith() } = {},
  ) => {
    const fetchImpl = vi.fn(async () => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
    return openOwnerSession({
      proof: given,
      setup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      url: 'https://fiddy.fun/api/fiddy/owner-session',
    });
  };

  it('returns the session, the name the service stored, and its provisioning state', async () => {
    const outcome = await ask(jsonResponse(reply()));
    expect(outcome).toMatchObject({
      ok: true,
      session: {
        baseUrl: 'https://agents.example.com',
        token: 'owner-session-token-1234',
        name: 'Flo',
      },
      provisioning: { open: false, code: 'HATCH_NOT_ENABLED' },
    });
  });

  it('sends the proof and the chosen brain, and nothing else', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(reply()));
    await openOwnerSession({
      proof,
      setup: setupWith({ brain: 'surp' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      url: 'https://fiddy.fun/api/fiddy/owner-session',
    });
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body ?? '{}'),
    ) as {
      proof: unknown;
      agent: { name: string; brain: unknown };
    };
    expect(body.proof).toEqual(proof);
    expect(body.agent).toEqual({
      name: 'Flo',
      brain: { kind: 'preset', presetId: 'surp' },
    });
  });

  it('falls back to the built-in service when the answer names no usable address', async () => {
    const outcome = await ask(
      jsonResponse(reply({ session: { baseUrl: 'http://localhost:3000' } })),
    );
    expect(outcome).toMatchObject({
      ok: true,
      session: { baseUrl: DEFAULT_AGENT_SERVICE_URL },
    });
  });

  it.each([
    ['no session at all', reply({ session: null })],
    ['a token too short to be one', reply({ session: { token: 'tiny' } })],
    [
      'a token with whitespace',
      reply({ session: { token: 'a token with spaces' } }),
    ],
  ])('refuses %s as malformed rather than pairing it', async (_label, body) => {
    const outcome = await ask(jsonResponse(body));
    expect(outcome).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(outcome.ok === false && outcome.sentence).toBe(
      AUTOPAIR_SENTENCES.MALFORMED,
    );
  });

  it('shows the service’s own sentence for a refusal', async () => {
    const sentence =
      'Farcaster’s own registry could not be reached, so your agent was not started.';
    const outcome = await ask(
      jsonResponse(
        { ok: false, code: 'IDENTITY_CHAIN_UNREACHABLE', message: sentence },
        503,
      ),
    );
    expect(outcome).toMatchObject({
      ok: false,
      code: 'IDENTITY_CHAIN_UNREACHABLE',
    });
    expect(outcome.ok === false && outcome.sentence).toBe(sentence);
  });

  it('falls back to its own sentence when the refusal carries none', async () => {
    const outcome = await ask(
      jsonResponse({ ok: false, code: 'OWNER_SESSION_NOT_OPEN' }, 503),
    );
    expect(outcome.ok === false && outcome.sentence).toBe(
      AUTOPAIR_SENTENCES.OWNER_SESSION_NOT_OPEN,
    );
  });

  it('says nothing was changed when the service cannot be reached at all', async () => {
    const outcome = await ask(new Error('Failed to fetch'));
    expect(outcome).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect(outcome.ok === false && outcome.sentence).toMatch(
      /Nothing was changed/,
    );
  });

  it('treats a body it cannot read as malformed', async () => {
    const outcome = await ask({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    expect(outcome).toMatchObject({ ok: false, code: 'MALFORMED' });
  });

  it('asks for nothing at all without a proof to prove with', async () => {
    const outcome = await ask(jsonResponse(reply()), { proof: null as never });
    expect(outcome).toMatchObject({ ok: false, code: 'NO_PROOF' });
    expect(outcome.ok === false && outcome.sentence).toMatch(
      /one more sign-in/,
    );
  });
});
