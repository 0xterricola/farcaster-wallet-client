// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keepSchedule,
  loadSchedules,
  newScheduleId,
  saveSchedules,
  type ScheduleRequest,
  upsertSchedule,
} from '~/lib/agentSchedules';

// In-memory stand-in for the browser store: the module under test is the
// validation and merge logic, not localforage.
const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    store.has(key) ? store.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  },
  deleteItem: async (key: string) => {
    store.delete(key);
  },
}));

const schedule = (over: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
  id: 's1',
  agentId: 'a1',
  prompt: 'Every morning at 9, read my mentions',
  state: 'requested',
  createdAt: 1_792_000_000_000,
  ...over,
});

beforeEach(() => {
  store.clear();
});

describe('schedule records', () => {
  it('round-trips through storage', async () => {
    await saveSchedules('a1', [schedule()]);
    await expect(loadSchedules('a1')).resolves.toEqual([schedule()]);
  });

  it('keeps schedules per agent', async () => {
    await saveSchedules('a1', [schedule()]);
    await expect(loadSchedules('a2')).resolves.toEqual([]);
  });

  it('keeps a request an app made, with the app’s domain on the row', async () => {
    // A `remind` from a mini app (`CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.4): the
    // app's own words, and where they came from.
    const fromApp = schedule({
      prompt: 'remind me at nine every morning',
      domain: 'beep.works',
    });

    await saveSchedules('a1', [fromApp]);

    await expect(loadSchedules('a1')).resolves.toEqual([fromApp]);
  });

  it('drops rows that storage cannot vouch for', async () => {
    store.set('fiddy.agent.schedules.a1', [
      schedule(),
      { id: 'x', agentId: 'a1' },
      { ...schedule({ id: 's2' }), state: 'married' },
      null,
    ]);

    const loaded = await loadSchedules('a1');

    expect(loaded.map((item) => item.id)).toEqual(['s1']);
  });

  it('treats a non-array as empty instead of throwing', async () => {
    store.set('fiddy.agent.schedules.a1', '{"not":"an array"}');
    await expect(loadSchedules('a1')).resolves.toEqual([]);
  });
});

describe('upsertSchedule', () => {
  it('prepends a new request and keeps history', () => {
    const next = upsertSchedule([schedule()], schedule({ id: 's2' }));
    expect(next.map((item) => item.id)).toEqual(['s2', 's1']);
  });

  it('replaces in place when the agent answers the same request', () => {
    const answered = schedule({
      state: 'answered',
      reply: 'Scheduled for 09:00.',
    });
    const next = upsertSchedule([schedule()], answered);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(answered);
    // The log must not lose the prompt when the reply lands.
    expect(next[0].prompt).toBe(schedule().prompt);
  });
});

describe('keepSchedule', () => {
  it('writes the request, then replaces the same row with what came of it', async () => {
    const asked = schedule({ domain: 'beep.works' });

    await keepSchedule('a1', asked);
    await expect(loadSchedules('a1')).resolves.toEqual([asked]);

    const answered = schedule({
      domain: 'beep.works',
      state: 'answered',
      reply: 'Nine every morning.',
    });
    await keepSchedule('a1', answered);

    // One row, the app's own words still on it, and the answer beside them.
    await expect(loadSchedules('a1')).resolves.toEqual([answered]);
    expect(answered.prompt).toBe(asked.prompt);
  });

  it('keeps history: a second request is a second row', async () => {
    await keepSchedule('a1', schedule({ id: 's1' }));
    await keepSchedule(
      'a1',
      schedule({ id: 's2', prompt: 'and again at six' }),
    );

    await expect(loadSchedules('a1')).resolves.toEqual([
      schedule({ id: 's2', prompt: 'and again at six' }),
      schedule({ id: 's1' }),
    ]);
  });

  it('is the reader’s own agent’s log, and nobody else’s', async () => {
    await keepSchedule('a1', schedule({ agentId: 'a1' }));

    await expect(loadSchedules('a2')).resolves.toEqual([]);
  });
});

describe('newScheduleId', () => {
  it('is unique enough to key a list', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newScheduleId()));
    expect(ids.size).toBe(200);
  });
});
