/**
 * What happens when someone presses Cast, at the adapter.
 *
 * MEASURED before this (2026-10-21, headless Chrome, the real composer on a
 * live public node): the composer's pre-publish draft write
 * (`POST /v2/draft-caststorms`) was answered `501` and retried twice, and only
 * then did the submit reach `POST /v2/casts` — which is `hosted`, so nothing
 * was posted and the only thing on screen was "Failed to create cast". Two
 * things were wrong with that, and neither was "the submit never gets there":
 * a write that could never succeed sat in front of every Cast, and the refusal
 * a person finally saw had no reason in it.
 *
 * These tests pin the fix: the draft write really stores this device's draft
 * (and keeps the hosted shapes), the submit continues to the one endpoint that
 * genuinely cannot work without an app key, and that endpoint refuses in words
 * a person can read.
 */

import { describe, expect, it, vi } from 'vitest';

import { classifyHostedRequest } from '~/snapchain/nodeApi/hostedRoutes';
import { LocalDraftStore } from '~/snapchain/nodeApi/localDrafts';
import { createNodeBackedFetch } from '~/snapchain/nodeApi/nodeBackedFetch';
import { asSentence } from '~/snapchain/nodeApi/nodeCannotAnswer';

import { offlineEmbedKinds } from './fakeEmbedKinds';

const fakeStorage = (): Storage => {
  const map = new Map<string, string>();
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

const buildHarness = (fid: number | undefined = 3) => {
  const storage = fakeStorage();
  const drafts = new LocalDraftStore({ storage });
  const nodeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => fid,
    fetchImpl: nodeFetch as unknown as typeof fetch,
    drafts,
  });
  return { fetch: handle.fetch, drafts, storage, nodeFetch, log: handle.log };
};

const messageOf = async (response: Response): Promise<string> => {
  const body = (await response.json()) as {
    errors: { message: string }[];
  };
  return body.errors[0]?.message ?? '';
};

const CAST = {
  text: 'a cast nobody could send yet',
  embeds: ['https://media.test/api/fiddy/media/abc.png'],
};

describe('pressing Cast with the node-backed client', () => {
  it('classifies the draft write as this device’s own state', () => {
    expect(
      classifyHostedRequest({
        method: 'POST',
        path: '/~api/v2/draft-caststorms',
      }),
    ).toMatchObject({ kind: 'local', path: '/v2/draft-caststorms' });
    expect(
      classifyHostedRequest({
        method: 'DELETE',
        path: '/~api/v2/draft-casts',
      }),
    ).toMatchObject({ kind: 'local', path: '/v2/draft-casts' });
    // …and the submit itself as a write this client really makes: signed here
    // with the account's own app key and handed to a node (`nodeWrites.ts`).
    expect(
      classifyHostedRequest({ method: 'POST', path: '/~api/v2/casts' }),
    ).toMatchObject({ kind: 'write', path: '/v2/casts' });
  });

  it('stores the pre-publish draft on the device and answers 200, not 501', async () => {
    const { fetch: nodeBackedFetch, drafts, storage, log } = buildHarness();

    const response = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/draft-caststorms',
      {
        method: 'POST',
        body: JSON.stringify({ caststorm: { casts: [CAST] } }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { draft: { draftId: string } };
    };
    expect(body.result.draft.draftId.length).toBeGreaterThan(0);
    // The draft is really kept: this is the store the Drafts tab reads back.
    expect(drafts.caststorms(3)[0]?.casts[0]?.text).toBe(CAST.text);
    expect(storage.getItem('fiddy:node-drafts:3')).toContain(CAST.text);
    expect(log.at(-1)).toMatchObject({
      method: 'POST',
      kind: 'local',
      status: 200,
    });
  });

  it('reaches POST /v2/casts and is refused with the one step that is missing', async () => {
    const { fetch: nodeBackedFetch, nodeFetch, log } = buildHarness();

    const response = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/casts',
      { method: 'POST', body: JSON.stringify(CAST) },
    );

    expect(response.status).toBe(501);
    const message = await messageOf(response);
    // The sentence the composer shows after "The cast didn't post." — it names
    // the one step the reader can take ("Issue app key", on Advanced) and claims
    // nothing was sent.
    expect(message).toContain('Issue app key');
    expect(message).toContain('nothing was signed and nothing was sent');
    // Nothing was signed and nothing was submitted: without a key this device
    // cannot make a message at all, and a probe must not see one leave.
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(log.at(-1)).toMatchObject({
      method: 'POST',
      path: '/~api/v2/casts',
      kind: 'write',
      status: 501,
    });
  });

  it('gives the composer one sentence to put on screen, not an empty toast', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const response = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/casts',
      { method: 'POST', body: JSON.stringify(CAST) },
    );

    // What the composer's own copy does with it.
    const shown = `The cast didn't post. ${asSentence(await messageOf(response))}`;
    expect(shown).toMatch(/^The cast didn't post\. This device has no key/);
    expect(shown.endsWith('.')).toBe(true);
  });

  it('a draft written before a cast can be discarded afterwards, locally', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const stored = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/draft-caststorms',
      {
        method: 'POST',
        body: JSON.stringify({ caststorm: { casts: [CAST] } }),
      },
    );
    const draftId = (
      (await stored.json()) as { result: { draft: { draftId: string } } }
    ).result.draft.draftId;

    const discarded = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/draft-casts',
      { method: 'DELETE', body: JSON.stringify({ draftId }) },
    );

    expect(discarded.status).toBe(200);
    const listed = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/draft-caststorms',
      { method: 'GET' },
    );
    expect(
      ((await listed.json()) as { result: { drafts: unknown[] } }).result
        .drafts,
    ).toEqual([]);
  });

  it('says a draft could not be kept when this browser allows no storage', async () => {
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => 3,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      drafts: new LocalDraftStore({ storage: undefined }),
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/draft-caststorms',
      {
        method: 'POST',
        body: JSON.stringify({ caststorm: { casts: [CAST] } }),
      },
    );

    // "Saved" is never reported for a save that did not happen.
    expect(response.status).toBe(501);
    expect(await messageOf(response)).toContain('will not let Fiddy keep');
  });
});
