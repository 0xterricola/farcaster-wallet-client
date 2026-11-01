/**
 * Cast drafts are this device's own state — so these tests pin the store, not a
 * mock of one.
 *
 * The decision (see `localDrafts.ts` and `hostedRoutes.ts`): a draft is what
 * someone typed and has not sent, kept in this browser, one list per signed-in
 * FID. What matters to a person is that "saved" means saved and that pressing
 * Cast no longer stops at a write that could never succeed. What matters to the
 * rest of the app is that the answers keep the hosted API's shapes, because the
 * hooks and the Drafts tab read those.
 */

import { describe, expect, it } from 'vitest';

import {
  answerLocalDraftRequest,
  LOCAL_DRAFT_LIMIT,
  LocalDraftStore,
  NO_ACCOUNT_SENTENCE,
  NO_CAST_SENTENCE,
  NO_STORAGE_SENTENCE,
} from '~/snapchain/nodeApi/localDrafts';

/** A `localStorage` of this test's own: same four methods, no browser. */
const fakeStorage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
};

const storeOn = (storage = fakeStorage()) => ({
  storage,
  store: new LocalDraftStore({ storage }),
});

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const STORM = {
  caststorm: {
    casts: [
      { text: 'a draft nobody sent', embeds: ['https://media.test/a.png'] },
    ],
  },
};

describe('the draft store on this device', () => {
  it('keeps a caststorm draft and reads it back with its own id', () => {
    const { store } = storeOn();

    const stored = store.storeCaststorm({
      fid: 3,
      caststorm: { casts: [{ text: 'half written' }] },
    });

    expect(stored?.draftId.length).toBeGreaterThan(0);
    expect(stored?.casts).toEqual([{ text: 'half written' }]);
    expect(store.caststorms(3)).toEqual([stored]);
  });

  it('updates in place when the composer saves over a draft it already has', () => {
    const { store } = storeOn();
    const first = store.storeCaststorm({
      fid: 3,
      caststorm: { casts: [{ text: 'first pass' }] },
    });

    const second = store.storeCaststorm({
      fid: 3,
      caststorm: { casts: [{ text: 'second pass' }], draftId: first?.draftId },
    });

    expect(second?.draftId).toBe(first?.draftId);
    expect(store.caststorms(3)).toHaveLength(1);
    expect(store.caststorms(3)[0]?.casts[0]?.text).toBe('second pass');
  });

  it('never shows one account the drafts of another', () => {
    const { store } = storeOn();

    store.storeCaststorm({ fid: 3, caststorm: { casts: [{ text: 'mine' }] } });

    expect(store.caststorms(4)).toEqual([]);
  });

  it('forgets a draft when the composer discards it, and says so when there was none', () => {
    const { store } = storeOn();
    const draft = store.storeCaststorm({
      fid: 3,
      caststorm: { casts: [{ text: 'gone soon' }] },
    });

    expect(store.discard(3, draft?.draftId ?? '')).toBe(true);
    expect(store.caststorms(3)).toEqual([]);
    expect(store.discard(3, 'no-such-draft')).toBe(false);
  });

  it('survives a value it cannot read, instead of rendering it', () => {
    const storage = fakeStorage({ 'fiddy:node-drafts:3': 'not json at all' });
    const store = new LocalDraftStore({ storage });

    expect(store.caststorms(3)).toEqual([]);
  });

  it('keeps the newest drafts and drops the rest rather than growing for ever', () => {
    const { store } = storeOn();

    for (let i = 0; i < LOCAL_DRAFT_LIMIT + 5; i += 1) {
      store.storeCaststorm({
        fid: 3,
        caststorm: { casts: [{ text: `d${i}` }] },
      });
    }

    const kept = store.caststorms(3);
    expect(kept).toHaveLength(LOCAL_DRAFT_LIMIT);
    expect(kept[0]?.casts[0]?.text).toBe(`d${LOCAL_DRAFT_LIMIT + 4}`);
  });
});

describe('the draft endpoints, answered from the device', () => {
  it('stores a caststorm and answers in the hosted API’s shape', async () => {
    const { store } = storeOn();

    const response = answerLocalDraftRequest(
      {
        method: 'POST',
        path: '/v2/draft-caststorms',
        body: STORM,
        fid: 3,
      },
      store,
    );

    expect(response?.status).toBe(200);
    const body = await json(response as Response);
    const draft = (
      body.result as { draft: { draftId: string; casts: unknown[] } }
    ).draft;
    expect(draft.draftId.length).toBeGreaterThan(0);
    expect(draft.casts).toEqual([
      { text: 'a draft nobody sent', embeds: ['https://media.test/a.png'] },
    ]);
    // The write went to the store, not to a shape of one.
    expect(store.caststorms(3)).toHaveLength(1);
  });

  it('lists drafts newest first, with the cursor field the client reads', async () => {
    const { store } = storeOn();
    for (const text of ['one', 'two']) {
      answerLocalDraftRequest(
        {
          method: 'POST',
          path: '/v2/draft-caststorms',
          body: { caststorm: { casts: [{ text }] } },
          fid: 3,
        },
        store,
      );
    }

    const response = answerLocalDraftRequest(
      { method: 'GET', path: '/v2/draft-caststorms', fid: 3 },
      store,
    );
    const body = await json(response as Response);

    expect(
      (body.result as { drafts: { casts: { text: string }[] }[] }).drafts.map(
        (draft) => draft.casts[0]?.text,
      ),
    ).toEqual(['two', 'one']);
    expect(body.next).toEqual({});
  });

  it('discards by id through DELETE, the call the composer makes after a cast', async () => {
    const { store } = storeOn();
    const stored = store.storeCaststorm({
      fid: 3,
      caststorm: { casts: [{ text: 'sent' }] },
    });

    const response = answerLocalDraftRequest(
      {
        method: 'DELETE',
        path: '/v2/draft-casts',
        body: { draftId: stored?.draftId },
        fid: 3,
      },
      store,
    );

    expect(await json(response as Response)).toEqual({
      result: { success: true },
    });
    expect(store.caststorms(3)).toEqual([]);
  });

  it('keeps a single-cast draft too (the rituals modal’s own endpoint)', async () => {
    const { store } = storeOn();

    const response = answerLocalDraftRequest(
      {
        method: 'POST',
        path: '/v2/draft-casts',
        body: { cast: { text: 'a daily ritual', channelKey: 'fiddy' } },
        fid: 3,
      },
      store,
    );

    expect(response?.status).toBe(200);
    const body = await json(response as Response);
    expect(
      (body.result as { draft: { cast: { text: string } } }).draft.cast.text,
    ).toBe('a daily ritual');
    expect(store.casts(3)).toHaveLength(1);
  });

  it('refuses a draft with no cast in it rather than storing an empty shell', async () => {
    const { store } = storeOn();

    const response = answerLocalDraftRequest(
      {
        method: 'POST',
        path: '/v2/draft-caststorms',
        body: { caststorm: { casts: [] } },
        fid: 3,
      },
      store,
    );

    expect(response?.status).toBe(400);
    expect(
      ((await json(response as Response)).errors as { message: string }[])[0]
        ?.message,
    ).toBe(NO_CAST_SENTENCE);
  });

  it('says that no account is signed in, rather than keeping an ownerless draft', async () => {
    const { store } = storeOn();

    const response = answerLocalDraftRequest(
      {
        method: 'POST',
        path: '/v2/draft-caststorms',
        body: STORM,
        fid: undefined,
      },
      store,
    );

    expect(response?.status).toBe(400);
    expect(
      ((await json(response as Response)).errors as { message: string }[])[0]
        ?.message,
    ).toBe(NO_ACCOUNT_SENTENCE);
  });

  it('says "nothing could be saved" when the browser allows no storage', async () => {
    const store = new LocalDraftStore({ storage: undefined });

    const response = answerLocalDraftRequest(
      { method: 'POST', path: '/v2/draft-caststorms', body: STORM, fid: 3 },
      store,
    );

    expect(response?.status).toBe(501);
    expect(
      ((await json(response as Response)).errors as { message: string }[])[0]
        ?.message,
    ).toBe(NO_STORAGE_SENTENCE);
  });

  it('leaves anything that is not a draft endpoint to someone else', () => {
    const { store } = storeOn();

    expect(
      answerLocalDraftRequest({ method: 'GET', path: '/v2/me', fid: 3 }, store),
    ).toBeUndefined();
  });
});
