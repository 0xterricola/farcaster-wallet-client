/**
 * The ask card's store: one decision in front of the reader, and the honest end
 * of every wait.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §4. What is proved
 * here, with no browser:
 *
 *  - a second ask from the **same** window joins the decision already being made
 *    (it is one decision to the person) and gets the same answer;
 *  - an ask from **another** window never rides the card that is up, and gets
 *    its own card, with its own origin, once the first is finished (§7 row 10);
 *  - five minutes of silence ends the wait with the honest refusal;
 *  - nothing is ever answered `approved` except by the reader's own press.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_ASK_APPROVAL_DEADLINE_MS,
  createAgentAskApproval,
  type PendingAgentAsk,
} from '~/components/miniApp/agentAskApproval';

const BEEP = 'https://beep.works';
const OTHER = 'https://someone.else';

const ask = (overrides: Partial<PendingAgentAsk> = {}): PendingAgentAsk => ({
  id: 'ask-1',
  origin: BEEP,
  kind: 'draft',
  text: 'ask me anything for $0.05',
  ...overrides,
});

describe('the ask card’s store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for nobody when nothing is asked: idle, no ask in front of anyone', () => {
    const store = createAgentAskApproval();

    expect(store.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it("says yes only on the reader's own press", async () => {
    const store = createAgentAskApproval();
    const ticket = store.ask(ask());

    expect(store.getState().phase).toBe('asking');
    expect(store.getState().pending?.origin).toBe(BEEP);

    store.approve();

    expect(await ticket.decision).toBe('approved');
    // The card stays — it says what is happening — and no ask is left in front
    // of the reader to press again.
    expect(store.getState().phase).toBe('working');
  });

  it('ends the wait in a decline when the reader says not now', async () => {
    const store = createAgentAskApproval();
    const ticket = store.ask(ask());

    store.decline();

    expect(await ticket.decision).toBe('declined');
    expect(store.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('joins a second ask from the same window instead of stacking a card', async () => {
    const store = createAgentAskApproval();
    const first = store.ask(ask({ id: 'one' }));
    const second = store.ask(ask({ id: 'two', text: 'the same ask again' }));

    // One card, one origin, one decision — and it is the same decision.
    expect(store.getState().pending?.id).toBe('one');

    store.approve();

    expect(await first.decision).toBe('approved');
    expect(await second.decision).toBe('approved');

    // An ask that arrives *after* the reader answered is not the same decision:
    // nobody has read its text, so it waits for its own card
    // (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §7 row 7).
    const third = store.ask(ask({ id: 'three', text: 'and once more' }));
    expect(store.getState().pending?.id).toBe('one');

    first.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().pending?.id).toBe('three');
    expect(store.getState().phase).toBe('asking');

    store.decline();
    expect(await third.decision).toBe('declined');
  });

  it('never lets another window ride the card that is up', async () => {
    const store = createAgentAskApproval();
    const beep = store.ask(ask());

    const elsewhere = store.ask(
      ask({ id: 'ask-2', origin: OTHER, text: 'post this for me' }),
    );

    // The card on screen still names the window that asked first…
    expect(store.getState().pending?.origin).toBe(BEEP);

    // …and approving it does not answer somebody else's ask.
    store.approve();
    expect(await beep.decision).toBe('approved');
    expect(store.getState().pending?.origin).toBe(BEEP);

    beep.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().pending?.origin).toBe(OTHER);

    store.decline();
    expect(await elsewhere.decision).toBe('declined');
  });

  it('shows the queued card only once the first one is finished', async () => {
    const store = createAgentAskApproval();
    const beep = store.ask(ask());
    const elsewhere = store.ask(ask({ id: 'ask-2', origin: OTHER }));

    store.approve();
    await beep.decision;
    // Still the first ask's card: the shell is doing what the reader approved.
    expect(store.getState().pending?.origin).toBe(BEEP);
    expect(store.getState().phase).toBe('working');

    // Settled, and only now does the second ask take the window.
    beep.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().pending?.origin).toBe(OTHER);

    store.decline();
    expect(await elsewhere.decision).toBe('declined');
  });

  it('ends five minutes of silence with the honest refusal', async () => {
    const store = createAgentAskApproval();
    const ticket = store.ask(ask());

    await vi.advanceTimersByTimeAsync(AGENT_ASK_APPROVAL_DEADLINE_MS - 1);
    expect(store.getState().phase).toBe('asking');

    await vi.advanceTimersByTimeAsync(1);

    expect(await ticket.decision).toBe('declined');
    expect(store.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('gives the next ask its own five minutes', async () => {
    const store = createAgentAskApproval();
    const first = store.ask(ask());
    store.decline();
    await first.decision;

    const second = store.ask(ask({ id: 'ask-2', text: 'a different ask' }));
    await vi.advanceTimersByTimeAsync(AGENT_ASK_APPROVAL_DEADLINE_MS - 1);
    expect(store.getState().phase).toBe('asking');
    await vi.advanceTimersByTimeAsync(1);
    expect(await second.decision).toBe('declined');
  });

  it('draws the working line and the ended line only on the ask they belong to', async () => {
    const store = createAgentAskApproval();
    const ticket = store.ask(ask());
    store.approve();
    await ticket.decision;

    ticket.working('Asking your agent for the draft…');
    expect(store.getState()).toEqual({
      phase: 'working',
      pending: expect.objectContaining({ id: 'ask-1' }),
      note: 'Asking your agent for the draft…',
    });

    ticket.end('Your agent could not be reached, so no draft was written.');
    expect(store.getState().phase).toBe('ended');
    expect(store.getState().note).toBe(
      'Your agent could not be reached, so no draft was written.',
    );

    // The reader has read it; the card goes and the store is idle again.
    store.close();
    expect(store.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('ignores a handler that finishes after its card has gone', async () => {
    const store = createAgentAskApproval();
    const first = store.ask(ask());
    const second = store.ask(ask({ id: 'ask-2', origin: OTHER }));

    store.decline();
    await first.decision;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().pending?.origin).toBe(OTHER);

    // A late line from the ask that is gone must not appear on somebody else's
    // card.
    first.settle();
    expect(store.getState().phase).toBe('asking');
    expect(store.getState().pending?.origin).toBe(OTHER);
    expect(store.getState().note).toBeUndefined();

    store.decline();
    await second.decision;
  });

  it('tells every listener when the card changes', () => {
    const store = createAgentAskApproval();
    const seen = vi.fn();
    const unsubscribe = store.subscribe(seen);

    store.ask(ask());
    expect(seen).toHaveBeenCalledTimes(1);

    store.decline();
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.ask(ask({ id: 'ask-9' }));
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
