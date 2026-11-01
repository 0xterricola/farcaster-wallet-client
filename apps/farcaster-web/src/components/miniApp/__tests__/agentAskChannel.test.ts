/**
 * The agent ask channel: what a mini app may ask this reader's agent for, and
 * every honest answer when it may not.
 *
 * These tests hold the two properties the channel exists for, both absences:
 * a message that is not from this iframe's own window object *and* its launched
 * origin gets no answer at all (a reply is itself an oracle), and nothing that
 * comes in is ever echoed back. Everything from the frame is refused by name, in
 * the order `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §6 fixes, and nothing in this
 * slice reaches the agent, the composer or the write seam.
 *
 * The whole file runs in the node environment: the channel is pure and
 * React-free, so a refusal needs no browser to prove.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_ASK_BUDGET,
  AGENT_ASK_CAPABILITY,
  AGENT_ASK_DEDUPE_MS,
  AGENT_ASK_MESSAGE,
  AGENT_ASK_RESULT_MESSAGE,
  AGENT_ASK_SENTENCES,
  AGENT_ASK_VERSION,
  AgentAskAnswer,
  AgentAskDeferral,
  AgentAskEnvelope,
  createAgentAskChannel,
  readAgentAsk,
} from '~/components/miniApp/agentAskChannel';

const FRAME_ORIGIN = 'https://beep.works';
const FRAME_URL = 'https://beep.works/app';
const OTHER_ORIGIN = 'https://ads.example';

/** The iframe's own window object, and one that is not it. */
const FRAME_WINDOW = { role: 'the mini app iframe' };
const NESTED_WINDOW = { role: 'a frame inside the app' };

const webRoot = path.resolve(__dirname, '../../../..');

let clock = 1_000_000;

const ask = (overrides: Record<string, unknown> = {}): unknown => ({
  type: AGENT_ASK_MESSAGE,
  v: AGENT_ASK_VERSION,
  id: 'ask-1',
  ask: 'draft',
  text: 'draft a cast about this',
  ...overrides,
});

const openChannel = (options: { hasPairedSession?: () => boolean } = {}) => {
  const channel = createAgentAskChannel({
    hasPairedSession: options.hasPairedSession ?? (() => true),
    now: () => clock,
  });
  channel.setLaunchedUrl(FRAME_URL);
  return channel;
};

const send = (
  channel: ReturnType<typeof openChannel>,
  data: unknown,
  where: { source?: unknown; origin?: string; frameWindow?: unknown } = {},
): AgentAskAnswer | undefined =>
  channel.handle(
    {
      source: where.source ?? FRAME_WINDOW,
      origin: where.origin ?? FRAME_ORIGIN,
      data,
    },
    where.frameWindow ?? FRAME_WINDOW,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clock = 1_000_000;
});

describe('the pin: only the framed window, only its own origin', () => {
  it('answers an ask that arrives from the iframe itself', () => {
    const answer = send(openChannel(), ask());

    expect(answer).toMatchObject({
      type: AGENT_ASK_RESULT_MESSAGE,
      v: AGENT_ASK_VERSION,
      id: 'ask-1',
      state: 'unavailable',
      message: AGENT_ASK_SENTENCES.unavailable,
    });
  });

  it('refuses a message whose source is another window object', () => {
    // Nothing comes back, not even a refusal: a reply is itself an oracle, and
    // a frame that is not the app must not learn that it was heard.
    expect(
      send(openChannel(), ask(), { source: NESTED_WINDOW }),
    ).toBeUndefined();
  });

  it('refuses a message from another origin, even from this window', () => {
    expect(
      send(openChannel(), ask(), { origin: OTHER_ORIGIN }),
    ).toBeUndefined();
  });

  it('refuses a nested frame inside the app on both checks', () => {
    const channel = openChannel();

    // A nested frame of the app's own origin still is not the app's window.
    expect(
      send(channel, ask(), {
        source: NESTED_WINDOW,
        frameWindow: FRAME_WINDOW,
      }),
    ).toBeUndefined();
    // A nested frame on another origin fails the source check as well.
    expect(
      send(channel, ask(), {
        source: NESTED_WINDOW,
        origin: OTHER_ORIGIN,
        frameWindow: FRAME_WINDOW,
      }),
    ).toBeUndefined();
  });

  it('walks past everything that is not our envelope', () => {
    const channel = openChannel();

    // The window carries comlink, wallet and SDK traffic; none of it is ours to
    // answer, and `invalid` for somebody else's message would be a lie.
    for (const data of [
      undefined,
      null,
      'a string',
      42,
      [],
      { event: 'miniapp_added' },
      { type: 'fiddy:something-else', v: 1, id: 'x' },
    ]) {
      expect(send(channel, data)).toBeUndefined();
    }
  });

  it('answers nobody when no app is framed, or when the URL has no origin', () => {
    const noWindow = createAgentAskChannel({ hasPairedSession: () => true });
    expect(noWindow.currentOrigin()).toBeUndefined();
    expect(send(noWindow, ask())).toBeUndefined();

    const oddUrl = createAgentAskChannel({ hasPairedSession: () => true });
    oddUrl.setLaunchedUrl('not a url');
    expect(oddUrl.currentOrigin()).toBeUndefined();
    expect(send(oddUrl, ask())).toBeUndefined();
  });
});

describe('invalid, and never a diagnosis', () => {
  const malformed: [string, unknown][] = [
    ['no version', ask({ v: undefined })],
    ['a future version', ask({ v: 2 })],
    ['no id', ask({ id: undefined })],
    ['an empty id', ask({ id: '' })],
    ['an id over 64 chars', ask({ id: 'x'.repeat(65) })],
    ['a numeric id', ask({ id: 12 })],
    ['no ask', ask({ ask: undefined })],
    ['an ask we do not have', ask({ ask: 'read-answer' })],
    ['an ask naming a wallet', ask({ ask: 'send-token' })],
    ['no text', ask({ text: undefined })],
    ['an empty text', ask({ text: '' })],
    ['a whitespace-only text', ask({ text: '   \n  ' })],
    ['text over 500 chars', ask({ text: 'x'.repeat(501) })],
    ['a non-string text', ask({ text: { message: 'hi' } })],
    [
      'embeds on a post',
      ask({ ask: 'post', embeds: ['https://example.com/a.png'] }),
    ],
    [
      'embeds on a reminder',
      ask({ ask: 'remind', embeds: ['https://example.com/a.png'] }),
    ],
    [
      'three embeds',
      ask({
        embeds: [
          'https://example.com/a.png',
          'https://example.com/b.png',
          'https://example.com/c.png',
        ],
      }),
    ],
    ['one embed that is not https', ask({ embeds: ['http://x.example'] })],
    ['one embed that is not a URL', ask({ embeds: ['evil.example'] })],
    ['a field we do not have', ask({ wallet: '0xabc' })],
    ['a field naming a recipient', ask({ recipient: 'bc1qxyz', amount: '1' })],
    ['a fid that claims to be the reader', ask({ fid: 191554 })],
  ];

  it.each(malformed)('refuses %s as one wordless invalid', (_label, data) => {
    const answer = send(openChannel(), data);

    expect(answer?.state).toBe('invalid');
    expect(answer?.message).toBe(AGENT_ASK_SENTENCES.invalid);
    // Which field failed is a specification for the next attempt.
    expect(answer?.message).not.toMatch(/\b(id|text|embeds|version|field)\b/i);
  });

  it('answers an unusable id with an empty id rather than going silent', () => {
    const answer = send(openChannel(), ask({ id: 'x'.repeat(65) }));

    expect(answer?.state).toBe('invalid');
    expect(answer?.id).toBe('');
  });
});

describe('the session, the mute, the duplicate window and the budget', () => {
  it('says no_agent when nothing is paired, and stays that way', () => {
    const channel = openChannel({ hasPairedSession: () => false });

    const first = send(channel, ask({ id: 'a' }));
    expect(first).toMatchObject({
      state: 'no_agent',
      message: AGENT_ASK_SENTENCES.no_agent,
    });

    // Six asks in, still the session's answer: `no_agent` is not a ceiling.
    for (let i = 0; i < 6; i += 1) {
      expect(send(channel, ask({ id: `no-agent-${i}` }))?.state).toBe(
        'no_agent',
      );
    }
  });

  it('answers a well-formed ask from a paired session as unavailable', () => {
    const channel = openChannel();

    for (const kind of ['draft', 'post', 'remind'] as const) {
      const answer = send(
        channel,
        ask({ id: `paired-${kind}`, ask: kind, text: `please ${kind}` }),
      );
      expect(answer).toMatchObject({
        state: 'unavailable',
        message: AGENT_ASK_SENTENCES.unavailable,
      });
    }
  });

  it('drops a replayed id without an answer', () => {
    const channel = openChannel();

    expect(send(channel, ask({ id: 'once' }))?.state).toBe('unavailable');
    // The id has been answered; saying anything again would confirm the replay.
    expect(send(channel, ask({ id: 'once' }))).toBeUndefined();
    expect(
      send(channel, ask({ id: 'once', text: 'different' })),
    ).toBeUndefined();
  });

  it('answers an identical ask from the last answer inside 30 s', () => {
    const channel = openChannel();

    const first = send(channel, ask({ id: 'a1' }));
    expect(first?.state).toBe('unavailable');

    // A double-send under a new id: the same answer, and it costs nothing.
    const double = send(channel, ask({ id: 'a2' }));
    expect(double).toMatchObject({ id: 'a2', state: 'unavailable' });

    // Which is why two more distinct asks are still only the third.
    expect(send(channel, ask({ id: 'b', text: 'second' }))?.state).toBe(
      'unavailable',
    );
    expect(send(channel, ask({ id: 'c', text: 'third' }))?.state).toBe(
      'unavailable',
    );

    // At the ceiling, a duplicate of the last ask is still answered from it
    // rather than told it has asked as often as it may.
    expect(send(channel, ask({ id: 'c2', text: 'third' }))?.state).toBe(
      'unavailable',
    );
    // And a genuinely new ask after three of them is the fourth.
    expect(send(channel, ask({ id: 'd', text: 'fourth' }))?.state).toBe(
      'budget',
    );
  });

  it('lets the duplicate window expire, and counts the ask after it', () => {
    const channel = openChannel();

    expect(send(channel, ask({ id: 'a1' }))?.state).toBe('unavailable');
    clock += AGENT_ASK_DEDUPE_MS + 1;

    // Past the window it is a new ask: a fresh answer under the app's own id,
    // and it spends the second of the three.
    const after = send(channel, ask({ id: 'a2' }));
    expect(after).toMatchObject({ id: 'a2', state: 'unavailable' });
    expect(send(channel, ask({ id: 'b', text: 'second' }))?.state).toBe(
      'unavailable',
    );
    expect(send(channel, ask({ id: 'c', text: 'third' }))?.state).toBe(
      'budget',
    );
  });

  it('answers budget once three fresh asks have been used', () => {
    const channel = openChannel();

    for (let i = 0; i < AGENT_ASK_BUDGET; i += 1) {
      const answer = send(channel, ask({ id: `ask-${i}`, text: `ask ${i}` }));
      expect(answer?.state).toBe('unavailable');
    }

    const over = send(channel, ask({ id: 'over', text: 'one more' }));
    expect(over).toMatchObject({
      state: 'budget',
      message: AGENT_ASK_SENTENCES.budget,
    });

    // For the life of the window, and a new id does not help.
    expect(send(channel, ask({ id: 'over-2', text: 'again' }))?.state).toBe(
      'budget',
    );
  });

  it('mutes one origin, and the mute outranks the budget', () => {
    const channel = openChannel();

    for (let i = 0; i < AGENT_ASK_BUDGET; i += 1) {
      send(channel, ask({ id: `ask-${i}`, text: `ask ${i}` }));
    }
    expect(send(channel, ask({ id: 'over', text: 'one more' }))?.state).toBe(
      'budget',
    );

    // Mute is the reader's, so it is set outside any ask.
    channel.setMuted(FRAME_ORIGIN, true);
    expect(channel.isMuted(FRAME_ORIGIN)).toBe(true);
    expect(channel.isMuted(OTHER_ORIGIN)).toBe(false);

    // A muted app is not told how many asks it has left: the mute is the answer.
    for (let i = 0; i < 6; i += 1) {
      const answer = send(channel, ask({ id: `muted-${i}` }));
      expect(answer).toMatchObject({
        state: 'muted',
        message: AGENT_ASK_SENTENCES.muted,
      });
    }

    channel.setMuted(FRAME_ORIGIN, false);
    expect(send(channel, ask({ id: 'after' }))?.state).toBe('budget');
  });

  it('mutes only the origin it was told, and says nothing else about it', () => {
    const channel = openChannel();
    channel.setMuted(OTHER_ORIGIN, true);

    // A mute for another app is not this app's answer: the reader's ceiling is
    // per origin, and this one has not earned it.
    expect(send(channel, ask())?.state).toBe('unavailable');
    expect(channel.isMuted(OTHER_ORIGIN)).toBe(true);
  });

  it('keeps the mute across a new window on the same origin', () => {
    const channel = openChannel();
    channel.setMuted(FRAME_ORIGIN, true);

    // A relaunch is a new window — a new budget and new ids — but the reader
    // said stop asking, and that is theirs to undo (§7 row 7).
    channel.setLaunchedUrl(FRAME_URL);
    expect(channel.isMuted(FRAME_ORIGIN)).toBe(true);
    expect(send(channel, ask({ id: 'relaunched' }))?.state).toBe('muted');
  });

  it('reads the mute from the store it was given', () => {
    const read = vi.fn().mockReturnValue(true);
    const write = vi.fn();
    const channel = createAgentAskChannel({
      hasPairedSession: () => true,
      mutes: { read, write },
    });
    channel.setLaunchedUrl(FRAME_URL);

    expect(send(channel, ask())?.state).toBe('muted');
    expect(read).toHaveBeenCalledWith(FRAME_ORIGIN);

    channel.setMuted(FRAME_ORIGIN, true);
    expect(write).toHaveBeenCalledWith(FRAME_ORIGIN, true);
  });

  it('starts the ids and the budget over when the launched URL changes', () => {
    const channel = openChannel();

    for (let i = 0; i < AGENT_ASK_BUDGET; i += 1) {
      send(channel, ask({ id: `ask-${i}`, text: `ask ${i}` }));
    }
    expect(send(channel, ask({ id: 'over', text: 'one more' }))?.state).toBe(
      'budget',
    );

    // The same origin, a new window: what the shell launched is what the state
    // belongs to.
    channel.setLaunchedUrl(`${FRAME_URL}/second`);
    expect(send(channel, ask({ id: 'ask-0', text: 'ask 0' }))?.state).toBe(
      'unavailable',
    );
    expect(send(channel, ask({ id: 'fresh', text: 'fresh' }))?.state).toBe(
      'unavailable',
    );
  });
});

describe('readAgentAsk', () => {
  it('returns only the fields the envelope defines', () => {
    const envelope = readAgentAsk(
      ask({ embeds: ['https://example.com/a.png'] }),
    ) as AgentAskEnvelope & { extra?: unknown };

    expect(envelope).toEqual({
      id: 'ask-1',
      ask: 'draft',
      text: 'draft a cast about this',
      embeds: ['https://example.com/a.png'],
    });
    expect('extra' in envelope).toBe(false);
  });

  it('copies the embeds rather than handing over the app’s own array', () => {
    const embeds = ['https://example.com/a.png'];
    const envelope = readAgentAsk(ask({ embeds }));

    expect(envelope?.embeds).toEqual(embeds);
    expect(envelope?.embeds).not.toBe(embeds);
  });

  it('accepts an empty embeds list and leaves it off when it is absent', () => {
    expect(readAgentAsk(ask({ embeds: [] }))?.embeds).toEqual([]);
    expect(readAgentAsk(ask())?.embeds).toBeUndefined();
  });
});

describe('this slice reaches nothing', () => {
  const root = path.join(webRoot, 'src/components/miniApp/agentAskChannel.ts');
  const source = readFileSync(root, 'utf8');
  const miniAppSource = readFileSync(
    path.join(webRoot, 'src/components/miniApp/MiniApp.tsx'),
    'utf8',
  );

  it('imports nothing at all, so it cannot reach the agent or the write seam', () => {
    // The whole decision is a function of its arguments. An import is the only
    // way this file could call a chat route, open the composer, or write.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(
      /agentService|nodeWrites|composeCast|ComposeCast/,
    );
  });

  it('calls nothing and posts nothing: it returns the answer', () => {
    const fetchSpy = vi.fn();
    const postMessageSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('postMessage', postMessageSpy);

    const answer = send(openChannel(), ask());

    expect(answer?.state).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('answers with the five envelope fields and never the app’s own text', () => {
    const secret = 'ask my agent for the private thing';
    const answer = send(openChannel(), ask({ text: secret }));

    expect(Object.keys(answer ?? {}).sort()).toEqual([
      'id',
      'message',
      'state',
      'type',
      'v',
    ]);
    // A state word and one sentence, and nothing the app supplied: the only way
    // an answer could be a data pump is if app text rode back out in it.
    expect(answer?.message).not.toContain(secret);
    expect(JSON.stringify(answer)).not.toContain('private thing');
  });

  it('can only say the five states this slice has', () => {
    const channel = openChannel();
    const states = new Set<string>();

    for (const data of [
      ask({ id: 'a' }),
      ask({ id: 'b', text: 'two' }),
      ask({ id: 'c', text: 'three' }),
      ask({ id: 'd', text: 'four' }),
      ask({ id: 'e', ask: 'post', text: 'five' }),
      ask({ id: 'f', ask: 'remind', text: 'six' }),
      { type: AGENT_ASK_MESSAGE, v: 1, id: 'g', ask: 'draft' },
    ]) {
      const answer = send(channel, data);
      if (answer) {
        states.add(answer.state);
      }
    }

    expect([...states].sort()).toEqual(['budget', 'invalid', 'unavailable']);
    // Nothing effectful is reachable in this slice.
    for (const state of states) {
      expect(['drafted', 'posted', 'asked', 'unknown']).not.toContain(state);
    }
  });

  it('is declared as a capability, and wired as one real listener', () => {
    expect(AGENT_ASK_CAPABILITY).toBe('fiddy.agent.ask');
    expect(miniAppSource).toContain('AGENT_ASK_CAPABILITY');
    expect(miniAppSource).toContain("window.addEventListener('message'");
    expect(miniAppSource).toContain("window.removeEventListener('message'");
    // The wiring hands the channel the frame's own window object, posts the
    // answer back to that frame's origin, and pins the frame itself before it
    // gets that far.
    expect(miniAppSource).toContain('iframe.contentWindow');
    expect(miniAppSource).toMatch(/postMessage\(answer, frameOrigin\)/);
    expect(miniAppSource).toMatch(
      /event\.source !== iframe\.contentWindow\s*\|\|\s*event\.origin !== frameOrigin/,
    );
  });
});

describe('the seam the slices that do something answer through', () => {
  /**
   * S2 wired in the way `MiniApp.tsx` wires it: a handler takes `draft` and
   * `post` and answers later; everything else is still this channel's own
   * honest answer. What is asserted here is the half that must not change when a
   * handler is present — the pin, the one-shot ids, the duplicate window, the
   * budget, the mute, the sentences — plus the one thing the handler needs back
   * from the channel: what the ask ended as (§4's duplicate window).
   */
  const openDeferred = () => {
    const taken: {
      envelope: AgentAskEnvelope;
      deferral: AgentAskDeferral;
    }[] = [];
    const channel = createAgentAskChannel({
      hasPairedSession: () => true,
      now: () => clock,
      answerAsk: (envelope, deferral) => {
        if (envelope.ask === 'remind') {
          return false;
        }
        taken.push({ envelope, deferral });
        return true;
      },
    });
    channel.setLaunchedUrl(FRAME_URL);
    return { channel, taken };
  };

  it('hands a real ask over and says nothing itself', () => {
    const { channel, taken } = openDeferred();

    const answer = send(channel, ask());

    // Silence from the channel: the answer is the handler's to give, in its own
    // time, and a channel that also answered would be answering twice.
    expect(answer).toBeUndefined();
    expect(taken).toHaveLength(1);
    expect(taken[0]?.envelope).toMatchObject({
      id: 'ask-1',
      ask: 'draft',
      text: 'draft a cast about this',
    });
    // What the handler is given to answer with: the origin the window was
    // launched with, the frame's own window object, and the one line back.
    expect(taken[0]?.deferral.origin).toBe(FRAME_ORIGIN);
    expect(taken[0]?.deferral.frameWindow).toBe(FRAME_WINDOW);
    expect(typeof taken[0]?.deferral.settled).toBe('function');
  });

  it('leaves an ask no slice has a path for to this channel’s own answer', () => {
    const { channel, taken } = openDeferred();

    const answer = send(channel, ask({ id: 'r1', ask: 'remind' }));

    expect(answer?.state).toBe('unavailable');
    expect(taken).toHaveLength(0);
  });

  it('answers a duplicate from what the ask settled as, not from a placeholder', () => {
    const { channel, taken } = openDeferred();
    expect(send(channel, ask())).toBeUndefined();
    taken[0]?.deferral.settled('posted');

    clock += 1_000;
    const answer = send(channel, ask({ id: 'ask-2' }));

    expect(answer?.state).toBe('posted');
    expect(answer?.message).toBe(AGENT_ASK_SENTENCES.posted);
    expect(taken).toHaveLength(1);
  });

  it('joins a duplicate of an ask that is still being decided', () => {
    const { channel, taken } = openDeferred();

    // A double-send while the reader is deciding is the same decision: it goes
    // to the same handler (S2's store joins it), and it raises nothing.
    expect(send(channel, ask({ id: 'a' }))).toBeUndefined();
    expect(send(channel, ask({ id: 'b' }))).toBeUndefined();
    expect(send(channel, ask({ id: 'c' }))).toBeUndefined();
    expect(taken).toHaveLength(3);

    // And none of them spent the ceiling: a different ask still gets in.
    expect(
      send(channel, ask({ id: 'd', text: 'a different ask' })),
    ).toBeUndefined();
    expect(taken).toHaveLength(4);
  });

  it('still counts the ceiling for asks a handler answered', () => {
    const { channel, taken } = openDeferred();

    for (const id of ['a', 'b', 'c']) {
      expect(send(channel, ask({ id, text: `ask ${id}` }))).toBeUndefined();
    }
    const answer = send(channel, ask({ id: 'd', text: 'ask d' }));

    expect(answer?.state).toBe('budget');
    expect(taken).toHaveLength(AGENT_ASK_BUDGET);
  });

  it('is still reachable only from the framed window, at its own origin', () => {
    const { channel, taken } = openDeferred();

    expect(send(channel, ask(), { source: NESTED_WINDOW })).toBeUndefined();
    expect(send(channel, ask(), { origin: OTHER_ORIGIN })).toBeUndefined();
    expect(
      send(channel, ask(), { frameWindow: NESTED_WINDOW }),
    ).toBeUndefined();
    expect(taken).toHaveLength(0);
  });

  it('keeps the reader’s mute ahead of any handler', () => {
    const taken: unknown[] = [];
    const channel = createAgentAskChannel({
      hasPairedSession: () => true,
      now: () => clock,
      mutes: {
        read: () => true,
        write: () => undefined,
      },
      answerAsk: (envelope, deferral) => {
        taken.push({ envelope, deferral });
        return true;
      },
    });
    channel.setLaunchedUrl(FRAME_URL);

    const answer = send(channel, ask());

    expect(answer?.state).toBe('muted');
    expect(taken).toHaveLength(0);
  });

  it('reports an ask’s outcome only into that ask’s own record', () => {
    const { channel, taken } = openDeferred();
    expect(send(channel, ask({ id: 'a' }))).toBeUndefined();

    clock += 60_000;
    expect(
      send(channel, ask({ id: 'b', text: 'a second, different ask' })),
    ).toBeUndefined();
    taken[1]?.deferral.settled('drafted');

    // A late verdict for the first ask must not overwrite the second's.
    taken[0]?.deferral.settled('failed');

    clock += 1_000;
    const answer = send(
      channel,
      ask({ id: 'c', text: 'a second, different ask' }),
    );
    expect(answer?.state).toBe('drafted');
  });
});
