/**
 * Asking to back an account up, and stopping when told.
 *
 * Three claims carry the whole feature: a saved account is never asked about
 * again, "not now" buys days rather than hours, and a visit or a reload is not a
 * fresh ask. They are asserted against the pure transitions, so what is checked
 * is the rule rather than a mocked clock's arithmetic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import {
  DEFER_MS,
  deferBackup,
  initialSeedBackupState,
  loadSeedBackupState,
  markBackupSaved,
  MIN_GAP_BETWEEN_ASKS_MS,
  noteBackupAsked,
  saveSeedBackupState,
  seedBackupKeyFor,
  shouldAskForBackup,
} from '~/lib/seedBackup';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  store.clear();
});

describe('a fresh account', () => {
  it('is asked about on the account screen', () => {
    expect(shouldAskForBackup(initialSeedBackupState(), NOW)).toBe(true);
  });

  it('is not asked about twice in the same visit', () => {
    const asked = noteBackupAsked(initialSeedBackupState(), NOW);

    expect(shouldAskForBackup(asked, NOW + 60_000)).toBe(false);
    expect(shouldAskForBackup(asked, NOW + MIN_GAP_BETWEEN_ASKS_MS - 1)).toBe(
      false,
    );
  });

  it('is asked again on a later visit, because nothing was decided yet', () => {
    const asked = noteBackupAsked(initialSeedBackupState(), NOW);

    expect(shouldAskForBackup(asked, NOW + MIN_GAP_BETWEEN_ASKS_MS + 1)).toBe(
      true,
    );
  });
});

describe('"not now"', () => {
  it('buys days, not hours', () => {
    const deferred = deferBackup(initialSeedBackupState(), NOW);

    expect(deferred.status).toBe('deferred');
    expect(deferred.remindAfter).toBe(NOW + DEFER_MS);
    expect(DEFER_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('comes back by itself when the time is up', () => {
    const deferred = deferBackup(initialSeedBackupState(), NOW);

    expect(shouldAskForBackup(deferred, NOW + 60_000)).toBe(false);
    expect(shouldAskForBackup(deferred, NOW + DEFER_MS - 1)).toBe(false);
    expect(shouldAskForBackup(deferred, NOW + DEFER_MS)).toBe(true);
  });

  it('counts the reminders, so the asking is measurable', () => {
    const once = deferBackup(initialSeedBackupState(), NOW);
    const twice = deferBackup(once, NOW + DEFER_MS);

    expect(twice.reminders).toBe(2);
  });
});

describe('"I have written them down"', () => {
  it('ends the asking for this account, for good', () => {
    const saved = markBackupSaved(initialSeedBackupState(), NOW);

    expect(saved.status).toBe('saved');
    expect(saved.savedAt).toBe(NOW);
    expect(shouldAskForBackup(saved, NOW)).toBe(false);
    expect(shouldAskForBackup(saved, NOW + DEFER_MS * 100)).toBe(false);
  });

  it('ends it even when the asking had already been put off three times', () => {
    let state = initialSeedBackupState();

    for (let reminder = 0; reminder < 3; reminder += 1) {
      state = deferBackup(state, NOW + reminder * DEFER_MS);
    }

    const saved = markBackupSaved(state, NOW + DEFER_MS * 4);

    expect(saved.reminders).toBe(3);
    expect(shouldAskForBackup(saved, NOW + DEFER_MS * 10)).toBe(false);
  });
});

describe('what is stored', () => {
  it('is keyed by the account, so one account’s answer never answers for another', async () => {
    await saveSeedBackupState(
      '0xAAA',
      deferBackup(initialSeedBackupState(), NOW),
    );

    const other = await loadSeedBackupState('0xbbb');

    expect(seedBackupKeyFor('0xBBB')).toBe('fiddy:seed-backup:0xbbb');
    expect(other.status).toBe('unseen');
    expect(shouldAskForBackup(other, NOW)).toBe(true);
  });

  it('survives a reload of the same account', async () => {
    await saveSeedBackupState(
      '0xaaa',
      markBackupSaved(initialSeedBackupState(), NOW),
    );

    const reloaded = await loadSeedBackupState('0xAAA');

    expect(reloaded.status).toBe('saved');
    expect(shouldAskForBackup(reloaded, NOW + DEFER_MS)).toBe(false);
  });

  it('is replaced by a fresh state when what is stored is not one', async () => {
    store.set('fiddy:seed-backup:0xaaa', { status: 'whatever', reminders: 9 });

    const loaded = await loadSeedBackupState('0xaaa');

    expect(loaded).toEqual(initialSeedBackupState());
  });

  it('holds no words: the stored value is four facts and a status', async () => {
    await saveSeedBackupState(
      '0xaaa',
      deferBackup(initialSeedBackupState(), NOW),
    );

    const stored = store.get('fiddy:seed-backup:0xaaa') as Record<
      string,
      unknown
    >;

    expect(Object.keys(stored).sort()).toEqual([
      'lastShownAt',
      'remindAfter',
      'reminders',
      'status',
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/[a-z]+ [a-z]+ [a-z]+ [a-z]+/);
  });
});
