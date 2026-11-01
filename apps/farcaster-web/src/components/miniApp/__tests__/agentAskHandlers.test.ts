/**
 * `draft`, `post` and `remind`: the three asks a mini app can have answered.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.2, §3.3, §3.4, §6.
 * Every state the bridge can answer with is proved here with fakes and no
 * browser:
 *
 *  - the message the agent gets is §3.2's and §3.4's template exactly, the app's
 *    text quoted and capped, and nothing else;
 *  - a `draft` puts the agent's words in the reader's composer and tells the app
 *    `drafted` — and the agent's words never come back out of this module;
 *  - a `post` is the reader's own press in the same composer, and the app is
 *    told `posted` / `unknown` / `failed` / `declined` from the write seam's own
 *    evidence, never a guess, and **never a cast hash** (§3.3);
 *  - a `remind` is one chat message to the reader's own agent and one row in the
 *    reader's own log; the app is told `asked` (or `failed`) and **never the
 *    agent's answer** (§3.4, §3.5);
 *  - an ask the reader declined is never carried anywhere;
 *  - and one approved decision spends once, even when §4's store joins a second
 *    send of the ask into the same decision.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentAskApproval } from '~/components/miniApp/agentAskApproval';
import {
  AGENT_ASK_MAX_TEXT_LENGTH,
  agentAskAnswer,
  type AgentAskEnvelope,
  createAgentAskChannel,
} from '~/components/miniApp/agentAskChannel';
import {
  agentAskChatMessage,
  agentRemindChatMessage,
  type AgentWriteEvidence,
  createAgentAskHandlers,
} from '~/components/miniApp/agentAskHandlers';
import type { ScheduleRequest } from '~/lib/agentSchedules';

const ORIGIN = 'https://beep.works';

const envelope = (
  overrides: Partial<AgentAskEnvelope> = {},
): AgentAskEnvelope => ({
  id: 'ask-1',
  ask: 'draft',
  text: 'ask me anything for $0.05',
  ...overrides,
});

const context = { origin: ORIGIN, name: 'Beep' };

/** Let a promise chain reach its next await. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const HASH = '0x9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3';

interface Harness {
  approval: ReturnType<typeof createAgentAskApproval>;
  handlers: ReturnType<typeof createAgentAskHandlers>;
  chat: ReturnType<typeof vi.fn>;
  composerIntents: { text: string; embeds?: string[] }[];
  /** How the composer closed, for the write the reader pressed Cast on. */
  closeComposer: (outcome: { cast: boolean }) => void;
  /** One write's evidence, as the seam reports it. */
  reportWrite: (evidence: AgentWriteEvidence) => void;
  /** Every row the reader's own log was handed, in the order it got them. */
  kept: ScheduleRequest[];
  agent: unknown;
}

const harness = ({
  agents = [
    { session: { baseUrl: 'https://agent.test', token: 't' }, agentId: 'a1' },
  ],
  reply = 'Here is a draft: “ask me anything for $0.05”.',
  keepFails = false,
}: {
  agents?: unknown[];
  reply?: string;
  keepFails?: boolean;
} = {}): Harness => {
  const approval = createAgentAskApproval({ deadlineMs: 5 * 60_000 });
  const chat = vi.fn(async () => reply);
  const composerIntents: { text: string; embeds?: string[] }[] = [];
  const kept: ScheduleRequest[] = [];
  let closeComposer: (outcome: { cast: boolean }) => void = () => undefined;
  let reportWrite: (evidence: AgentWriteEvidence) => void = () => undefined;

  const target = agents[0] as { session: unknown; agentId: string } | undefined;

  const handlers = createAgentAskHandlers({
    approval,
    agent: async () => target,
    chat,
    composer: (intent) => {
      composerIntents.push(intent);
      const closed = new Promise<{ cast: boolean }>((resolve) => {
        closeComposer = resolve;
      });
      return { closed };
    },
    writes: {
      observe: (listener) => {
        reportWrite = listener;
        return () => {
          reportWrite = () => undefined;
        };
      },
    },
    // The reader's own log, as `~/lib/agentSchedules` keeps it: one row per
    // request, written twice — the ask, then what came of it.
    schedules: {
      newId: () => `s${kept.length + 1}`,
      keep: async (_agentId, request) => {
        if (keepFails) {
          throw new Error('the log could not be written');
        }
        const index = kept.findIndex((row) => row.id === request.id);
        if (index === -1) {
          kept.push(request);
        } else {
          kept[index] = request;
        }
      },
    },
  });

  return {
    approval,
    handlers,
    chat,
    composerIntents,
    closeComposer: (outcome) => closeComposer(outcome),
    reportWrite: (evidence) => reportWrite(evidence),
    kept,
    agent: agents,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('what a mini app may ask for', () => {
  it('answers exactly the three asks the bridge has a path for', () => {
    const { handlers } = harness();

    expect(handlers.answers('draft')).toBe(true);
    expect(handlers.answers('post')).toBe(true);
    // S3's: the third ask, and the last one §1's table allows.
    expect(handlers.answers('remind')).toBe(true);
  });
});

describe('draft', () => {
  it('is not carried until the reader approved it', async () => {
    const { approval, handlers, chat, composerIntents } = harness();

    const answered = handlers.answer(envelope(), context);
    await flush();

    // The card is up; nothing has happened yet.
    expect(approval.getState().pending?.origin).toBe(ORIGIN);
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);

    approval.decline();
    expect(await answered).toBe('declined');
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);
  });

  it('sends §3.2’s message, exactly, with the app’s text quoted and capped', async () => {
    const { approval, handlers, chat } = harness();
    const long = 'x'.repeat(600);
    const answered = handlers.answer(envelope({ text: long }), context);
    await flush();
    approval.approve();
    await answered;

    expect(chat).toHaveBeenCalledTimes(1);
    const [target, message] = chat.mock.calls[0] as [
      { agentId: string },
      string,
    ];
    expect(target.agentId).toBe('a1');
    expect(message).toBe(
      `Someone's app at beep.works asks you for a draft cast about this:\n"${'x'.repeat(
        AGENT_ASK_MAX_TEXT_LENGTH,
      )}"\nWrite the draft. Do not post anything.`,
    );
    // The app's own words, and nothing the app added.
    expect(message).not.toContain('undefined');
    expect(agentAskChatMessage({ domain: 'beep.works', text: long })).toBe(
      message,
    );
  });

  it('opens the reader’s own composer with the agent’s answer, and says drafted', async () => {
    const { approval, handlers, composerIntents } = harness({
      reply: 'A draft about the thing.',
    });
    const answered = handlers.answer(
      envelope({ embeds: ['https://example.com/a.png'] }),
      context,
    );
    await flush();
    approval.approve();

    expect(await answered).toBe('drafted');
    expect(composerIntents).toEqual([
      {
        text: 'A draft about the thing.',
        embeds: ['https://example.com/a.png'],
      },
    ]);
    // The reader's press is the only thing that can sign anything, so the card
    // is done: it is not left waiting on the composer.
    expect(approval.getState().phase).toBe('idle');
  });

  it('never hands the agent’s words back to the app', async () => {
    const secret = 'the reader’s agent said something private';
    const { approval, handlers } = harness({ reply: secret });
    const ask = envelope();

    const answered = handlers.answer(ask, context);
    await flush();
    approval.approve();
    const state = await answered;

    // The app gets a state word, and the sentence that word owns.
    const answer = agentAskAnswer(ask.id, state);
    expect(answer.state).toBe('drafted');
    expect(JSON.stringify(answer)).not.toContain('private');
    expect(answer.message).toBe('A draft is open in the composer.');
  });

  it('tells the app failed and opens nothing when the agent cannot be reached', async () => {
    const { approval, handlers, composerIntents, chat } = harness({
      agents: [],
    });

    const answered = handlers.answer(envelope(), context);
    await flush();
    approval.approve();
    const state = await answered;

    expect(state).toBe('failed');
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);
    // §3.2: one sentence says so, and the reader is the person it is said to.
    expect(approval.getState().phase).toBe('ended');
    expect(approval.getState().note).toBe(
      'Your agent could not be reached, so no draft was written.',
    );
  });

  it('tells the app failed and opens nothing when the chat itself fails', async () => {
    const { approval, composerIntents } = harness();
    const erroring = createAgentAskHandlers({
      approval,
      agent: async () => ({ session: {}, agentId: 'a1' }),
      chat: async () => {
        throw new Error('agent service down');
      },
      composer: (intent) => {
        composerIntents.push(intent);
        return { closed: Promise.resolve({ cast: false }) };
      },
      schedules: { newId: () => 's1', keep: async () => undefined },
    });

    const answered = erroring.answer(envelope(), context);
    await flush();
    approval.approve();

    expect(await answered).toBe('failed');
    expect(composerIntents).toEqual([]);
    expect(approval.getState().phase).toBe('ended');
  });
});

describe('post', () => {
  const postAsk = () => envelope({ ask: 'post', id: 'ask-post' });

  const runPost = async (harnessed: Harness) => {
    const answered = harnessed.handlers.answer(postAsk(), context);
    await flush();
    harnessed.approval.approve();
    await flush();
    // Returned inside an object on purpose: `await` on the promise itself would
    // wait for the composer to close, which is what the test then drives.
    return { answered };
  };

  it('opens the reader’s own composer with the app’s words, never the app itself', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    expect(harnessed.composerIntents).toEqual([
      { text: 'ask me anything for $0.05' },
    ]);
    harnessed.closeComposer({ cast: true });
    expect(await answered).toBe('posted');
  });

  it('says posted when the seam’s own evidence says the message landed', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });

    expect(await answered).toBe('posted');
  });

  it('says posted from the seam’s evidence even when the composer could not render it', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // A node accepted it and reads it back; the client simply could not turn
    // the stored message into a cast to show (`nodeWrites`' own 502). The
    // write did land, and the evidence is the only place that says so.
    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('posted');
  });

  it('says unknown when it was accepted and nothing shows it', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: false, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('unknown');
  });

  it('says failed when an approved attempt did not land', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // Signed and submitted, and the node refused it.
    harnessed.reportWrite({ accepted: false, landed: null, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('failed');
  });

  it('says declined when the reader never got as far as a write', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // The composing reader closing the composer: nothing was ever signed.
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('declined');
  });

  it('says declined when the reader said not now to the posting-key approval', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // The seam's own refusal for a write with no key: nothing signed, nothing
    // submitted — the person's own answer, reported as the person's own answer.
    harnessed.reportWrite({ accepted: false, landed: null });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('declined');
  });

  it('remembers the strongest thing that happened, not the last', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // A refused attempt, then the reader got a key and the retry landed.
    harnessed.reportWrite({ accepted: false, landed: null, messageHash: HASH });
    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });

    expect(await answered).toBe('posted');
  });

  it('never hands the app the cast’s hash', async () => {
    const harnessed = harness();
    const ask = postAsk();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });
    const state = await answered;

    const answer = agentAskAnswer(ask.id, state);
    expect(Object.keys(answer).sort()).toEqual([
      'id',
      'message',
      'state',
      'type',
      'v',
    ]);
    expect(JSON.stringify(answer)).not.toContain(HASH);
    expect(JSON.stringify(answer)).not.toContain('9f2c1d4e');
    expect(answer.message).toBe(
      "Fiddy's owner approved it, and the network shows the cast.",
    );
  });

  it('is not carried at all when the reader declined the ask itself', async () => {
    const harnessed = harness();
    const ask = postAsk();

    const answered = harnessed.handlers.answer(ask, context);
    await flush();
    harnessed.approval.decline();

    expect(await answered).toBe('declined');
    // No composer, and nothing to observe: declining the card is the end of it.
    expect(harnessed.composerIntents).toEqual([]);
  });
});

describe('remind', () => {
  const REMIND_REPLY = 'Done — one reminder every morning at nine.';
  const remindAsk = (over: Partial<AgentAskEnvelope> = {}) =>
    envelope({
      ask: 'remind',
      id: 'ask-remind',
      text: 'remind me at nine every morning',
      ...over,
    });

  /** The card, the approval, and the answer, as the shell drives them. */
  const runRemind = async (
    harnessed: Harness,
    over: Partial<AgentAskEnvelope> = {},
    { approve = true }: { approve?: boolean } = {},
  ) => {
    const ask = remindAsk(over);
    const answered = harnessed.handlers.answer(ask, context);
    await flush();
    if (approve) {
      harnessed.approval.approve();
    }
    return { ask, answered };
  };

  it('is not carried until the reader approved it', async () => {
    const harnessed = harness({ reply: REMIND_REPLY });
    const { answered } = await runRemind(harnessed, {}, { approve: false });

    // The card is up; nothing has been sent to anybody.
    expect(harnessed.approval.getState().pending?.kind).toBe('remind');
    expect(harnessed.chat).not.toHaveBeenCalled();
    expect(harnessed.kept).toEqual([]);

    harnessed.approval.decline();
    expect(await answered).toBe('declined');
    expect(harnessed.chat).not.toHaveBeenCalled();
    expect(harnessed.kept).toEqual([]);
  });

  it('sends §3.4’s message: the Scheduled tasks wording, the app named by domain', async () => {
    const harnessed = harness({ reply: REMIND_REPLY });
    const long = 'x'.repeat(600);
    const { answered } = await runRemind(harnessed, { text: long });

    expect(await answered).toBe('asked');
    expect(harnessed.chat).toHaveBeenCalledTimes(1);
    const [target, message] = harnessed.chat.mock.calls[0] as [
      { agentId: string },
      string,
    ];
    expect(message).toBe(
      `Someone's app at beep.works asks me to be reminded: "${'x'.repeat(
        AGENT_ASK_MAX_TEXT_LENGTH,
      )}"\nSchedule this recurring task for me, then confirm it in one line: ${'x'.repeat(
        AGENT_ASK_MAX_TEXT_LENGTH,
      )}`,
    );
    expect(agentRemindChatMessage({ domain: 'beep.works', text: long })).toBe(
      message,
    );
    // The app's own words, capped and quoted, and nothing the app added: it can
    // put no second instruction, recipient or account in here (§7 row 4).
    expect(message).not.toContain('undefined');
    expect(message.split('\n')).toHaveLength(2);
    expect(target.agentId).toBe('a1');
  });

  it('asks in the words the Scheduled tasks tab already uses, in both files', () => {
    // The sentence is AgentPage.tsx's own (`:545-548`): a request the reader
    // typed and a request an app made are the same message to the agent, and a
    // reword in one place must not silently leave the other behind.
    const page = readFileSync(
      path.resolve(__dirname, '../../../pages/agent/AgentPage.tsx'),
      'utf8',
    );
    const sentence =
      'Schedule this recurring task for me, then confirm it in one line:';
    expect(page).toContain(sentence);
    expect(
      agentRemindChatMessage({ domain: 'beep.works', text: 'x' }),
    ).toContain(sentence);
  });

  it('tells the app asked, and never the agent’s answer', async () => {
    const secret = 'the reader’s agent named a channel and two people';
    const harnessed = harness({ reply: secret });
    const { ask, answered } = await runRemind(harnessed);
    const state = await answered;

    const answer = agentAskAnswer(ask.id, state);
    expect(answer.state).toBe('asked');
    expect(answer.message).toBe(
      'Your agent was asked; the answer stays with its owner.',
    );
    // §3.5: the answer is built from the reader's own feed, mentions and
    // approved channels, and a foreign page has no claim on any of it.
    expect(JSON.stringify(answer)).not.toContain('channel');
    expect(JSON.stringify(answer)).not.toContain('people');
    expect(answer).not.toHaveProperty('reply');
    // It is in the reader's own log instead — that is where it lives.
    expect(harnessed.kept[0]?.reply).toBe(secret);
  });

  it('writes the reader’s own row: the ask’s own text, the domain, then the answer', async () => {
    const harnessed = harness({ reply: REMIND_REPLY });
    const { answered } = await runRemind(harnessed, {
      text: 'remind me to water the plants on Sundays',
    });
    await answered;

    // One row, written twice: the request, then what came of it.
    expect(harnessed.kept).toHaveLength(1);
    expect(harnessed.kept[0]).toMatchObject({
      agentId: 'a1',
      prompt: 'remind me to water the plants on Sundays',
      domain: 'beep.works',
      state: 'answered',
      reply: REMIND_REPLY,
    });
    // The request is not the composed chat message: it is what the app asked
    // for, as the app wrote it.
    expect(harnessed.kept[0]?.prompt).not.toContain('Someone’s app');
    expect(harnessed.kept[0]?.prompt).not.toContain("Someone's app");
    expect(typeof harnessed.kept[0]?.createdAt).toBe('number');
  });

  /** The reader's log, upserting by row id, as `~/lib/agentSchedules` does. */
  const log = (rows: ScheduleRequest[]) => ({
    newId: () => 's1',
    keep: async (_agentId: string, request: ScheduleRequest) => {
      const index = rows.findIndex((row) => row.id === request.id);
      if (index === -1) {
        rows.push(request);
      } else {
        rows[index] = request;
      }
    },
  });

  it('writes the request before the message goes out, so a slow agent still shows', async () => {
    const harnessed = harness({ reply: REMIND_REPLY });
    let settle: (reply: string) => void = () => undefined;
    const slow = createAgentAskHandlers({
      approval: harnessed.approval,
      agent: async () => ({ session: {}, agentId: 'a1' }),
      chat: () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
      composer: () => ({ closed: Promise.resolve({ cast: false }) }),
      schedules: log(harnessed.kept),
    });

    const answered = slow.answer(remindAsk(), context);
    await flush();
    harnessed.approval.approve();
    await flush();

    // Sent, and not yet answered: the reader's own surface says `sent · waiting`
    // (the panel's own words for `requested`), never a claim it is running.
    expect(harnessed.kept).toHaveLength(1);
    expect(harnessed.kept[0]?.state).toBe('requested');
    expect(harnessed.approval.getState().phase).toBe('working');

    settle(REMIND_REPLY);
    expect(await answered).toBe('asked');
    expect(harnessed.kept[0]?.state).toBe('answered');
    expect(harnessed.approval.getState().phase).toBe('ended');
    expect(harnessed.approval.getState().note).toBe(
      'Your agent answered — the request and its answer are in Scheduled tasks.',
    );
  });

  it('tells the app failed, writes a failed row, and says so to the reader', async () => {
    const harnessed = harness();
    const failing = createAgentAskHandlers({
      approval: harnessed.approval,
      agent: async () => ({ session: {}, agentId: 'a1' }),
      chat: async () => {
        throw new Error('agent service down');
      },
      composer: () => ({ closed: Promise.resolve({ cast: false }) }),
      schedules: log(harnessed.kept),
    });

    const answered = failing.answer(
      remindAsk({ text: 'a shout in the dark' }),
      context,
    );
    await flush();
    harnessed.approval.approve();

    expect(await answered).toBe('failed');
    expect(harnessed.kept).toHaveLength(1);
    expect(harnessed.kept[0]).toMatchObject({
      state: 'failed',
      prompt: 'a shout in the dark',
      domain: 'beep.works',
    });
    // No diagnosis, and nothing of the shell's error either: the panel's own
    // words for a failed row are "did not send".
    expect(harnessed.kept[0]?.reply).toBeUndefined();
    expect(harnessed.approval.getState().phase).toBe('ended');
    expect(harnessed.approval.getState().note).toBe(
      'Your agent could not be reached, so nothing was sent.',
    );
  });

  it('tells the app failed when there is no agent to ask, and records nothing', async () => {
    const harnessed = harness({ agents: [] });

    const answered = harnessed.handlers.answer(remindAsk(), context);
    await flush();
    harnessed.approval.approve();

    expect(await answered).toBe('failed');
    expect(harnessed.chat).not.toHaveBeenCalled();
    // The log is per agent: with no agent there is no request to keep.
    expect(harnessed.kept).toEqual([]);
  });

  it('answers honestly even when the reader’s own log cannot be written', async () => {
    const harnessed = harness({ reply: REMIND_REPLY, keepFails: true });

    const answered = harnessed.handlers.answer(remindAsk(), context);
    await flush();
    harnessed.approval.approve();
    const state = await answered;

    // The message is what the app is told about, and it went out. The record is
    // the reader's own half of the same fact, and losing it does not invent a
    // failure of the send.
    expect(state).toBe('asked');
    expect(harnessed.kept).toEqual([]);
  });
});

describe('the whole path, the channel included', () => {
  /**
   * The glue `MiniApp.tsx` wires, reduced to what these tests need: one channel,
   * one set of handlers, the reader's decision in the middle, and the app's own
   * window as the only place an answer is posted.
   */
  const path = (harnessed: Harness) => {
    const posted: { message: unknown; targetOrigin: string }[] = [];
    const frameWindow = {
      postMessage: (message: unknown, targetOrigin: string) => {
        posted.push({ message, targetOrigin });
      },
    };
    const channel = createAgentAskChannel({
      hasPairedSession: () => true,
      answerAsk: (envelope, deferral) => {
        if (!harnessed.handlers.answers(envelope.ask)) {
          return false;
        }
        void harnessed.handlers
          .answer(envelope, { origin: deferral.origin })
          .then((state) => {
            deferral.settled(state);
            frameWindow.postMessage(
              agentAskAnswer(envelope.id, state),
              deferral.origin,
            );
          })
          .catch(() => {
            deferral.settled('failed');
            frameWindow.postMessage(
              agentAskAnswer(envelope.id, 'failed'),
              deferral.origin,
            );
          });
        return true;
      },
    });
    channel.setLaunchedUrl(`${ORIGIN}/app`);

    const send = (data: unknown) =>
      channel.handle(
        { source: frameWindow, origin: ORIGIN, data },
        frameWindow,
      );

    return { posted, send };
  };

  const REMIND = {
    type: 'fiddy:agent-ask',
    v: 1,
    ask: 'remind',
    text: 'remind me at nine every morning',
  };

  it('spends one chat message when a second send joins the same decision', async () => {
    const harnessed = harness({ reply: 'Done — nine every morning.' });
    const { posted, send } = path(harnessed);

    // The app sends the same ask twice (a double-send, a retry) before the
    // reader has decided: §4's store joins the second into the decision already
    // in front of them, and the shell must not pay for it twice.
    expect(send({ ...REMIND, id: 'r1' })).toBeUndefined();
    await flush();
    expect(send({ ...REMIND, id: 'r2' })).toBeUndefined();
    await flush();
    expect(harnessed.approval.getState().pending?.kind).toBe('remind');

    harnessed.approval.approve();
    await flush();
    await flush();

    expect(harnessed.chat).toHaveBeenCalledTimes(1);
    // Both sends are answered, under their own ids, with the same word.
    expect(posted).toHaveLength(2);
    expect(
      posted.map((one) => (one.message as { id: string }).id).sort(),
    ).toEqual(['r1', 'r2']);
    for (const one of posted) {
      expect(one).toMatchObject({
        targetOrigin: ORIGIN,
        message: { state: 'asked' },
      });
    }
    // And one row, not two.
    expect(harnessed.kept).toHaveLength(1);
    expect(harnessed.kept[0]?.state).toBe('answered');
  });

  it('posts nothing of the agent’s answer back to the app', async () => {
    const secret = 'the agent mentioned two channels and a person';
    const harnessed = harness({ reply: secret });
    const { posted, send } = path(harnessed);

    send({ ...REMIND, id: 'r1' });
    await flush();
    harnessed.approval.approve();
    await flush();
    await flush();

    expect(posted).toHaveLength(1);
    const wire = JSON.stringify(posted);
    expect(wire).not.toContain('channel');
    expect(wire).not.toContain('person');
    expect(wire).not.toContain(secret);
    expect(wire).toContain('"state":"asked"');
  });

  it('refuses an ask that names an agent before any handler sees it', async () => {
    const harnessed = harness();
    const { posted, send } = path(harnessed);

    // S1's own rule, pinned here as the pair to this slice's: the app cannot
    // name, choose or influence which agent it is talking to (§5).
    const answer = send({ ...REMIND, id: 'r1', agentId: 'a9' });

    expect(answer?.state).toBe('invalid');
    expect(posted).toEqual([]);
    expect(harnessed.chat).not.toHaveBeenCalled();
    expect(harnessed.kept).toEqual([]);
  });
});

describe('the sentences the app can read', () => {
  it('carries no protocol word for a reader or an app author', async () => {
    const states = [
      'posted',
      'unknown',
      'failed',
      'declined',
      'drafted',
      'asked',
    ] as const;

    for (const state of states) {
      const answer = agentAskAnswer('ask-1', state);
      expect(answer.message).not.toMatch(/node|signer|scope|TTL|gasless/i);
    }
  });
});
