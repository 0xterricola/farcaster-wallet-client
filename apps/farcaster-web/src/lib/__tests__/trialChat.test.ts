// @vitest-environment jsdom
/**
 * The trial message, measured where it is decided.
 *
 * Four things have to be true and each of them is a check: one message per
 * browser session and no more; a real reply is the only thing that renders as a
 * reply; a service that says the trial is not open produces the server's own
 * sentence and NEVER a fabricated answer; and the exchange is left somewhere the
 * signed-in chat can find it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installFakeStorage,
  newBrowserSession,
} from '~/lib/__tests__/fakeStorage';
import { defaultFiddySetup, saveFiddySetup } from '~/lib/fiddySetup';
import {
  askTrialAgent,
  loadTrialExchange,
  loadTrialState,
  TRIAL_CHAT_PATH,
  TRIAL_STORAGE_KEY,
  TRIAL_TURNS_PER_SESSION,
  trialBrain,
  trialTurnsRemaining,
} from '~/lib/trialChat';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the trial message', () => {
  it('sends one message to the route on this origin and keeps the real reply', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, reply: 'I read your mentions.', note: null }),
      );

    const exchange = await askTrialAgent({
      message: '  Watch my mentions  ',
      agentName: 'Momo',
      setup: defaultFiddySetup(),
      fetchImpl,
    });

    expect(exchange.reply).toBe('I read your mentions.');
    expect(exchange.message).toBe('Watch my mentions');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRIAL_CHAT_PATH);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      message: 'Watch my mentions',
      agentName: 'Momo',
    });
  });

  it('is one message per browser session, and the next press is refused', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, reply: 'Here.' }));

    await askTrialAgent({
      message: 'hi',
      agentName: 'Momo',
      setup: defaultFiddySetup(),
      fetchImpl,
    });

    expect(trialTurnsRemaining()).toBe(0);
    await expect(
      askTrialAgent({
        message: 'again',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives a new browser session its one message back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, reply: 'Here.' }));
    await askTrialAgent({
      message: 'hi',
      agentName: 'Momo',
      setup: defaultFiddySetup(),
      fetchImpl,
    });
    newBrowserSession();
    expect(trialTurnsRemaining()).toBe(TRIAL_TURNS_PER_SESSION);
  });

  it('shows the service’s own sentence when the trial is not open, and invents nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          code: 'TRIAL_NOT_OPEN',
          message:
            'The live trial is not open on this service yet, sign in instead.',
        },
        503,
      ),
    );

    await expect(
      askTrialAgent({
        message: 'hi',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: 'REFUSED',
      ownerLine:
        'The live trial is not open on this service yet, sign in instead.',
    });

    // Nothing was written: there is no reply to remember.
    expect(loadTrialExchange()).toBeNull();
    expect(loadTrialState().turns).toBe(0);
  });

  it('treats a page that answers with HTML as "not open", not as a crash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(
      askTrialAgent({
        message: 'hi',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    expect(loadTrialExchange()).toBeNull();
  });

  it('does not render an empty answer as a reply', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, reply: '   ' }));
    await expect(
      askTrialAgent({
        message: 'hi',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    // A refused turn does not spend the visitor's message.
    expect(trialTurnsRemaining()).toBe(1);
  });

  it('refuses an empty message before it spends anything', async () => {
    const fetchImpl = vi.fn();
    await expect(
      askTrialAgent({
        message: '   ',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'REFUSED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('survives a network refusal with a sentence, not a stack trace', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      askTrialAgent({
        message: 'hi',
        agentName: 'Momo',
        setup: defaultFiddySetup(),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });

  it('leaves the exchange where the signed-in chat will look for it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, reply: 'Standing by.' }));
    await askTrialAgent({
      message: 'Draft a morning intro cast',
      agentName: 'Pip',
      setup: defaultFiddySetup(),
      fetchImpl,
    });

    const stored = loadTrialExchange();
    expect(stored).toMatchObject({
      agentName: 'Pip',
      message: 'Draft a morning intro cast',
      reply: 'Standing by.',
      note: null,
    });
    expect(
      JSON.parse(window.localStorage.getItem(TRIAL_STORAGE_KEY) ?? '{}'),
    ).toMatchObject({
      reply: 'Standing by.',
    });
  });
});

describe('the brain the trial hands over', () => {
  it('is left to the service for the built-in brain', () => {
    expect(trialBrain(defaultFiddySetup())).toBeUndefined();
  });

  it('carries the Surp key only when step 1 actually left one', () => {
    const setup = { ...defaultFiddySetup(), brain: 'surp' as const };
    expect(trialBrain(setup)).toBeUndefined();

    window.localStorage.setItem(
      'fiddy.surp.key',
      JSON.stringify({
        key: 'sk-surp-abcdefghijklmnopqrstuvwxyz',
        createdAt: Date.now(),
      }),
    );
    expect(trialBrain(setup)).toEqual({
      kind: 'preset',
      presetId: 'surp',
      model: 'surp/chat',
      key: 'sk-surp-abcdefghijklmnopqrstuvwxyz',
    });
  });

  it('is not sent for a brain the browser cannot hand over', () => {
    for (const brain of ['openai', 'anthropic', 'nous', 'custom'] as const) {
      saveFiddySetup({ brain });
      expect(trialBrain({ ...defaultFiddySetup(), brain })).toBeUndefined();
    }
  });
});
