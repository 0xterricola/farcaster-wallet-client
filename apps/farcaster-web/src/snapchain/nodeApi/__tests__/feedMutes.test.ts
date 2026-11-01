/**
 * A node-assembled feed, the notifications a node derives, and the reader's own
 * mutes.
 *
 * Farcaster carries neither a mute list nor muted words, and a read node holds
 * nothing for either — so the only thing that can make "hide this person" true
 * of a node-assembled page is the reader holding the list and the read seam
 * consulting it. These tests drive the REAL page read through the recorded
 * fixture node (`fakeNodeFetch`) and the REAL store, so what is measured is the
 * seam's own behaviour rather than a stub of it:
 *
 *   - a muted author's casts are gone from a page,
 *   - a muted word removes exactly the casts carrying it, whole-word matched,
 *   - the reader's own casts are never hidden, whatever the list says,
 *   - nothing is hidden when the reader holds no list,
 *   - notifications a node derives are filtered by the same list (the node knows
 *     no mutes, so nobody upstream would apply one),
 *   - the list is asked for while the page is being read, not once per session.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
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
  loadActiveMutes,
  type MuteQuery,
  mutesInUse,
  resetActiveMutes,
  setMute,
  wordsRe,
} from '~/snapchain/mutePreferences';
import { NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';
import type { EmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch } from './fakeNodeFetch';

const NODE = 'http://node.test';
/** The account the recording belongs to, and the reader in these tests. */
const READER_FID = 3;

beforeEach(() => {
  store.clear();
  resetActiveMutes();
});

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * A reader over the recorded node.
 *
 * `mutes` defaults to the app's own answer — the store this module keeps in step
 * with storage — because that is what the seam is wired to. A test that wants to
 * ask a narrower question can hand its own predicates instead.
 */
const readerFor = (
  mutes: () => MuteQuery | undefined = mutesInUse,
): NodeBackedReads => {
  const fetchImpl = createFixtureNodeFetch();
  return new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds() as EmbedKindResolver,
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => READER_FID,
    mutes,
  });
};

/** The home feed of the recording: the reader's own casts. */
const readHome = (reads: NodeBackedReads) =>
  reads.readFeed({ feedKey: 'home', updateState: false });

/** A channel feed from the recording, whose casts are other people's. */
const readChannel = (reads: NodeBackedReads) =>
  reads.readFeed({ feedKey: 'dev', updateState: false });

/** The longest word in a text, so a test mutes something worth matching. */
const longestWord = (text: string): string =>
  text.split(/[^\p{L}\p{N}_$#]+/u).sort((a, b) => b.length - a.length)[0] ?? '';

const hideAuthors = (authors: number[]): MuteQuery => ({
  hidesAuthor: (fid) => fid !== undefined && authors.includes(fid),
  hidesText: () => false,
});

describe('the reader’s mutes narrow a node-assembled feed', () => {
  it('hides every cast of an author the reader muted, and keeps the rest', async () => {
    const page = await readChannel(readerFor());
    expect(page.items).toHaveLength(2);

    const muted = page.items[0]!.cast.author.fid;
    const kept = page.items.filter((item) => item.cast.author.fid !== muted);
    expect(kept).toHaveLength(1);

    const narrowed = await readChannel(readerFor(() => hideAuthors([muted])));

    expect(narrowed.items.map((item) => item.cast.author.fid)).toEqual(
      kept.map((item) => item.cast.author.fid),
    );
  });

  it('removes exactly the casts carrying a muted word', async () => {
    const page = await readChannel(readerFor());
    const word = longestWord(page.items[0]!.cast.text);
    expect(word.length).toBeGreaterThan(4);

    const re = wordsRe([word])!;
    const matching = page.items.filter((item) =>
      re.test(item.cast.text),
    ).length;
    expect(matching).toBe(1);

    const narrowed = await readChannel(
      readerFor(() => ({
        hidesAuthor: () => false,
        hidesText: (text) => re.test(text),
      })),
    );

    expect(narrowed.items).toHaveLength(page.items.length - matching);
    for (const item of narrowed.items) {
      expect(re.test(item.cast.text)).toBe(false);
    }
  });

  it('never hides the reader’s own casts, even with their own FID muted', async () => {
    const page = await readHome(readerFor());
    expect(page.items.length).toBeGreaterThan(10);
    for (const item of page.items) {
      expect(item.cast.author.fid).toBe(READER_FID);
    }

    // The store refuses to hide the reader's own FID, which is what stops a
    // mute from looking like the app had lost the reader's own posts.
    await loadActiveMutes(READER_FID);
    await setMute({ fid: READER_FID, kind: 'users', value: READER_FID });

    expect(mutesInUse()!.hidesAuthor(READER_FID)).toBe(false);
    expect((await readHome(readerFor())).items).toHaveLength(page.items.length);
  });

  it('hides nothing when the reader holds no list', async () => {
    const page = await readHome(readerFor());
    await loadActiveMutes(READER_FID);

    expect(mutesInUse()).toBeUndefined();
    expect((await readHome(readerFor())).items).toHaveLength(page.items.length);
  });

  it('applies a word the reader has just muted to the very next page', async () => {
    const page = await readChannel(readerFor());
    const word = longestWord(page.items[0]!.cast.text);

    await loadActiveMutes(READER_FID);
    await setMute({ fid: READER_FID, kind: 'words', value: word });

    // No reload and no cache invalidation in between: the seam asks the store,
    // and the store already holds what was just saved.
    const narrowed = await readChannel(readerFor());
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.items[0]!.cast.text).not.toContain(word);
  });

  it('asks the reader’s own list while it is reading the page', async () => {
    const mutes = vi.fn(() => undefined);
    await readHome(readerFor(mutes));

    expect(mutes).toHaveBeenCalled();
  });
});

describe('the same list filters the notifications a node derives', () => {
  it('drops the mention of a cast carrying a muted word', async () => {
    const reads = readerFor();
    const before = (await reads.readNotifications({ fid: READER_FID })).find(
      (group) => group.type === 'cast-mention',
    );
    const mentions = before?.previewItems.filter(
      (item) => item.content?.cast.text !== undefined,
    );
    expect(mentions?.length ?? 0).toBeGreaterThan(0);

    const word = longestWord(mentions![0]!.content!.cast.text);
    const re = wordsRe([word])!;

    const after = (
      await readerFor(() => ({
        hidesAuthor: () => false,
        hidesText: (text) => re.test(text),
      })).readNotifications({ fid: READER_FID })
    ).find((group) => group.type === 'cast-mention');

    // Whatever survives, carries no muted word — the node derived these and
    // knows nothing about the reader's list, so nobody else would apply it.
    for (const item of after?.previewItems ?? []) {
      expect(re.test(item.content!.cast.text)).toBe(false);
    }
    expect(after?.totalItemCount ?? 0).toBeLessThan(before!.totalItemCount);
  });

  it('drops a muted author’s follow notification', async () => {
    const before = (
      await readerFor().readNotifications({ fid: READER_FID })
    ).find((group) => group.type === 'follow');
    expect(before!.totalItemCount).toBeGreaterThan(0);

    const actor = before!.previewItems[0]!.actor.fid;
    const after = (
      await readerFor(() => hideAuthors([actor])).readNotifications({
        fid: READER_FID,
      })
    ).find((group) => group.type === 'follow');

    expect(after?.totalItemCount ?? 0).toBe(before!.totalItemCount - 1);
  });
});
