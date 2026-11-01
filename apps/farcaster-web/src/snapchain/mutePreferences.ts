/**
 * What this account hides, and for how long: people, and words.
 *
 * Farcaster has no mute list and no muted words — neither is a protocol message,
 * and a read node holds nothing for either (`hostedRoutes.ts` refuses
 * `/v2/get-muted-users` and `/v2/get-muted-keywords` in exactly those words).
 * So the list has to live WITH THE READER, which is what this module is: it is
 * kept per FID in this browser, and the read seam consults it *during* a read.
 *
 * Same two layers as the node choice (`nodeChoice.ts`) and the client filter
 * (`clientFilterPreferences.ts`), and for the same reason:
 *
 *   storage (`loadMutes` / `saveMutes`) — per FID, survives reloads, validated on read
 *   active  (here)                      — this tab's list, in memory
 *
 * The read seam (`~/snapchain/nodeApi/reads`) has to answer "does this reader
 * want to see this?" while it assembles a page — without suspending and without
 * awaiting storage, because localforage is asynchronous and a lookup inside a
 * read cannot be one. `mutesInUse()` is that synchronous answer, kept in step
 * with storage by `loadActiveMutes` (when the FID is known) and by `setMute` /
 * `liftMute` (on a change). A change made here is therefore visible to the very
 * next read, with no reload and no cache to invalidate.
 *
 * EXPIRY IS EVALUATED ON READ, never by a timer: a mute that ran out while the
 * tab was closed is simply not live the next time the list is read, and no
 * `setTimeout` has to survive a sleeping tab for the list to be honest.
 *
 * WHY THE STATE SITS HERE AND NOT ON A SERVER
 *
 * Upstream quilcast (0.23.0, `src/mutes.ts`, MIT, backmeupplz/quilcast
 * @3c7412dd7d48) keeps the same list and mirrors it to their own server, one
 * file per FID signed with the account's key. The shape is borrowed — the reader
 * holds the list, the read path consults it — and so are `cleanMutes` and
 * `wordsRe` from their `src/shared.ts`. Their server half is NOT ported: this
 * client's authorisation shape is different (app keys and per-provider sessions,
 * see `nodeWrites.ts`), and the local store is what makes hiding work when the
 * provider chain has no index in it at all.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

const MUTES_NAMESPACE = 'snapchain_mutes';

/** The list a mute belongs to. */
export type MuteKind = 'users' | 'blocks' | 'words';

/**
 * One entry, and when it stops applying.
 *
 * `until` is ms since the epoch. ABSENT is "until it is lifted", which is a
 * different thing from a timestamp that has passed: only the first is a
 * decision the reader is still holding.
 */
export interface Timed<V> {
  v: V;
  until?: number;
}

/**
 * The reader's own list.
 *
 * People and words are one store on purpose: one setting screen changes one of
 * them at a time, and one save is visible to the next read whatever changed.
 */
export interface Mutes {
  /** Words the reader does not want to see, lower-cased and trimmed. */
  words: Timed<string>[];
  /** FIDs the reader has hidden (muted). */
  users: Timed<number>[];
  /** FIDs the reader has blocked. */
  blocks: Timed<number>[];
}

export const EMPTY_MUTES: Mutes = { words: [], users: [], blocks: [] };

/**
 * What a stored list is allowed to be, whoever wrote it.
 *
 * Storage is user-editable and survives upgrades, so a list is clamped rather
 * than trusted: a hostile entry must not be able to make the matcher expensive
 * (one alternation per word, compiled once) or the list unopenable.
 */
export const MUTE_WORD_LIMIT = 300;
export const MUTE_FID_LIMIT = 3000;
export const MUTE_WORD_MAX_LENGTH = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a hide lasts, as the menu offers it. `ms` absent is "until I lift
 * it" — the only choice that needs no clock to stay true.
 */
export const MUTE_SPANS: { label: string; ms?: number }[] = [
  { label: 'For a day', ms: DAY_MS },
  { label: 'For a week', ms: 7 * DAY_MS },
  { label: 'For a month', ms: 30 * DAY_MS },
  { label: 'Until I lift it' },
];

/** Whether an entry is still running at `now`. */
export const muteIsLive = (entry: Timed<unknown>, now: number): boolean =>
  entry.until === undefined || entry.until > now;

/** The running entry for `value`, if the reader is still holding one. */
export const liveEntry = <V>(
  entries: Timed<V>[],
  value: V,
  now: number = Date.now(),
): Timed<V> | undefined =>
  entries.find((entry) => entry.v === value && muteIsLive(entry, now));

/** A word as it is stored: trimmed, lower-cased, and never empty. */
const mutedWord = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase().slice(0, MUTE_WORD_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
};

const mutedFid = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

/**
 * A stored list cut down to what is allowed and still running: one entry per
 * word or person (the later one winning), expired entries dropped, and input a
 * hostile page could not have written through the UI simply refused.
 *
 * Runs on every read of storage, so a list that has aged since it was written
 * is cleaned as it is loaded rather than by a sweep that has to remember to run.
 */
export function cleanMutes(raw: unknown, now: number = Date.now()): Mutes {
  const list = <V>(
    entries: unknown,
    read: (value: unknown) => V | undefined,
    max: number,
  ): Timed<V>[] => {
    const out = new Map<V, Timed<V>>();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const candidate = entry as Partial<Timed<unknown>> | null | undefined;
      const value = read(candidate?.v);
      if (value === undefined) {
        continue;
      }
      const until =
        typeof candidate?.until === 'number' &&
        Number.isSafeInteger(candidate.until) &&
        candidate.until > 0
          ? candidate.until
          : undefined;
      const timed: Timed<V> =
        until === undefined ? { v: value } : { v: value, until };
      if (!muteIsLive(timed, now)) {
        continue;
      }
      out.set(value, timed);
    }
    return [...out.values()].slice(-max);
  };

  const source = (raw ?? {}) as Partial<Record<MuteKind, unknown>>;
  return {
    words: list(source.words, mutedWord, MUTE_WORD_LIMIT),
    users: list(source.users, mutedFid, MUTE_FID_LIMIT),
    blocks: list(source.blocks, mutedFid, MUTE_FID_LIMIT),
  };
}

/**
 * One pattern for every muted word: whole words, any case, so `$based` does not
 * catch `$basedgod` and `gm` does not catch `gmail`.
 *
 * "Whole word" is decided by what sits either side of a match — a letter, a
 * number or an underscore means the word runs on — and the character BEFORE a
 * match is consumed rather than looked behind (`(?:^|[^\p{L}\p{N}_])`), because
 * a lookbehind is not available in every browser this client supports.
 *
 * Chinese, Japanese and Korean are written without spaces between words, so
 * there is no boundary to anchor to and those words match anywhere. They are
 * alternated after the bounded ones in a single expression, rebuilt only when
 * the list changes (see `mutedMatcher`).
 *
 * Dependency-free on purpose: a plain RegExp over the reader's own list, so no
 * library lands in the entry chunk for this.
 */
export function wordsRe(words: string[]): RegExp | null {
  const escaped = (word: string): string =>
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isCjk = (word: string): boolean =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      word,
    );
  const bounded = words.filter((word) => !isCjk(word)).map(escaped);
  const unbounded = words.filter(isCjk).map(escaped);
  const parts = [
    ...(bounded.length > 0
      ? [`(?:^|[^\\p{L}\\p{N}_])(?:${bounded.join('|')})(?![\\p{L}\\p{N}_])`]
      : []),
    ...unbounded,
  ];
  return parts.length > 0 ? new RegExp(parts.join('|'), 'iu') : null;
}

/**
 * When a timed hide ends, as a settings row says it: "until 3 Sep, 14:20".
 *
 * An entry with no end says nothing at all — "until I lift it" is that row's own
 * label, and repeating it in the same line would only be noise.
 */
export const untilText = (until?: number): string =>
  until === undefined || until <= 0
    ? ''
    : `until ${new Date(until).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}`;

// --------------------------------------------------------------------- active

/** The list in use, and whose it is. */
export interface ActiveMutes extends Mutes {
  fid: number;
}

let active: ActiveMutes | null = null;
const listeners = new Set<() => void>();

/**
 * The matcher in force.
 *
 * Rebuilt when the words change, when the reuse window has passed, or when the
 * earliest end among the running words has passed — so a word that lapses stops
 * matching AT the moment it lapses rather than up to a minute later, and a list
 * that never changes is still compiled at most once a minute.
 */
let matcher:
  | { wordsKey: string; at: number; rebuildAt: number; re: RegExp | null }
  | undefined;

const MATCHER_REUSE_MS = 60_000;

const emit = (): void => {
  listeners.forEach((listener) => listener());
};

const asStored = ({ words, users, blocks }: ActiveMutes): Mutes => ({
  words,
  users,
  blocks,
});

const sameList = (a: Mutes, b: Mutes): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const setActive = (next: ActiveMutes | null): void => {
  const same =
    active === next ||
    (active !== null &&
      next !== null &&
      active.fid === next.fid &&
      sameList(asStored(active), asStored(next)));
  if (same) {
    return;
  }
  active = next;
  emit();
};

/** The list in use, or `null` when none has been loaded. */
export const getActiveMutes = (): ActiveMutes | null => active;

export const subscribeToMutes = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Forget what was loaded.
 *
 * The account is what the list belongs to, so a session that ends must not leave
 * the next reader hiding somebody on a previous account's say-so. (Sign-out
 * leaves the address for the front door, which reloads the app — this is for the
 * tests and for any future in-place account switch.)
 */
export const resetActiveMutes = (): void => setActive(null);

// -------------------------------------------------------------------- storage

const mutesKey = (fid: number): string => `${MUTES_NAMESPACE}_${fid}`;

/** This FID's stored list, cleaned as it is read. */
export const loadMutes = async (fid: number): Promise<Mutes> =>
  cleanMutes(await getItem<unknown>({ key: mutesKey(fid), fallback: null }));

export const saveMutes = async (fid: number, mutes: Mutes): Promise<void> => {
  await setItem({ key: mutesKey(fid), value: cleanMutes(mutes) });
};

export const clearMutes = (fid: number): Promise<void> =>
  deleteItem(mutesKey(fid));

/** Read this FID's list and make it the one in use. */
export const loadActiveMutes = async (fid: number): Promise<ActiveMutes> => {
  const next: ActiveMutes = { fid, ...(await loadMutes(fid)) };
  setActive(next);
  return next;
};

/** The list to change: the loaded one when it is this FID's, storage otherwise. */
const currentFor = async (fid: number): Promise<Mutes> =>
  active?.fid === fid ? asStored(active) : await loadMutes(fid);

const withEntries = (
  mutes: Mutes,
  kind: MuteKind,
  entries: Timed<string | number>[],
): Mutes => {
  const words = entries as Timed<string>[];
  const fids = entries as Timed<number>[];
  if (kind === 'words') {
    return { ...mutes, words };
  }
  return kind === 'blocks'
    ? { ...mutes, blocks: fids }
    : { ...mutes, users: fids };
};

const entriesOf = (mutes: Mutes, kind: MuteKind): Timed<string | number>[] =>
  kind === 'words'
    ? mutes.words
    : kind === 'blocks'
      ? mutes.blocks
      : mutes.users;

const normalized = (
  kind: MuteKind,
  value: string | number,
): string | number | undefined =>
  kind === 'words' ? mutedWord(value) : mutedFid(value);

const persist = async (fid: number, mutes: Mutes): Promise<ActiveMutes> => {
  await saveMutes(fid, mutes);
  const next: ActiveMutes = { fid, ...cleanMutes(mutes) };
  setActive(next);
  return next;
};

/**
 * Hide `value` until `until` (ms; omitted is until it is lifted).
 *
 * The change is stored first and applied second: the list the seam reads is
 * always the list on disk, so a write that fails leaves nothing half-applied.
 */
export const setMute = async ({
  fid,
  kind,
  value,
  until,
}: {
  fid: number;
  kind: MuteKind;
  value: string | number;
  until?: number;
}): Promise<ActiveMutes> => {
  const current = await currentFor(fid);
  const entry = normalized(kind, value);
  if (entry === undefined) {
    return persist(fid, current);
  }
  const timed: Timed<string | number> =
    until === undefined ? { v: entry } : { v: entry, until };
  const rest = entriesOf(current, kind).filter((held) => held.v !== entry);
  return persist(fid, withEntries(current, kind, [...rest, timed]));
};

/** Stop hiding `value`, whether it ran out or not. */
export const liftMute = async ({
  fid,
  kind,
  value,
}: {
  fid: number;
  kind: MuteKind;
  value: string | number;
}): Promise<ActiveMutes> => {
  const current = await currentFor(fid);
  const entry = normalized(kind, value);
  const rest = entriesOf(current, kind).filter((held) => held.v !== entry);
  return persist(fid, withEntries(current, kind, rest));
};

// ----------------------------------------------------------------- the seam

/** The words still running, as the matcher wants them. */
const liveWords = (mutes: Mutes, now: number): string[] =>
  mutes.words.filter((entry) => muteIsLive(entry, now)).map((entry) => entry.v);

const mutedMatcher = (mutes: Mutes, now: number): RegExp | null => {
  const live = mutes.words.filter((entry) => muteIsLive(entry, now));
  const words = live.map((entry) => entry.v);
  const wordsKey = JSON.stringify(words);
  // The earliest moment this list changes again by itself: a word that runs out
  // stops matching at that instant, not at the next reuse window.
  const rebuildAt = live.reduce(
    (earliest, entry) =>
      entry.until !== undefined && entry.until < earliest
        ? entry.until
        : earliest,
    Number.POSITIVE_INFINITY,
  );
  if (
    matcher &&
    matcher.wordsKey === wordsKey &&
    matcher.at > now - MATCHER_REUSE_MS &&
    now < matcher.rebuildAt
  ) {
    return matcher.re;
  }
  const re = wordsRe(words);
  matcher = { wordsKey, at: now, rebuildAt, re };
  return re;
};

/**
 * Is this author's work hidden from a feed?
 *
 * A mute and a block both hide, and the reader's OWN casts are never hidden —
 * blocking yourself is not a thing, and a mute that hid your own posts would
 * look like the app had lost them.
 *
 * The one place a mute does NOT hide is the muted person's own profile: mute is
 * not block, so their profile stays readable when you deliberately go and look.
 * Our feeds and notifications never render that surface — a profile is read
 * whole, on purpose — so the exception is honoured where it can be seen, in the
 * quote placeholder (`~/components/attachments/QuoteCast`).
 */
export const mutedAuthorInUse = (fid: number | undefined): boolean => {
  if (!active || fid === undefined || fid === active.fid) {
    return false;
  }
  const now = Date.now();
  const holds = (entries: Timed<number>[]): boolean =>
    entries.some((entry) => entry.v === fid && muteIsLive(entry, now));
  return holds(active.blocks) || holds(active.users);
};

/** Does this text carry a word the reader does not want to see? */
export const mutedWordInUse = (text: string): boolean => {
  if (!active || text.length === 0) {
    return false;
  }
  const re = mutedMatcher(active, Date.now());
  return re !== null && re.test(text);
};

/**
 * What the read seam asks for: the two questions a page needs answering, or
 * `undefined` for "nothing is hidden" — which covers both "no list has been
 * loaded" and "every entry in it has run out". Both mean the same thing to a
 * page, and neither may be invented as a filter that hides somebody's casts.
 */
export interface MuteQuery {
  /** True when this author's casts stay out of a feed. */
  hidesAuthor: (fid: number | undefined) => boolean;
  /** True when this text carries a hidden word. */
  hidesText: (text: string) => boolean;
}

export const mutesInUse = (): MuteQuery | undefined => {
  if (!active) {
    return undefined;
  }
  const now = Date.now();
  const anyLive =
    liveWords(active, now).length > 0 ||
    active.users.some((entry) => muteIsLive(entry, now)) ||
    active.blocks.some((entry) => muteIsLive(entry, now));
  if (!anyLive) {
    return undefined;
  }
  return { hidesAuthor: mutedAuthorInUse, hidesText: mutedWordInUse };
};
