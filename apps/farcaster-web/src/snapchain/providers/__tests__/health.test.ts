/**
 * The measurements, as tests — including the ones taken from the real servers.
 *
 * The snapchain bodies below are the shapes live public nodes returned:
 * per-shard `maxHeight` and `blockDelay`, plus `numShards`. `blockDelay` is the
 * AGE OF THAT SHARD'S NEWEST BLOCK, IN SECONDS — MEASURED at the source
 * (`farcasterxyz/snapchain`, `src/network/server.rs`:
 * `block_delay: current_time.saturating_sub(max_block_time)`, where
 * `max_block_time` is that shard's `max_block_timestamp()`) — so the 2026-10-24
 * body, in which two shards sat still while their ages climbed with the wall
 * clock, is the fixture for "the node answers and is not following the chain".
 * The Neynar and `api.farcaster.xyz` bodies are
 * the shapes their documented endpoints return. What the tests check is the part
 * that would otherwise be a claim: which of those answers counts as live, slow,
 * stale, refused or not a node at all.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
} from '~/snapchain/providers/catalog';
import {
  combineFreshness,
  DEFAULT_HEALTH_CONFIG,
  type Freshness,
  type FreshnessRecord,
  judgeFreshness,
  judgeProbe,
  probeFarcasterPublic,
  probeNeynar,
  probeProvider,
  type ProbeSample,
  probeSnapchain,
  type ProviderHealth,
  type ShardSample,
} from '~/snapchain/providers/health';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const NODE_INFO = {
  version: '1.5.5',
  isSyncing: false,
  numShards: 2,
  // `blockDelay` is the age of that shard's newest block: 0–1 s here, which is
  // a shard that is keeping up.
  shardInfos: [
    { shardId: 0, maxHeight: 48_501_853, blockDelay: 1 },
    { shardId: 1, maxHeight: 49_177_741, blockDelay: 0 },
    { shardId: 2, maxHeight: 49_013_091, blockDelay: 0 },
  ],
};

/**
 * MEASURED (2026-10-24, 15:42 and 15:43 UTC, `https://haatz.quilibrium.com` — the
 * route the hosted client reads by default): the node answered every read while
 * two of its three shards did not advance. Shard 0 applied about a block a
 * second (48,836,025 → 48,836,071 in 46 s), so its newest block stayed 2 s old;
 * shard 1 sat at 49,477,354 and shard 2 at 49,328,400, so their newest blocks
 * got older in step with the wall clock (35,793 → 35,839 s and 19,903 → 19,949 s).
 */
const PUBLIC_NODE_READ_1 = {
  version: '0.13.5',
  numShards: 2,
  shardInfos: [
    { shardId: 0, maxHeight: 48_836_025, blockDelay: 2 },
    { shardId: 1, maxHeight: 49_477_354, blockDelay: 35_793 },
    { shardId: 2, maxHeight: 49_328_400, blockDelay: 19_903 },
  ],
};

const PUBLIC_NODE_READ_2 = {
  ...PUBLIC_NODE_READ_1,
  shardInfos: [
    { shardId: 0, maxHeight: 48_836_071, blockDelay: 2 },
    { shardId: 1, maxHeight: 49_477_354, blockDelay: 35_839 },
    { shardId: 2, maxHeight: 49_328_400, blockDelay: 19_949 },
  ],
};

/**
 * The same node in the shape a single number across shards hides: the HIGHEST
 * shard is the one advancing, so a maximum taken over the shards keeps moving
 * while shard 2 sits frozen at 49,328,400.
 */
const PUBLIC_NODE_HIDDEN_STOP_1 = {
  version: '0.13.5',
  numShards: 2,
  shardInfos: [
    { shardId: 0, maxHeight: 48_836_025, blockDelay: 2 },
    { shardId: 1, maxHeight: 49_477_354, blockDelay: 2 },
    { shardId: 2, maxHeight: 49_328_400, blockDelay: 19_903 },
  ],
};

const PUBLIC_NODE_HIDDEN_STOP_2 = {
  ...PUBLIC_NODE_HIDDEN_STOP_1,
  shardInfos: [
    { shardId: 0, maxHeight: 48_836_071, blockDelay: 2 },
    { shardId: 1, maxHeight: 49_477_400, blockDelay: 0 },
    { shardId: 2, maxHeight: 49_328_400, blockDelay: 19_949 },
  ],
};

/** MEASURED (2026-10-20): every shard following the chain, tip ages 0–2 s. */
const HEALTHY_NODE_READ_1 = {
  version: '1.5.5',
  isSyncing: false,
  numShards: 2,
  shardInfos: [
    { shardId: 0, maxHeight: 48_501_853, blockDelay: 1 },
    { shardId: 1, maxHeight: 49_177_741, blockDelay: 0 },
    { shardId: 2, maxHeight: 49_013_091, blockDelay: 2 },
  ],
};

const HEALTHY_NODE_READ_2 = {
  ...HEALTHY_NODE_READ_1,
  shardInfos: [
    { shardId: 0, maxHeight: 48_501_906, blockDelay: 0 },
    { shardId: 1, maxHeight: 49_177_795, blockDelay: 1 },
    { shardId: 2, maxHeight: 49_013_144, blockDelay: 0 },
  ],
};

/**
 * Walk two `/v1/info` reads through both halves the runtime uses: the freshness
 * of each shard (its height across the two reads), then the status and the
 * sentence for the second read.
 */
const readTwice = async (
  first: unknown,
  second: unknown,
  nows: [number, number] = [1_000_000, 1_046_000],
): Promise<{
  samples: ProbeSample[];
  freshness: Freshness;
  health: ProviderHealth;
}> => {
  const bodies = [first, second];
  let read = 0;
  const fetchImpl = (async () =>
    jsonResponse(
      bodies[Math.min(read++, bodies.length - 1)],
    )) as unknown as typeof fetch;
  const config = DEFAULT_HEALTH_CONFIG;
  const records = new Map<string, FreshnessRecord>();
  const samples: ProbeSample[] = [];
  let freshness: Freshness = 'unknown';

  for (const now of nows) {
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://haatz.quilibrium.com'),
      fetchImpl,
      config,
    });
    samples.push(sample);
    const shards = sample.shards.filter(
      (shard): shard is ShardSample & { maxHeight: number } =>
        shard.maxHeight !== null,
    );
    freshness = combineFreshness(
      shards.map((shard) => {
        const key = `shard-${shard.shardId}`;
        const judgement = judgeFreshness(
          records.get(key),
          shard.maxHeight,
          now,
          config,
        );
        records.set(key, judgement.record);
        return judgement.freshness;
      }),
    );
  }

  return {
    samples,
    freshness,
    health: judgeProbe({
      providerId: 'public',
      sample: samples[samples.length - 1]!,
      freshness,
      now: nows[1],
      config,
    }),
  };
};

describe('judgeFreshness', () => {
  const config = { ...DEFAULT_HEALTH_CONFIG, staleAfterMs: 120_000 };

  it('cannot judge a server it has only just looked at', () => {
    const { freshness, record } = judgeFreshness(undefined, 100, 1_000, config);
    expect(freshness).toBe('unknown');
    expect(record.watermark).toBe(100);
  });

  it('is fresh while the watermark is still moving', () => {
    const first = judgeFreshness(undefined, 100, 1_000, config);
    const second = judgeFreshness(first.record, 101, 61_000, config);
    expect(second.freshness).toBe('fresh');
    expect(second.record.advancedAt).toBe(61_000);
  });

  it('goes stale once the watermark stops moving', () => {
    const first = judgeFreshness(undefined, 100, 1_000, config);
    const still = judgeFreshness(first.record, 100, 61_000, config);
    expect(still.freshness).toBe('fresh');
    const stalled = judgeFreshness(still.record, 100, 121_001, config);
    expect(stalled.freshness).toBe('stale');
  });

  it('reports unknown for a server that publishes no watermark', () => {
    const { freshness } = judgeFreshness(undefined, null, 1_000, config);
    expect(freshness).toBe('unknown');
  });
});

describe('judgeProbe', () => {
  const sample = (overrides: Partial<ProbeSample> = {}): ProbeSample => ({
    ok: true,
    latencyMs: 200,
    httpStatus: 200,
    reason: null,
    watermark: 10,
    catchingUp: false,
    shards: [],
    ...overrides,
  });

  const judge = (
    overrides: Partial<ProbeSample>,
    freshness: 'fresh' | 'stale' | 'unknown' = 'fresh',
  ) =>
    judgeProbe({
      providerId: 'mine',
      sample: sample(overrides),
      freshness,
      now: 1_000,
    });

  it('calls a fast, caught-up server live', () => {
    expect(judge({}).status).toBe('live');
    expect(judge({}).detail).toContain('normally');
  });

  it('calls a server slower than the threshold slow', () => {
    const health = judge({ latencyMs: 6_500 });
    expect(health.status).toBe('slow');
    expect(health.detail).toContain('6.5s');
  });

  it('has a deadline longer than its slowness threshold', () => {
    // Otherwise `slow` is unreachable from a real probe: the request would be
    // aborted at the very moment it becomes slow, so every sluggish server would
    // be reported to the reader as one that stopped answering.
    expect(DEFAULT_HEALTH_CONFIG.timeoutMs).toBeGreaterThan(
      DEFAULT_HEALTH_CONFIG.slowMs,
    );
  });

  it('calls a server that says it is catching up stale', () => {
    const health = judge({ catchingUp: true });
    expect(health.status).toBe('stale');
    expect(health.detail).toContain('catching up');
  });

  it('calls a node a shard is hours behind on stale, in seconds', () => {
    // MEASURED (2026-10-24): the public node's shard 1 held height 49,477,354
    // while its age climbed past 35,000 s. A duration, not a count of blocks,
    // and the sentence says exactly what the field says.
    const health = judge({
      shards: [
        { shardId: 0, maxHeight: 48_836_025, tipAgeSeconds: 2 },
        { shardId: 1, maxHeight: 49_477_354, tipAgeSeconds: 35_793 },
      ],
    });
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      "It answered, but shard 1's newest block is 9h 56m old.",
    );
  });

  it('names every shard that is behind, each with its own age', () => {
    const health = judge({
      shards: [
        // Listed the way the node listed them on 2026-10-24 (0, then 2, then 1)
        // and NOT the way the sentence reads them: shard order, worst included.
        { shardId: 0, maxHeight: 48_836_025, tipAgeSeconds: 2 },
        { shardId: 2, maxHeight: 49_328_400, tipAgeSeconds: 19_903 },
        { shardId: 1, maxHeight: 49_477_354, tipAgeSeconds: 35_793 },
      ],
    });
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      'It answered, but the newest blocks on shards 1 and 2 are 9h 56m and 5h 31m old.',
    );
  });

  it('refuses to invent an age the node did not report', () => {
    // A shard with no `blockDelay` has said nothing about how old its newest
    // block is; that is not a number this client may supply.
    const health = judge({
      shards: [{ shardId: 1, maxHeight: 49_477_354, tipAgeSeconds: null }],
    });
    expect(health.status).toBe('live');
    expect(health.detail).toContain('normally');
  });

  it('names no shard number when the node did not give one', () => {
    const health = judge({
      shards: [{ shardId: null, maxHeight: 49_477_354, tipAgeSeconds: 35_793 }],
    });
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      'It answered, but its newest block is 9h 56m old.',
    );
  });

  it('says the plain sentence when only the heights stopped moving', () => {
    // The freshness half can go stale with no per-shard age to quote, and the
    // sentence then stays true without a number in it.
    const health = judge({}, 'stale');
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      'Answering, but it has stopped keeping up with the network.',
    );
  });

  it('calls a server whose watermark stopped moving stale', () => {
    expect(judge({}, 'stale').status).toBe('stale');
  });

  it('calls a server that did not answer down, and keeps its reason', () => {
    const health = judge({ ok: false, reason: 'It did not answer at all.' });
    expect(health.status).toBe('down');
    expect(health.detail).toBe('It did not answer at all.');
  });

  it('never lets a fast answer hide a shard that is behind', () => {
    const health = judge({
      latencyMs: 50,
      shards: [{ shardId: 1, maxHeight: 49_477_354, tipAgeSeconds: 1_000 }],
    });
    expect(health.status).toBe('stale');
  });
});

describe('probeSnapchain', () => {
  it('reads a live node body as live, with its real height', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(NODE_INFO),
    ) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBe(49_177_741);
    // Every shard as the node painted it, tip age in seconds and all.
    expect(sample.shards).toEqual([
      { shardId: 0, maxHeight: 48_501_853, tipAgeSeconds: 1 },
      { shardId: 1, maxHeight: 49_177_741, tipAgeSeconds: 0 },
      { shardId: 2, maxHeight: 49_013_091, tipAgeSeconds: 0 },
    ]);
    expect(sample.catchingUp).toBe(false);
    expect(
      String(
        (fetchImpl as unknown as { mock: { calls: string[][] } }).mock
          .calls[0]![0],
      ),
    ).toBe('https://node.example/v1/info?dbstats=0');
  });

  it('keeps a tip age the node did not report unknown, per shard', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        version: '1.5.5',
        shardInfos: [{ shardId: 1, maxHeight: 49_177_741 }],
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.shards).toEqual([
      { shardId: 1, maxHeight: 49_177_741, tipAgeSeconds: null },
    ]);
    // Nothing says this shard stopped, so nothing here claims it did.
    expect(
      judgeProbe({
        providerId: 'mine',
        sample,
        freshness: 'unknown',
        now: 1_000,
      }).status,
    ).toBe('live');
  });

  it('reports a node that is syncing as catching up', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        ...NODE_INFO,
        isSyncing: true,
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.catchingUp).toBe(true);
  });

  it('refuses to call a 200 that carries no chain status a node', async () => {
    const fetchImpl = (async () =>
      new Response('<html>Farcaster docs</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://docs.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('no chain status came back');
  });

  it('reports an error status with the status in the sentence', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'nope' }, 503)) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('503');
  });

  it('turns a request that never answers into a failure with a deadline', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
      config: { ...DEFAULT_HEALTH_CONFIG, timeoutMs: 20 },
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('0.02s');
  });
});

describe('the public node, read twice', () => {
  it('answers, and is not live: two shards have not applied a block in hours', async () => {
    const { samples, freshness, health } = await readTwice(
      PUBLIC_NODE_READ_1,
      PUBLIC_NODE_READ_2,
    );

    // It answered every read — this is not a "down" story.
    expect(samples[1]!.ok).toBe(true);
    expect(samples[1]!.httpStatus).toBe(200);
    // The shard that is following the chain applied 46 blocks in 46 s, so its
    // newest block stayed 2 s old. The two that stopped did not move at all, so
    // their newest blocks got 46 s older: that is exactly what `blockDelay`
    // reports, in seconds.
    expect(
      samples[1]!.shards[0]!.maxHeight! - samples[0]!.shards[0]!.maxHeight!,
    ).toBe(46);
    expect(samples[1]!.shards[1]!.maxHeight).toBe(
      samples[0]!.shards[1]!.maxHeight,
    );
    expect(
      samples[1]!.shards[1]!.tipAgeSeconds! -
        samples[0]!.shards[1]!.tipAgeSeconds!,
    ).toBe(46);
    // One minute in, a shard's own history is still inside the two-minute
    // window, so nothing about the heights says stale yet: the node's per-shard
    // age is what catches this, immediately and in its own words.
    expect(freshness).toBe('fresh');
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      'It answered, but the newest blocks on shards 1 and 2 are 9h 57m and 5h 32m old.',
    );
  });

  it('cannot be talked into "live" by the shard that is still advancing', async () => {
    // The shape a single number across shards hides: the HIGHEST shard is the
    // one moving, so a maximum over the shards just keeps climbing while shard
    // 2 sits frozen. Two minutes on, its history says so too.
    const { freshness, health } = await readTwice(
      PUBLIC_NODE_HIDDEN_STOP_1,
      PUBLIC_NODE_HIDDEN_STOP_2,
      [1_000_000, 1_121_000],
    );

    const top = (read: { shardInfos: { maxHeight: number }[] }): number =>
      Math.max(...read.shardInfos.map((shard) => shard.maxHeight));
    expect(top(PUBLIC_NODE_HIDDEN_STOP_2)).toBeGreaterThan(
      top(PUBLIC_NODE_HIDDEN_STOP_1),
    );
    expect(freshness).toBe('stale');
    expect(health.status).toBe('stale');
    expect(health.detail).toBe(
      "It answered, but shard 2's newest block is 5h 32m old.",
    );
  });

  it('holds a healthy node live, with every shard moving', async () => {
    const { samples, freshness, health } = await readTwice(
      HEALTHY_NODE_READ_1,
      HEALTHY_NODE_READ_2,
    );

    expect(samples[1]!.ok).toBe(true);
    expect(
      samples[1]!.shards.every(
        (shard) => shard.tipAgeSeconds !== null && shard.tipAgeSeconds <= 2,
      ),
    ).toBe(true);
    expect(freshness).toBe('fresh');
    expect(health.status).toBe('live');
    expect(health.detail).toContain('Answering normally');
  });
});

describe('probeFarcasterPublic', () => {
  it('reads a documented public endpoint as reachable', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        result: { address: { fid: 12152 } },
      })) as unknown as typeof fetch;
    const sample = await probeFarcasterPublic({
      provider: farcasterPublicProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBeNull();
  });

  it('asks a read this client actually makes, not the one path a page may read', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ result: { user: { fid: 3 } } });
    }) as unknown as typeof fetch;

    await probeFarcasterPublic({
      provider: farcasterPublicProvider(),
      fetchImpl,
    });

    // MEASURED (2026-10-21): `/fc/primary-address` is the only path on that
    // server a page on another origin may read, so a probe of it called the
    // server reachable while every read the client makes was CORS-refused.
    expect(urls[0]).toBe('https://api.farcaster.xyz/v2/user-by-fid?fid=3');
  });

  it('names both reasons no answer can come back, instead of guessing', async () => {
    const fetchImpl = (async () => {
      // Exactly what a browser throws when it refuses to hand over a
      // cross-origin answer — a refused request and a dead host are the same
      // TypeError here.
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const sample = await probeFarcasterPublic({
      provider: farcasterPublicProvider(),
      fetchImpl,
    });

    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('unreachable from here');
    expect(sample.reason).toContain('not allowed to read it');
    // The status the failover acts on: not answering at all.
    expect(
      judgeProbe({
        providerId: 'farcaster-public',
        sample,
        freshness: 'unknown',
        now: 1_000,
      }).status,
    ).toBe('down');
  });
});

describe('probeProvider: Farcaster’s own public server, from a page', () => {
  it('is not asked at all, and the reader is told why it cannot answer', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ result: {} });
    }) as unknown as typeof fetch;

    const sample = await probeProvider({
      provider: farcasterPublicProvider(),
      apiKey: null,
      fetchImpl,
    });

    // Zero requests: the answer cannot change while the page is open, and asking
    // would put a CORS failure in the console every minute for nothing.
    expect(calls).toEqual([]);
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('permits its own origins only');

    const health = judgeProbe({
      providerId: 'farcaster-public',
      sample,
      freshness: 'unknown',
      now: 1_000,
    });
    expect(health.status).toBe('down');
    expect(health.detail).toContain('permits its own origins only');
  });
});

describe('probeNeynar', () => {
  const neynarFeed = {
    casts: [
      { hash: '0xaa', timestamp: '2026-10-20T20:00:00.000Z' },
      { hash: '0xbb', timestamp: '2026-10-20T19:59:00.000Z' },
    ],
    next: { cursor: null },
  };

  it('says a missing key is a setup task, not a fault', async () => {
    const sample = await probeNeynar({
      apiKey: null,
      provider: neynarProvider(),
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('fiddy-setup.command');
  });

  it('reports a refused key as refused, by status', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { message: 'Incorrect or missing API key' },
        401,
      )) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'deliberately-wrong-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.httpStatus).toBe(401);
    expect(sample.reason).toContain('refused your key');
  });

  it('reports a payment challenge (402) as a refused key too', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'X-PAYMENT header or API key required' },
        402,
      )) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'deliberately-wrong-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.httpStatus).toBe(402);
    expect(sample.reason).toContain('refused your key');
  });

  it('uses the newest cast timestamp as the freshness watermark', async () => {
    const fetchImpl = (async () =>
      jsonResponse(neynarFeed)) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'a-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBe(Date.parse('2026-10-20T20:00:00.000Z'));
  });

  it('sends the key in a header, never in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(neynarFeed);
    }) as unknown as typeof fetch;
    await probeNeynar({
      apiKey: 'a-secret-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(calls[0]!.url).not.toContain('a-secret-key');
    expect(
      (calls[0]!.init?.headers as Record<string, string>)['x-api-key'],
    ).toBe('a-secret-key');
    expect(calls[0]!.url).toContain('/v2/farcaster/feed/channels');
  });
});
