/**
 * The two halves of a shared link: what we copy, and what we can open.
 *
 * A cast share used to copy `farcaster.xyz/<handle>/<prefix>`, which is
 * somebody else's page — fine when a fiddy.fun link unfurled as nothing and
 * could not be opened by this client either. Both of those changed in the same
 * release: `server/unfurl/` answers a cast URL with that cast's own card, and
 * the reader now asks this origin who wrote a cast it has never served
 * (`castAuthorHandoff.ts`), which is what makes a hash-only page render at all.
 *
 * So these tests hold the pair together, because either half alone is a
 * regression: a pretty link nobody can open, or a card for a page we do not
 * point anybody at.
 */

import { getFiddyCastUrl, getFiddyProfileUrl } from 'farcaster-client-data';
import { describe, expect, it } from 'vitest';

import {
  castAuthorUrl,
  fetchCastAuthorFromOrigin,
} from '~/snapchain/providers/castAuthorHandoff';

const HASH = `0x${'a'.repeat(40)}`;

const fakeFetch = (response: Response | Error) => {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    calls.push(String(input));
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('the link a share copies', () => {
  it('is this client’s own cast page, with the full hash in it', () => {
    expect(getFiddyCastUrl({ castHash: HASH })).toBe(
      `https://fiddy.fun/~/conversations/${HASH}`,
    );
    // The 10-character prefix upstream puts in a link is the unanswerable
    // route: this client reads it through /v2/user-thread-casts, which no
    // Snapchain node serves. The full hash is what a node can address.
    expect(getFiddyCastUrl({ castHash: HASH })).not.toContain(
      HASH.slice(0, 10) + '/',
    );
    expect(getFiddyCastUrl({ castHash: HASH })).not.toContain('farcaster.xyz');
  });

  it('is this client’s own profile page, by FID', () => {
    expect(getFiddyProfileUrl({ fid: 3 })).toBe(
      'https://fiddy.fun/~/profiles/3',
    );
    expect(getFiddyProfileUrl({ fid: 3 })).not.toContain('farcaster.xyz');
  });
});

describe('asking this origin who wrote a cast', () => {
  it('answers the FID the index holds', async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ hash: HASH, fid: 3 }));
    expect(
      await fetchCastAuthorFromOrigin({ hash: HASH, fetchImpl: impl }),
    ).toBe(3);
    expect(calls).toEqual([castAuthorUrl(HASH)]);
    // Same origin: the host's CSP is connect-src 'self', so this must not be an
    // absolute URL to anywhere else.
    expect(calls[0]).toBe(`/unfurl/cast-author/${HASH}`);
  });

  it('does not ask about a hash no node could address', async () => {
    for (const hash of ['0xdeadbeef', HASH.slice(0, 12), '', 'not-a-hash']) {
      const { impl, calls } = fakeFetch(jsonResponse({ fid: 3 }));
      expect(
        await fetchCastAuthorFromOrigin({ hash, fetchImpl: impl }),
      ).toBeUndefined();
      expect(calls).toEqual([]);
    }
  });

  it('answers undefined — never a guessed FID — for every way it can fail', async () => {
    const cases = [
      fakeFetch(jsonResponse({ hash: HASH, fid: null }, 404)),
      fakeFetch(jsonResponse({ hash: HASH, fid: 0 })),
      fakeFetch(jsonResponse({ why: 'no index knows that cast hash' }, 404)),
      fakeFetch(new Response('not json', { status: 200 })),
      fakeFetch(new Error('offline')),
    ];
    for (const { impl } of cases) {
      expect(
        await fetchCastAuthorFromOrigin({ hash: HASH, fetchImpl: impl }),
      ).toBeUndefined();
    }
  });

  it('gives up on a host that never answers, in words rather than a hang', async () => {
    // A fetch that honours the deadline it is given and then gives up, which is
    // what a real one does.
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      })) as unknown as typeof fetch;
    expect(
      await fetchCastAuthorFromOrigin({
        hash: HASH,
        fetchImpl: hanging,
        timeoutMs: 10,
      }),
    ).toBeUndefined();
  });
});
