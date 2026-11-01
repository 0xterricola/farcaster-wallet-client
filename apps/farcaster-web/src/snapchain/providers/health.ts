/**
 * "Is this server worth reading from right now?" — the measurement half.
 *
 * A server can be up and still be the wrong one to read from: out of sync, or
 * answering so slowly that the feed takes a minute to appear. So a check
 * measures two separate things and says which one is bad:
 *
 *   speed      how long the answer took (a request that never answers is a
 *              failure with a deadline, not a hang — this is a browser)
 *   freshness  is this server still following the network?
 *              - a Snapchain node reports it itself, and reports it per shard:
 *                `blockDelay` is the AGE OF THAT SHARD'S NEWEST BLOCK, IN
 *                SECONDS (measured — see `ShardSample`), and `isSyncing` says
 *                the node is catching up. Both are the node's own fields, never
 *                a guess, and both are read shard by shard: a node that answers
 *                while one of its shards is hours behind is not following the
 *                network, and that shard is one the feed reads.
 *              - Neynar and `api.farcaster.xyz` publish no such field, so for
 *                Neynar we watch the newest timestamp on a busy channel: a
 *                watermark that stops moving is a stale index.
 *              - `api.farcaster.xyz` cannot report its lag at all, so its
 *                freshness is reported as `unknown` rather than invented. That
 *                is exactly why it is the last provider in any order.
 *
 * Nothing here throws at a caller: a probe always answers with a sample, and a
 * sample that failed carries a sentence in plain words saying why.
 */

import type { NodeProvider } from './providerTypes';
import {
  PUBLIC_SERVER_NO_ANSWER_REASON,
  PUBLIC_SERVER_UNREADABLE_FROM_A_PAGE,
} from './publicServerOffTheWeb';

export type ProviderStatus =
  | 'live'
  | 'slow'
  | 'stale'
  | 'down'
  | 'unconfigured';

export type Freshness = 'fresh' | 'stale' | 'unknown';

/**
 * One shard of a Snapchain node, exactly as that node reported it.
 *
 * `tipAgeSeconds` is the node's own `blockDelay`. MEASURED at the source
 * (`farcasterxyz/snapchain`, read 2026-10-24):
 *
 *   src/network/server.rs         block_delay: current_time.saturating_sub(max_block_time)
 *                                 (max_block_time = that shard's max_block_timestamp())
 *   src/storage/store/engine.rs   gauge("block_delay_seconds", now - block.timestamp)
 *
 * so it is the AGE OF THAT SHARD'S NEWEST BLOCK IN SECONDS — a duration, not a
 * count of blocks. Two measured shapes, both on the public node on 2026-10-24:
 *
 *   frozen    shard 1 held height `49,477,354` and its `blockDelay` climbed in
 *             step with the wall clock (`31,706` → `31,937` s): it was applying
 *             nothing, so its newest block got older at 1 s per second.
 *   behind    shard 1 applied ~200 blocks in 21 s and its `blockDelay` stayed
 *             around `26,400` s, falling slowly: it was applying blocks that are
 *             hours old, so the shard is that far behind in event time.
 *
 * Either way the number says how far behind this shard's data is, which is what
 * a reader of its casts needs to know.
 */
export interface ShardSample {
  /** The shard this is, as the node numbers it, or null when it does not say. */
  shardId: number | null;
  /** Highest block this shard reports, or null when it reports none. */
  maxHeight: number | null;
  /** Age of this shard's newest block in seconds, or null when it says nothing. */
  tipAgeSeconds: number | null;
}

export interface ProbeSample {
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  /** Plain-words reason when the probe did not come back usable. */
  reason: string | null;
  /** A number that only moves forward while the server follows the network. */
  watermark: number | null;
  /** This server says it is still catching up. */
  catchingUp: boolean;
  /**
   * Every shard the node reports, exactly as it reported it — empty for a
   * server with no shards at all (Neynar, `api.farcaster.xyz`).
   *
   * Freshness is judged from these, one shard at a time: a single number taken
   * across shards is what let an advancing shard vouch for a stopped one.
   */
  shards: ShardSample[];
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderStatus;
  latencyMs: number | null;
  watermark: number | null;
  freshness: Freshness;
  /** One sentence for a human, in plain words. */
  detail: string;
  checkedAt: number;
}

export interface HealthConfig {
  /** A request that takes longer than this counts as slow. */
  slowMs: number;
  /** A request that has not answered by then is a failure. */
  timeoutMs: number;
  /**
   * A shard whose newest block is older than this is behind → stale. A
   * duration, because a duration is what the node reports.
   */
  maxTipAgeMs: number;
  /** A watermark that has not moved for this long → stale. */
  staleAfterMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  // MEASURED (2026-10-20): a healthy public read node answers /v1/info in
  // 0.19–1.6s, so 2.5s is already several times the worst healthy answer.
  slowMs: 2_500,
  // The deadline has to be LONGER than the slowness threshold, or a slow server
  // can never be reported as slow: it would be aborted at the same instant it
  // becomes slow, and every sluggish node would be described to the reader as
  // one that "stopped answering" — the wrong story, and the wrong reason for the
  // switch, for a server that is answering and merely late.
  timeoutMs: 6_000,
  // MEASURED (2026-10-20 and 2026-10-24, 15:42 and 16:07 UTC): a shard that IS
  // following the chain has a newest block 0–6 seconds old — blocks land about
  // once a second — so two minutes is twenty times the worst healthy reading.
  // The same public node's other shards measured 10,627–31,937 s, both while
  // frozen and while applying blocks that were hours old.
  maxTipAgeMs: 120_000,
  // Two minutes of a frozen watermark while we are watching is a stalled index.
  staleAfterMs: 120_000,
};

interface FreshnessRecord {
  watermark: number | null;
  /** When the watermark last moved forward. */
  advancedAt: number | null;
  /** When we first looked at this server. */
  firstSeenAt: number;
}

export interface FreshnessJudgement {
  freshness: Freshness;
  record: FreshnessRecord;
}

/**
 * Judge freshness from a watermark that should only move forward.
 *
 * Deliberately not "is the newest thing recent": a quiet server can be perfectly
 * in sync. The question is whether the number is still moving. A first look
 * cannot answer that, so it says `unknown` and starts the clock.
 */
export const judgeFreshness = (
  previous: FreshnessRecord | undefined,
  watermark: number | null,
  now: number,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): FreshnessJudgement => {
  if (watermark === null) {
    return {
      freshness: 'unknown',
      record: previous ?? {
        watermark: null,
        advancedAt: null,
        firstSeenAt: now,
      },
    };
  }

  if (!previous || previous.watermark === null) {
    return {
      freshness: 'unknown',
      record: {
        watermark,
        advancedAt: now,
        firstSeenAt: previous?.firstSeenAt ?? now,
      },
    };
  }

  if (watermark > previous.watermark) {
    return {
      freshness: 'fresh',
      record: { ...previous, watermark, advancedAt: now },
    };
  }

  const stillSince = previous.advancedAt ?? previous.firstSeenAt;
  const freshness: Freshness =
    now - stillSince >= config.staleAfterMs ? 'stale' : 'fresh';
  return { freshness, record: { ...previous, watermark: previous.watermark } };
};

/** A span of seconds in the words a reader reads: 35,793 → "9h 56m". */
const describeSpan = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) {
    return `${whole}s`;
  }
  const minutes = Math.floor(whole / 60);
  const restSeconds = whole % 60;
  if (minutes < 60) {
    return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
};

/**
 * The shards that are behind, from the node's own numbers.
 *
 * The input is each shard's `blockDelay` — the age of that shard's newest block
 * — so the question is "has this shard said, itself, that it is this far
 * behind?" A shard with no reported age stays out of it: an age this client was
 * not given is an age it does not invent.
 */
export const shardsBehind = (
  shards: ShardSample[],
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): ShardSample[] =>
  shards
    .filter(
      (shard) =>
        shard.tipAgeSeconds !== null &&
        shard.tipAgeSeconds * 1000 > config.maxTipAgeMs,
    )
    // In shard order, so the sentence reads "shards 1 and 2 are 5h 48m and 1h
    // 22m old" no matter what order the node listed its shards in.
    .sort(
      (a, b) =>
        (a.shardId ?? Number.MAX_SAFE_INTEGER) -
        (b.shardId ?? Number.MAX_SAFE_INTEGER),
    );

/**
 * The freshness of a server judged shard by shard: the worst shard decides.
 *
 * One stopped shard is the whole server's problem — one of the feed's reads is
 * that shard's read — so an advancing shard can never vouch for a frozen one.
 * `unknown` (a shard nothing has watched yet) does not make a server stale: it
 * only means there is not enough here to claim freshness either.
 */
export const combineFreshness = (judgements: Freshness[]): Freshness => {
  if (judgements.includes('stale')) {
    return 'stale';
  }
  if (judgements.length === 0 || judgements.includes('unknown')) {
    return 'unknown';
  }
  return 'fresh';
};

/**
 * The sentence for shards that are behind, naming each shard and its own age.
 *
 * It says what the field says — how old that shard's newest block is — and not
 * "it has stopped applying blocks": MEASURED 2026-10-24 16:07 UTC, the public
 * node's shard 1 applied ~200 blocks in 21 s while that age stayed near
 * `26,400` s, so a stop is not the only thing this number can mean.
 */
const behindSentence = (behind: ShardSample[]): string => {
  const list = (parts: string[]): string =>
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
      : (parts[0] ?? '');
  const ages = (shards: ShardSample[]): string =>
    list(shards.map((shard) => describeSpan(shard.tipAgeSeconds ?? 0)));

  if (behind.length === 1) {
    const shard = behind[0]!;
    const age = describeSpan(shard.tipAgeSeconds ?? 0);
    return shard.shardId === null
      ? `It answered, but its newest block is ${age} old.`
      : `It answered, but shard ${shard.shardId}'s newest block is ${age} old.`;
  }

  const named = behind.filter((shard) => shard.shardId !== null);
  if (named.length !== behind.length) {
    // Some shards came back without an id: name the age, never a shard number
    // this node did not give.
    return `It answered, but ${behind.length} of its shards have newest blocks up to ${describeSpan(
      Math.max(...behind.map((shard) => shard.tipAgeSeconds ?? 0)),
    )} old.`;
  }
  return `It answered, but the newest blocks on shards ${list(
    named.map((shard) => String(shard.shardId)),
  )} are ${ages(named)} old.`;
};

/** The sentence a human reads for each status. */
export const statusDetail = (
  status: ProviderStatus,
  sample: { reason: string | null; latencyMs: number | null },
): string => {
  switch (status) {
    case 'live':
      return sample.latencyMs === null
        ? 'Answering normally.'
        : `Answering normally, in about ${(sample.latencyMs / 1000).toFixed(1)}s.`;
    case 'slow':
      return sample.latencyMs === null
        ? 'Answering, but slowly.'
        : `Answering, but slowly — about ${(sample.latencyMs / 1000).toFixed(1)}s.`;
    case 'stale':
      return (
        sample.reason ??
        'Answering, but it has stopped keeping up with the network.'
      );
    case 'unconfigured':
      return sample.reason ?? 'This one still needs your key.';
    case 'down':
    default:
      return sample.reason ?? 'It did not answer.';
  }
};

/**
 * Turn one probe's raw result into the status the client acts on.
 *
 * Kept pure and separate from the network so the pill's claims and the
 * failover's decisions are testable without a browser: the only inputs are a
 * sample and a freshness judgement.
 */
export const judgeProbe = ({
  providerId,
  sample,
  freshness,
  config = DEFAULT_HEALTH_CONFIG,
  now,
}: {
  providerId: string;
  sample: ProbeSample;
  freshness: Freshness;
  config?: HealthConfig;
  now: number;
}): ProviderHealth => {
  let status: ProviderStatus;
  // Judged per shard, from the node's own numbers: a maximum taken across the
  // shards is what let an advancing one cover for a stopped one.
  const behind = shardsBehind(sample.shards, config);
  if (!sample.ok) {
    status = 'down';
  } else if (sample.catchingUp || behind.length > 0) {
    status = 'stale';
  } else if (freshness === 'stale') {
    status = 'stale';
  } else if ((sample.latencyMs ?? 0) > config.slowMs) {
    status = 'slow';
  } else {
    status = 'live';
  }

  const reason =
    status === 'stale' && sample.ok
      ? sample.catchingUp
        ? 'It answered, but it says it is still catching up with the network.'
        : behind.length > 0
          ? behindSentence(behind)
          : // Nothing in the node's own per-shard fields says it is behind (its
            // heights stopped moving across reads instead). Inventing a number
            // here is exactly what this client does not do, so the reason stays
            // null and `statusDetail` says it without one.
            null
      : sample.reason;

  return {
    providerId,
    status,
    latencyMs: sample.latencyMs,
    watermark: sample.watermark,
    freshness,
    detail: statusDetail(status, { reason, latencyMs: sample.latencyMs }),
    checkedAt: now,
  };
};

/** A probe that failed before it could say anything. */
const failedSample = (
  reason: string,
  latencyMs: number | null,
): ProbeSample => ({
  ok: false,
  latencyMs,
  httpStatus: null,
  reason,
  watermark: null,
  catchingUp: false,
  shards: [],
});

/**
 * Fetch with a deadline that survives the body read.
 *
 * `AbortController` alone would leave the timer armed past the response; the
 * timer is cleared in `finally` so a page that probes every minute never grows
 * a pile of live timers.
 */
const fetchWithDeadline = async (
  url: string,
  {
    fetchImpl,
    timeoutMs,
    headers,
  }: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    headers?: Record<string, string>;
  },
): Promise<{
  response: Response | null;
  latencyMs: number;
  aborted: boolean;
}> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      // A probe is a read of a stranger's server: never send credentials, and
      // never let a cached answer stand in for a measurement.
      credentials: 'omit',
      cache: 'no-store',
    });
    return { response, latencyMs: Date.now() - started, aborted: false };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      response: null,
      latencyMs: Date.now() - started,
      aborted:
        aborted || (error instanceof Error && error.name === 'AbortError'),
    };
  } finally {
    clearTimeout(timer);
  }
};

const readJson = async (response: Response): Promise<unknown | null> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

/**
 * Every shard a Snapchain `/v1/info` body reports, as that node reported it.
 *
 * `blockDelay` is read as what it is — the age of that shard's newest block, in
 * seconds (`src/network/server.rs`: `current_time.saturating_sub(max_block_time)`)
 * — and kept per shard, because the shards move independently: on 2026-10-24 this
 * public node's shard 0 had a newest block 2–6 s old while shards 1 and 2 sat
 * hours behind.
 */
export const snapchainShards = (body: unknown): ShardSample[] => {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const record = body as Record<string, unknown>;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const shards: ShardSample[] = [];
  const reported = record.shardInfos;
  if (Array.isArray(reported)) {
    for (const entry of reported) {
      const shard = (entry ?? {}) as Record<string, unknown>;
      const maxHeight = numberOrNull(shard.maxHeight);
      const tipAgeSeconds = numberOrNull(shard.blockDelay);
      if (maxHeight === null && tipAgeSeconds === null) {
        continue;
      }
      shards.push({
        shardId: numberOrNull(shard.shardId),
        maxHeight,
        tipAgeSeconds,
      });
    }
  }

  if (shards.length === 0) {
    // An older body puts the same two numbers at the top level.
    const maxHeight = numberOrNull(record.maxHeight);
    const tipAgeSeconds = numberOrNull(record.blockDelay);
    if (maxHeight !== null || tipAgeSeconds !== null) {
      shards.push({ shardId: null, maxHeight, tipAgeSeconds });
    }
  }
  return shards;
};

/**
 * Largest `maxHeight` a Snapchain `/v1/info` body reports, or null.
 *
 * A display number, one per server. It is NOT the freshness signal any more:
 * the maximum over shards is exactly what let an advancing shard hide a stopped
 * one, so freshness is judged per shard (`stalledShards`, `combineFreshness`)
 * from the body's own fields.
 */
const snapchainWatermark = (body: unknown): number | null => {
  const heights = snapchainShards(body)
    .map((shard) => shard.maxHeight)
    .filter((height): height is number => height !== null);
  return heights.length > 0 ? Math.max(...heights) : null;
};

/**
 * Probe a Snapchain node: `GET /v1/info`.
 *
 * The node reports its own version, whether it is syncing, and per shard both
 * its height and how long ago that shard applied a block (`blockDelay`, in
 * seconds — see `ShardSample`). That is the strongest freshness signal any of
 * the three kinds of provider offers, and it is read per shard, so a snapchain
 * provider is judged on what the node says about itself, never on a guess.
 */
export const probeSnapchain = async ({
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  if (provider.baseUrl.trim().length === 0) {
    return failedSample('This one has no address yet.', null);
  }

  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/v1/info?dbstats=0`,
    { fetchImpl, timeoutMs: config.timeoutMs },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : 'It did not answer at all.',
      latencyMs,
    );
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `It answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  if (body === null) {
    return {
      ...failedSample(
        'It answered, but not like a node — no chain status came back.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const record = body as Record<string, unknown>;
  if (!Number.isFinite(snapchainWatermark(body))) {
    // A 200 that carries no heights is not a node this client can read:
    // answering "fine" here would make the pill vouch for a stranger's HTML.
    return {
      ...failedSample(
        'It answered, but not like a node — no chain status came back.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: snapchainWatermark(body),
    catchingUp: record.isSyncing === true,
    shards: snapchainShards(body),
  };
};

/** Newest ISO timestamp in a Neynar feed body, as milliseconds. */
const newestNeynarTimestamp = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const casts = (body as { casts?: unknown }).casts;
  if (!Array.isArray(casts)) {
    return null;
  }
  const stamps: number[] = [];
  for (const cast of casts) {
    const raw = (cast as { timestamp?: unknown })?.timestamp;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) {
        stamps.push(parsed);
      }
    }
  }
  return stamps.length > 0 ? Math.max(...stamps) : null;
};

/**
 * Probe Neynar.
 *
 * Two honest answers it can give: no key (`unconfigured`, a setup task, not a
 * fault), and a key that was refused (401/402 — measured: a wrong key comes
 * back either "Incorrect or missing API key" or a payment challenge). A usable
 * key gets one cheap documented read whose newest timestamp is the watermark.
 */
export const probeNeynar = async ({
  apiKey,
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  apiKey: string | null;
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  if (!apiKey || apiKey.trim().length === 0) {
    return failedSample(
      'Neynar needs your key before it can be used. Run scripts/fiddy-setup.command to add it.',
      null,
    );
  }

  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/v2/farcaster/feed/channels?channel_ids=base&limit=5`,
    {
      fetchImpl,
      timeoutMs: config.timeoutMs,
      headers: { 'x-api-key': apiKey.trim() },
    },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : 'It did not answer at all.',
      latencyMs,
    );
  }

  if (response.status === 401 || response.status === 402) {
    return {
      ...failedSample(
        `Neynar refused your key (${response.status}). Check the key, or the plan it belongs to.`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `Neynar answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: newestNeynarTimestamp(body),
    catchingUp: false,
    shards: [],
  };
};

/**
 * Probe `api.farcaster.xyz`: a read of the kind this client asks it for.
 *
 * It used to ask `/fc/primary-address` — the ONE path on that server a page on
 * another origin is allowed to read (`access-control-allow-origin: *`). So the
 * check said "reachable", the failover moved the reader onto it, and then every
 * read the client actually makes was refused by the browser: MEASURED
 * (2026-10-21) eleven distinct reads on the live site, all CORS failures, while
 * the reader's unseen counts, spaces and explore panels showed "Failed to
 * fetch". A reachability check has to ask the question the reads will ask, so it
 * asks `/v2/user-by-fid` — a documented public read that needs no account, and
 * one this client's data layer really uses.
 *
 * Freshness stays `unknown`: this API publishes nothing about how far behind it
 * is, and this client will not pretend otherwise.
 */
export const probeFarcasterPublic = async ({
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/v2/user-by-fid?fid=3`,
    { fetchImpl, timeoutMs: config.timeoutMs },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : // A browser that never got an answer back means one of two things,
          // and this client will not pick for the reader: the server is
          // unreachable from here, or it did not permit this origin to read it —
          // which is what api.farcaster.xyz does for every read this client
          // makes (see `providers/publicServerOffTheWeb`).
          PUBLIC_SERVER_NO_ANSWER_REASON,
      latencyMs,
    );
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `It answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  if (body === null || typeof body !== 'object') {
    return {
      ...failedSample(
        'It answered with something that was not a list.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: null,
    catchingUp: false,
    shards: [],
  };
};

/** Probe whichever kind of server this provider is. */
export const probeProvider = async ({
  provider,
  apiKey,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  switch (provider.kind) {
    case 'neynar':
      return probeNeynar({ apiKey, provider, fetchImpl, config });
    case 'farcaster-public':
      // Measured, so it is not asked: a page on another origin cannot read that
      // server (see `publicServerOffTheWeb`). Asking anyway would put a CORS
      // failure in the console once a minute to learn nothing new, and would let
      // the failover park the reader on a server that cannot answer a single one
      // of this client's reads. `probeFarcasterPublic` stays for a context that
      // really can read it (a native shell).
      return failedSample(PUBLIC_SERVER_UNREADABLE_FROM_A_PAGE, null);
    case 'snapchain':
    default:
      return probeSnapchain({ provider, fetchImpl, config });
  }
};

export type { FreshnessRecord };
