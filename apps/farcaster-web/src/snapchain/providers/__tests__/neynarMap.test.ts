/**
 * Neynar's translation, as tests.
 *
 * Two things are being protected here. First, the shapes: the pages read
 * `ApiUser`/`ApiCast`, and a Neynar answer has to arrive as those or the
 * profiles and threads break in ways nobody would notice until a render. Second,
 * the refusals: Neynar genuinely cannot serve the feed, notifications or search
 * for this client, and a request for one must say so by name instead of coming
 * back empty.
 */

import { describe, expect, it } from 'vitest';

import {
  answerFromNeynar,
  apiCastFromNeynar,
  apiUserFromNeynar,
  neynarCallFor,
  neynarMeCall,
  threadCastsFromNeynar,
} from '~/snapchain/providers/neynarMap';

const NEYNAR_USER = {
  fid: 3,
  username: 'dwr',
  display_name: 'Dan Romero',
  pfp_url: 'https://example.com/pfp.png',
  follower_count: 121_250,
  following_count: 78,
  profile: { bio: { text: 'Interested in technology' } },
  verified_addresses: {
    eth_addresses: ['0x6ce09ed5526de4afe4a981ad86d17b2f5c92fea5'],
  },
};

const NEYNAR_CAST = {
  hash: '0x5c5b64edc095ec945bb85cd7f5eb31e7ca187045',
  thread_hash: '0x5c5b64edc095ec945bb85cd7f5eb31e7ca187045',
  parent_hash: null,
  parent_url: 'https://farcaster.group/memes',
  author: {
    fid: 218957,
    username: 'genuinejack',
    display_name: 'GENUINE JACK',
  },
  text: 'hello world',
  timestamp: '2026-10-20T20:00:00.000Z',
  replies: { count: 8 },
  reactions: { likes_count: 43, recasts_count: 5 },
  embeds: [
    { url: 'https://example.com/photo.png' },
    { url: 'https://example.com/post' },
  ],
  channel: { id: 'memes', name: 'Memes' },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('apiUserFromNeynar', () => {
  it('builds the profile shape the pages read', () => {
    const user = apiUserFromNeynar(NEYNAR_USER);
    expect(user.fid).toBe(3);
    expect(user.username).toBe('dwr');
    expect(user.displayName).toBe('Dan Romero');
    expect(user.followerCount).toBe(121_250);
    expect(user.profile.bio.text).toBe('Interested in technology');
    // Neynar's claim about the image host is not this client's claim, so it is
    // carried as the neutral value, never assumed verified.
    expect(user.pfp).toEqual({
      url: 'https://example.com/pfp.png',
      verified: false,
    });
  });

  it('falls back to the handle, then to the fid, when there is no display name', () => {
    expect(apiUserFromNeynar({ fid: 5, username: 'someone' }).displayName).toBe(
      'someone',
    );
    expect(apiUserFromNeynar({ fid: 5 }).displayName).toBe('fid 5');
  });
});

describe('apiCastFromNeynar', () => {
  it('builds the cast shape the pages read, timestamps in milliseconds', () => {
    const cast = apiCastFromNeynar(NEYNAR_CAST);
    expect(cast.hash).toBe(NEYNAR_CAST.hash);
    expect(cast.text).toBe('hello world');
    expect(cast.timestamp).toBe(Date.parse('2026-10-20T20:00:00.000Z'));
    expect(cast.reactions?.count).toBe(43);
    expect(cast.recasts?.count).toBe(5);
    expect(cast.replies?.count).toBe(8);
    expect(cast.author.fid).toBe(218957);
    expect(cast.castType).toBe('root-cast');
    expect(cast.parentUrl).toBe('https://farcaster.group/memes');
  });

  it('sorts embeds into images and links the way the renderer expects', () => {
    const cast = apiCastFromNeynar(NEYNAR_CAST);
    expect(cast.embeds?.images?.[0]?.url).toBe('https://example.com/photo.png');
    expect(cast.embeds?.urls?.[0]?.openGraph.url).toBe(
      'https://example.com/post',
    );
  });

  it('calls a cast with a parent a reply', () => {
    const cast = apiCastFromNeynar({ ...NEYNAR_CAST, parent_hash: '0xparent' });
    expect(cast.castType).toBe('reply-cast');
    expect(cast.parentHash).toBe('0xparent');
  });
});

describe('threadCastsFromNeynar', () => {
  it('reads parents, then the root, then replies', () => {
    const casts = threadCastsFromNeynar({
      cast: {
        ...NEYNAR_CAST,
        chronological_parent_casts: [{ ...NEYNAR_CAST, hash: '0xparent' }],
        direct_replies: [{ ...NEYNAR_CAST, hash: '0xreply' }],
      },
    });
    expect(casts.map((cast) => cast.hash)).toEqual([
      '0xparent',
      NEYNAR_CAST.hash,
      '0xreply',
    ]);
  });

  it('answers an empty list for a conversation it cannot read', () => {
    expect(threadCastsFromNeynar(undefined)).toEqual([]);
  });
});

describe('neynarCallFor', () => {
  const params = (pairs: Record<string, string>): URLSearchParams =>
    new URLSearchParams(pairs);

  it('maps the profile reads onto Neynar’s own endpoints', () => {
    expect(
      neynarCallFor({
        path: '/v2/user-by-fid',
        searchParams: params({ fid: '3' }),
      }),
    ).toEqual({
      url: 'https://api.neynar.com/v2/farcaster/user/bulk?fids=3',
      kind: 'user',
    });
    expect(
      neynarCallFor({
        path: '/v2/user-by-username',
        searchParams: params({ username: 'dwr' }),
      }),
    ).toEqual({
      url: 'https://api.neynar.com/v2/farcaster/user/by_username?username=dwr',
      kind: 'user',
    });
    expect(
      neynarCallFor({
        path: '/v2/profile-casts',
        searchParams: params({ fid: '3', limit: '10' }),
      }),
    ).toEqual({
      url: 'https://api.neynar.com/v2/farcaster/feed/user/casts?fid=3&limit=10',
      kind: 'casts',
    });
    expect(
      neynarCallFor({
        path: '/v2/thread-casts',
        searchParams: params({ castHash: '0xabc' }),
      }),
    ).toEqual({
      url: 'https://api.neynar.com/v2/farcaster/cast/conversation?identifier=0xabc&type=hash&reply_depth=1',
      kind: 'thread',
    });
    expect(
      neynarCallFor({
        path: '/v2/verifications',
        searchParams: params({ fid: '3' }),
      }),
    ).toEqual({
      url: 'https://api.neynar.com/v2/farcaster/user/bulk?fids=3',
      kind: 'verifications',
    });
  });

  it('refuses the surfaces Neynar does not serve, and refuses them as null', () => {
    expect(
      neynarCallFor({ path: '/v2/feed-items', searchParams: params({}) }),
    ).toBeNull();
    expect(
      neynarCallFor({ path: '/v2/unseen', searchParams: params({}) }),
    ).toBeNull();
    expect(
      neynarCallFor({
        path: '/v1/notifications-for-tab',
        searchParams: params({}),
      }),
    ).toBeNull();
    expect(
      neynarCallFor({ path: '/v2/search-casts', searchParams: params({}) }),
    ).toBeNull();
  });

  it('refuses a read whose own parameters are missing', () => {
    expect(
      neynarCallFor({ path: '/v2/user-by-fid', searchParams: params({}) }),
    ).toBeNull();
  });

  it('builds the /v2/me call from the signed-in fid only', () => {
    expect(neynarMeCall({ fid: 7 }).url).toContain('fids=7');
  });
});

describe('answerFromNeynar', () => {
  it('answers a declined read with a sentence that names Neynar', async () => {
    const response = await answerFromNeynar({
      path: '/v2/feed-items',
      searchParams: new URLSearchParams(),
      signedInFid: 3,
      apiKey: 'a-key',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain(
      'Neynar cannot serve /v2/feed-items',
    );
    expect(body.errors[0]!.message).toContain('need a node');
  });

  it('answers /v2/me from the signed-in fid, in the shape the shell reads', async () => {
    const response = await answerFromNeynar({
      path: '/v2/me',
      searchParams: new URLSearchParams(),
      signedInFid: 3,
      apiKey: 'a-key',
      fetchImpl: (async () =>
        jsonResponse({ users: [NEYNAR_USER] })) as unknown as typeof fetch,
    });
    const body = (await response.json()) as {
      result: { user: { fid: number }; enabledFeatureFlags: unknown[] };
    };
    expect(response.status).toBe(200);
    expect(body.result.user.fid).toBe(3);
    expect(body.result.enabledFeatureFlags).toEqual([]);
  });

  it('answers a profile read with the envelope the profile page reads', async () => {
    const response = await answerFromNeynar({
      path: '/v2/user-by-fid',
      searchParams: new URLSearchParams({ fid: '3' }),
      signedInFid: 3,
      apiKey: 'a-key',
      fetchImpl: (async () =>
        jsonResponse({ users: [NEYNAR_USER] })) as unknown as typeof fetch,
    });
    const body = (await response.json()) as {
      result: {
        user: { fid: number };
        collectionsOwned: unknown[];
        extras: { fid: number };
      };
    };
    expect(body.result.user.fid).toBe(3);
    expect(body.result.collectionsOwned).toEqual([]);
    expect(body.result.extras.fid).toBe(3);
  });

  it('turns a refused key into our own sentence, not Neynar’s raw error', async () => {
    const response = await answerFromNeynar({
      path: '/v2/user-by-fid',
      searchParams: new URLSearchParams({ fid: '3' }),
      signedInFid: 3,
      apiKey: 'deliberately-wrong-key',
      fetchImpl: (async () =>
        jsonResponse(
          { message: 'Incorrect or missing API key' },
          401,
        )) as unknown as typeof fetch,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('Neynar refused your API key');
  });

  it('sends the key in a header and never in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ users: [NEYNAR_USER] });
    }) as unknown as typeof fetch;
    await answerFromNeynar({
      path: '/v2/user-by-fid',
      searchParams: new URLSearchParams({ fid: '3' }),
      signedInFid: 3,
      apiKey: 'a-secret-key',
      fetchImpl,
    });
    expect(calls[0]!.url).not.toContain('a-secret-key');
    expect(
      (calls[0]!.init?.headers as Record<string, string>)['x-api-key'],
    ).toBe('a-secret-key');
  });

  it('answers a never-answered call with a deadline, not a hang', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const response = await answerFromNeynar({
      path: '/v2/user-by-fid',
      searchParams: new URLSearchParams({ fid: '3' }),
      signedInFid: 3,
      apiKey: 'a-key',
      fetchImpl,
      timeoutMs: 20,
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('did not answer within 0.02s');
  });
});

/**
 * The reads only an index can answer — the ones the 501 sweep found shrugging.
 *
 * Measured live (2026-10-22, this build's own key): Neynar answers all four, so
 * a shrug was never the honest answer for them. What is pinned here is the
 * shape each one must arrive in (the surfaces read `result.quotes`,
 * `result.casts`, `result.users`, `result.channels`) and that a request with
 * nothing to look up never becomes a call at all.
 */
describe('the reads an index answers, and a node cannot', () => {
  const asFetch = (body: unknown) =>
    (async () => jsonResponse(body)) as unknown as typeof fetch;

  it('asks Neynar with the route’s own parameters', () => {
    const quotes = neynarCallFor({
      path: '/v2/cast-quotes',
      searchParams: new URLSearchParams({
        castHash: NEYNAR_CAST.hash,
        limit: '10',
      }),
    });
    expect(quotes?.kind).toBe('index');
    expect(quotes?.shape).toBe('cast-quotes');
    expect(quotes?.url).toContain('/v2/farcaster/cast/quotes?identifier=');
    expect(quotes?.url).toContain('type=hash');

    const liked = neynarCallFor({
      path: '/v2/user-liked-casts',
      searchParams: new URLSearchParams({ fid: '3' }),
    });
    expect(liked?.shape).toBe('liked-casts');
    expect(liked?.url).toContain(
      '/v2/farcaster/reactions/user?fid=3&type=likes',
    );

    // Both spellings of the search term reach the same call: the surface's box
    // sends `q`, the fork's generated client sends `query`.
    const users = neynarCallFor({
      path: '/v2/search-users',
      searchParams: new URLSearchParams({ query: 'dwr' }),
    });
    expect(users?.shape).toBe('search-users');
    expect(users?.url).toContain('/v2/farcaster/user/search?q=dwr');

    const channels = neynarCallFor({
      path: '/v2/search-channels',
      searchParams: new URLSearchParams({ q: 'ai' }),
    });
    expect(channels?.shape).toBe('search-channels');
    expect(channels?.url).toContain('/v2/farcaster/channel/search?q=ai');
  });

  it('makes no call at all for a question with nothing in it', () => {
    for (const path of [
      '/v2/cast-quotes',
      '/v2/user-liked-casts',
      '/v2/search-users',
      '/v2/search-channels',
    ]) {
      expect(
        neynarCallFor({ path, searchParams: new URLSearchParams() }),
      ).toBeNull();
    }
  });

  it('shapes each answer into the envelope its surface reads', async () => {
    const quotes = await answerFromNeynar({
      path: '/v2/cast-quotes',
      searchParams: new URLSearchParams({ castHash: NEYNAR_CAST.hash }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: asFetch({
        casts: [NEYNAR_CAST],
        next: { cursor: 'page-2' },
      }),
    });
    const quoteBody = (await quotes.json()) as {
      result: { quotes: { hash: string }[] };
      next?: { cursor?: string };
    };
    expect(quotes.status).toBe(200);
    expect(quoteBody.result.quotes[0]!.hash).toBe(NEYNAR_CAST.hash);
    expect(quoteBody.next).toEqual({ cursor: 'page-2' });

    const liked = await answerFromNeynar({
      path: '/v2/user-liked-casts',
      searchParams: new URLSearchParams({ fid: '3' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: asFetch({
        reactions: [{ reaction_type: 'like', cast: NEYNAR_CAST }],
      }),
    });
    const likedBody = (await liked.json()) as {
      result: { casts: { hash: string }[] };
    };
    expect(likedBody.result.casts[0]!.hash).toBe(NEYNAR_CAST.hash);

    const users = await answerFromNeynar({
      path: '/v2/search-users',
      searchParams: new URLSearchParams({ q: 'dwr' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: asFetch({ result: { users: [NEYNAR_USER] } }),
    });
    const usersBody = (await users.json()) as {
      result: { users: { fid: number; username?: string }[] };
    };
    expect(usersBody.result.users[0]).toMatchObject({
      fid: 3,
      username: 'dwr',
    });

    const channels = await answerFromNeynar({
      path: '/v2/search-channels',
      searchParams: new URLSearchParams({ q: 'ai' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: asFetch({
        channels: [
          {
            id: 'ai',
            name: 'AI',
            image_url: 'https://example.com/ai.png',
            description: 'the AI channel',
            follower_count: 1234,
          },
        ],
      }),
    });
    const channelBody = (await channels.json()) as {
      result: {
        channels: {
          key: string;
          name: string;
          imageUrl?: string;
          followerCount?: number;
          // Nothing about this reader is claimed: no membership, no unnotified
          // state, no join button that would promise a write nobody made.
          viewerContext: { following: boolean; isMember: boolean };
        }[];
      };
    };
    expect(channelBody.result.channels[0]).toMatchObject({
      key: 'ai',
      name: 'AI',
      imageUrl: 'https://example.com/ai.png',
      followerCount: 1234,
      viewerContext: { following: false, isMember: false },
    });
  });

  it('answers an empty result as an empty list, not as a refusal', async () => {
    const response = await answerFromNeynar({
      path: '/v2/search-channels',
      searchParams: new URLSearchParams({ q: 'no-such-channel' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: asFetch({ channels: [] }),
    });
    const body = (await response.json()) as {
      result: { channels: unknown[] };
    };
    expect(response.status).toBe(200);
    expect(body.result.channels).toEqual([]);
  });
});
