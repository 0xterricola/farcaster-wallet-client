/**
 * Mutes, blocks and hidden words: what the reader holds, how long each lasts,
 * how a matcher for the words is built, and the synchronous answers the read
 * seam asks for while it assembles a page.
 *
 * The four things these tests are here to pin down, because each is a way the
 * feature can silently be wrong:
 *
 *   1. a word matches WHOLE WORDS ONLY (`$based` must not catch `$basedgod`),
 *   2. a word in a script written without spaces matches anywhere (CJK),
 *   3. a timed entry stops applying when it runs out — decided at a fixed `now`,
 *      never by waiting for a clock,
 *   4. a hostile stored list is clamped, and the seam answers during a read from
 *      the list a save has just written, with no reload in between.
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
  cleanMutes,
  getActiveMutes,
  liftMute,
  liveEntry,
  loadActiveMutes,
  loadMutes,
  MUTE_FID_LIMIT,
  MUTE_WORD_LIMIT,
  mutedAuthorInUse,
  mutedWordInUse,
  mutesInUse,
  resetActiveMutes,
  saveMutes,
  setMute,
  subscribeToMutes,
  untilText,
  wordsRe,
} from '~/snapchain/mutePreferences';

const FID = 1918;
const OTHER = 7237;

beforeEach(() => {
  store.clear();
  resetActiveMutes();
  vi.useRealTimers();
});

describe('wordsRe: muted words match whole words, in any case', () => {
  it('matches a word the reader typed, and refuses the word it is part of', () => {
    const re = wordsRe(['$based', 'gm', 'c++'])!;
    for (const text of [
      '$BASED is trending',
      'so $based.',
      'GM frens',
      'c++ rocks',
    ]) {
      expect(re.test(text)).toBe(true);
    }
    for (const text of ['$basedgod', 'based', 'gmail', 'dogma', 'c+', 'gm2']) {
      expect(re.test(text)).toBe(false);
    }
  });

  it('mutes a ticker or a tag without touching the plain word', () => {
    const re = wordsRe(['$ticker', '#spam'])!;
    expect(re.test('I bought $ticker today')).toBe(true);
    expect(re.test('tag it #spam please')).toBe(true);
    // The bare word is a different word: hiding "spam" is the reader's call.
    expect(re.test('that is spam')).toBe(false);
    expect(re.test('$ticker2')).toBe(false);
  });

  it('matches a word in a script written without spaces, anywhere in the text', () => {
    const re = wordsRe(['比特币'])!;
    expect(re.test('我买了比特币')).toBe(true);
    // No boundary to anchor to, so escaping is the only thing that matters.
    expect(re.test('比特币 (bitcoin)')).toBe(true);
  });

  it('is one expression for the whole list, and nothing at all for no list', () => {
    expect(wordsRe([])).toBeNull();
    const re = wordsRe(['a', 'b']);
    expect(re!.source.includes('(?:a|b)')).toBe(true);
  });

  it('a word with regex metacharacters is matched literally', () => {
    const re = wordsRe(['c++', 'a.b'])!;
    expect(re.test('learning c++ today')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });
});

describe('cleanMutes: what a stored list is allowed to be', () => {
  it('drops expired entries, de-dupes, and refuses what the UI cannot write', () => {
    const cleaned = cleanMutes(
      {
        words: [
          { v: ' GM ' },
          { v: 'gm', until: 5000 },
          { v: 'old', until: 999 },
          { v: 7 },
          { v: '' },
        ],
        users: [{ v: 3, until: 2000 }, { v: -1 }, { v: 'x' }, { v: 1.5 }],
        blocks: [{ v: 9, until: 'soon' }],
        extra: 'ignored',
      },
      1000,
    );

    expect(cleaned).toEqual({
      // Trimmed, lower-cased, once — and the later entry wins.
      words: [{ v: 'gm', until: 5000 }],
      users: [{ v: 3, until: 2000 }],
      // A non-integer `until` is no end at all, which is not an expiry.
      blocks: [{ v: 9 }],
    });
  });

  it('answers an empty list for nothing, for nonsense, and for a hostile one', () => {
    expect(cleanMutes(null)).toEqual({ words: [], users: [], blocks: [] });
    expect(cleanMutes('nope')).toEqual({ words: [], users: [], blocks: [] });
    expect(cleanMutes({ words: {} })).toEqual({
      words: [],
      users: [],
      blocks: [],
    });

    const hostile = cleanMutes({
      words: Array.from({ length: MUTE_WORD_LIMIT + 50 }, (_, i) => ({
        v: `word${i}`,
      })),
      users: Array.from({ length: MUTE_FID_LIMIT + 50 }, (_, i) => ({
        v: i + 1,
      })),
    });
    expect(hostile.words).toHaveLength(MUTE_WORD_LIMIT);
    expect(hostile.users).toHaveLength(MUTE_FID_LIMIT);
  });

  it('cuts a word down to what can be matched, and keeps the last of a duplicate', () => {
    const long = 'x'.repeat(200);
    const cleaned = cleanMutes({ words: [{ v: long }] });
    expect(cleaned.words[0]!.v).toHaveLength(60);
    expect(cleaned.words[0]!.v).toBe('x'.repeat(60));
  });
});

describe('a timed mute runs out at its own moment', () => {
  it('stops hiding a word the instant it lapses, at a fixed now', async () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await loadActiveMutes(FID);
    await setMute({
      fid: FID,
      kind: 'words',
      value: 'spoilers',
      until: now + 1000,
    });

    expect(mutedWordInUse('full of spoilers')).toBe(true);

    // One millisecond past the end, not a minute later: the matcher is rebuilt
    // at the earliest end among the words it holds.
    vi.setSystemTime(now + 1001);
    expect(mutedWordInUse('full of spoilers')).toBe(false);
    expect(mutesInUse()).toBeUndefined();
  });

  it('keeps an entry with no end through any amount of time', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const list = cleanMutes(
      { users: [{ v: OTHER }] },
      now + 10 * 365 * 86_400_000,
    );
    expect(list.users).toEqual([{ v: OTHER }]);
    expect(liveEntry([{ v: OTHER }], OTHER, now)).toEqual({ v: OTHER });
  });
});

describe('the store the read seam reads', () => {
  it('answers synchronously from the list a save just wrote, with no reload', async () => {
    await loadActiveMutes(FID);
    expect(mutesInUse()).toBeUndefined();

    await setMute({ fid: FID, kind: 'users', value: OTHER });
    // Straight away, in the same session, before anything is re-read.
    expect(mutedAuthorInUse(OTHER)).toBe(true);
    expect(mutesInUse()!.hidesAuthor(OTHER)).toBe(true);
    expect(mutesInUse()!.hidesAuthor(FID)).toBe(false);

    const query = mutesInUse()!;
    await setMute({ fid: FID, kind: 'words', value: 'spoilers' });
    expect(query.hidesText('spoilers ahead')).toBe(true);
    expect(query.hidesText('nothing to see')).toBe(false);
  });

  it('hides a blocked author, and never the reader’s own casts', async () => {
    await loadActiveMutes(FID);
    await setMute({
      fid: FID,
      kind: 'blocks',
      value: OTHER,
      until: Date.now() + 60_000,
    });

    expect(mutedAuthorInUse(OTHER)).toBe(true);
    expect(mutedAuthorInUse(FID)).toBe(false);
    expect(mutedAuthorInUse(undefined)).toBe(false);
  });

  it('survives a reload: the list is read back from storage', async () => {
    await loadActiveMutes(FID);
    await setMute({ fid: FID, kind: 'users', value: OTHER });

    // A reload is a fresh module state reading the same storage.
    resetActiveMutes();
    expect(mutesInUse()).toBeUndefined();

    await loadActiveMutes(FID);
    expect(mutedAuthorInUse(OTHER)).toBe(true);
    expect(await loadMutes(FID)).toEqual({
      words: [],
      users: [{ v: OTHER }],
      blocks: [],
    });
  });

  it('does not hand one account’s list to the next', async () => {
    await loadActiveMutes(FID);
    await setMute({ fid: FID, kind: 'users', value: OTHER });

    await loadActiveMutes(999);
    expect(mutedAuthorInUse(OTHER)).toBe(false);
  });

  it('only answers for the FID whose list is in use', async () => {
    await saveMutes(OTHER, { words: [], users: [{ v: 3 }], blocks: [] });
    await loadActiveMutes(FID);

    // The other account's list is on disk but not in use: nothing is hidden.
    expect(mutesInUse()).toBeUndefined();
    await setMute({ fid: FID, kind: 'users', value: 42 });
    expect(await loadMutes(OTHER)).toEqual({
      words: [],
      users: [{ v: 3 }],
      blocks: [],
    });
  });

  it('tells subscribers when the list changes, and not when it does not', async () => {
    await loadActiveMutes(FID);
    const seen = vi.fn();
    const unsubscribe = subscribeToMutes(seen);

    await setMute({ fid: FID, kind: 'words', value: 'spoilers' });
    expect(seen).toHaveBeenCalledTimes(1);

    // Re-loading the same list is not a change.
    await loadActiveMutes(FID);
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    await setMute({ fid: FID, kind: 'words', value: 'other' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('lifts a mute, and says when a timed one ends', async () => {
    // A date this list is still holding: a past one is dropped as expired, which
    // the test above already measures.
    const until = Date.UTC(2026, 10, 3, 14, 20, 0);
    await loadActiveMutes(FID);
    await setMute({ fid: FID, kind: 'users', value: OTHER, until });

    expect(liveEntry(getActiveMutes()!.users, OTHER)).toEqual({
      v: OTHER,
      until,
    });
    expect(untilText(until)).toMatch(/^until /);
    expect(untilText(undefined)).toBe('');

    await liftMute({ fid: FID, kind: 'users', value: OTHER });
    expect(mutedAuthorInUse(OTHER)).toBe(false);
  });
});
