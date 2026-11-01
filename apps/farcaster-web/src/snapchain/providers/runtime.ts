/**
 * The thing that actually watches: one loop, one live server, one story.
 *
 * This module keeps the answers the whole client needs, readable synchronously
 * and from anywhere, because the reads adapter asks "where do my answers come
 * from?" during a render:
 *
 *   order        the reader's servers, in their order (see `catalog`)
 *   health       what each one measured last time (see `health`)
 *   failover     which one is live, and why (see `failover`)
 *
 * A module store rather than React state on purpose — the same reason
 * `nodeChoice` is one: the fetch seam cannot suspend, and a check that runs on a
 * timer has to be able to hand its result to whatever is rendering right now.
 *
 * The loop checks every `checkIntervalMs` (a minute), all servers at once, and
 * moves the live one only through `nextFailoverState`. It also reacts to the
 * reader changing their mind: choosing a server in the picker re-runs the checks
 * immediately instead of waiting out the interval.
 */

import {
  getActiveNodeChoice,
  subscribeToNodeChoice,
} from '~/snapchain/nodeChoice';

import { resolveProviderOrder } from './catalog';
import {
  DEFAULT_FAILOVER_CONFIG,
  type FailoverConfig,
  type FailoverState,
  initialFailoverState,
  nextFailoverState,
} from './failover';
import {
  combineFreshness,
  DEFAULT_HEALTH_CONFIG,
  type Freshness,
  type FreshnessRecord,
  type HealthConfig,
  judgeFreshness,
  judgeProbe,
  probeProvider,
  type ProbeSample,
  type ProviderHealth,
  type ShardSample,
} from './health';
import {
  loadProviderOrder,
  neynarApiKeyFromEnv,
  saveProviderOrder,
} from './preferences';
import type { NodeProvider } from './providerTypes';

export interface ProviderRuntimeSnapshot {
  order: NodeProvider[];
  health: Record<string, ProviderHealth>;
  /** Consecutive failed reads per provider, since the last good one. */
  readErrors: Record<string, number>;
  failover: FailoverState;
  /** The server answering right now, or null before the first check lands. */
  activeId: string | null;
  /** Why that server is the live one, in plain words. */
  explanation: string;
  /** True while a round of checks is in flight. */
  checking: boolean;
  lastCheckedAt: number | null;
  /** True when the reader turned the whole thing off. */
  paused: boolean;
}

export interface ProviderRuntimeOptions {
  fetchImpl?: typeof fetch;
  healthConfig?: HealthConfig;
  failoverConfig?: FailoverConfig;
  /** Test seam: skip the network entirely. */
  probe?: (provider: NodeProvider) => Promise<ProbeSample>;
  /** Test seam: no timers. */
  autoStart?: boolean;
}

let snapshot: ProviderRuntimeSnapshot = {
  order: [],
  health: {},
  readErrors: {},
  failover: initialFailoverState(0),
  activeId: null,
  explanation: '',
  checking: false,
  lastCheckedAt: null,
  paused: false,
};

/**
 * How many reads in a row may fail before a server that passed its last health
 * check counts as bad. Three is a pattern, not a blip: one route failing is the
 * client's own bug or a single flaky call, three in a row on a server that
 * claimed to be healthy is that server being unhealthy.
 */
export const READ_ERRORS_BEFORE_DOWN = 3;

const listeners = new Set<() => void>();
/**
 * What each watermark has been doing, keyed by provider — and, for a node that
 * reports shards, keyed per shard (`<providerId>#shard-<shardId>`). The shards
 * move independently, so they are judged independently (see `freshnessFor`).
 */
const freshnessByProvider = new Map<string, FreshnessRecord>();

let options: ProviderRuntimeOptions = {};
let fid: number | null = null;
let storedIds: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeChoice: (() => void) | null = null;
let running = false;
let checkInFlight: Promise<void> | null = null;

const notify = (): void => {
  listeners.forEach((listener) => listener());
};

const setSnapshot = (next: Partial<ProviderRuntimeSnapshot>): void => {
  snapshot = { ...snapshot, ...next };
  notify();
};

export const getProviderSnapshot = (): ProviderRuntimeSnapshot => snapshot;

export const subscribeToProviders = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const apiKey = (): string | null => neynarApiKeyFromEnv();

/** The reader's servers in order, as they stand right now. */
export const currentProviderOrder = (): NodeProvider[] =>
  resolveProviderOrder({
    chosen: getActiveNodeChoice(),
    storedIds,
    neynarConfigured: apiKey() !== null,
  });

const refreshOrder = (): NodeProvider[] => {
  const order = currentProviderOrder();
  setSnapshot({ order });
  return order;
};

const probe = async (provider: NodeProvider): Promise<ProbeSample> => {
  if (options.probe) {
    return options.probe(provider);
  }
  return probeProvider({
    provider,
    apiKey: apiKey(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    config: options.healthConfig ?? DEFAULT_HEALTH_CONFIG,
  });
};

/**
 * Freshness for one probe, judged shard by shard.
 *
 * A Snapchain node reports several shards whose heights move independently: a
 * maximum taken across them carries an advancing shard's progress forward while
 * a stopped one sits still, and the reader would be told the node is fresh. So
 * each shard keeps its own history and the worst shard decides
 * (`combineFreshness`). A server with no shards to report — Neynar — is judged
 * on its single watermark, exactly as before.
 */
const freshnessFor = ({
  providerId,
  sample,
  now,
  config,
}: {
  providerId: string;
  sample: ProbeSample;
  now: number;
  config: HealthConfig;
}): Freshness => {
  const shards = sample.shards.filter(
    (shard): shard is ShardSample & { maxHeight: number } =>
      shard.maxHeight !== null,
  );

  if (shards.length === 0) {
    const judgement = judgeFreshness(
      freshnessByProvider.get(providerId),
      sample.watermark,
      now,
      config,
    );
    freshnessByProvider.set(providerId, judgement.record);
    return judgement.freshness;
  }

  const judgements = shards.map((shard) => {
    const key = `${providerId}#shard-${shard.shardId ?? 'unnumbered'}`;
    const judgement = judgeFreshness(
      freshnessByProvider.get(key),
      shard.maxHeight,
      now,
      config,
    );
    freshnessByProvider.set(key, judgement.record);
    return judgement.freshness;
  });
  return combineFreshness(judgements);
};

/**
 * The health the failover decides on: what the last check measured, corrected by
 * what the reads have been doing since.
 *
 * A server whose reads have failed `READ_ERRORS_BEFORE_DOWN` times in a row is
 * down, whatever its last `/v1/info` said. That is the "repeated errors" half of
 * the switch rule: a node can answer a status check perfectly while every actual
 * read through it fails, and the reader should not be left on it because of that.
 */
const effectiveHealth = ({
  health,
  readErrors,
}: {
  health: Record<string, ProviderHealth>;
  readErrors: Record<string, number>;
}): Record<string, ProviderHealth> => {
  const merged: Record<string, ProviderHealth> = { ...health };
  for (const [providerId, errors] of Object.entries(readErrors)) {
    if (errors < READ_ERRORS_BEFORE_DOWN) {
      continue;
    }
    const previous = merged[providerId];
    merged[providerId] = {
      providerId,
      status: 'down',
      latencyMs: previous?.latencyMs ?? null,
      watermark: previous?.watermark ?? null,
      freshness: previous?.freshness ?? 'unknown',
      detail: `It stopped answering your reads — ${errors} in a row failed.`,
      checkedAt: Date.now(),
    };
  }
  return merged;
};

/** Run the decision on measurements already in hand, and publish it. */
const applyDecision = ({
  order,
  health,
  readErrors,
}: {
  order: NodeProvider[];
  health: Record<string, ProviderHealth>;
  readErrors: Record<string, number>;
}): void => {
  // The effective health is what everything downstream reads: the pill, the
  // picker and the next decision. Storing the raw probe result instead would
  // let a server that fails every read keep claiming it is answering normally.
  const effective = effectiveHealth({ health, readErrors });
  const decision = nextFailoverState({
    order,
    health: effective,
    state: snapshot.failover,
    now: Date.now(),
    config: options.failoverConfig ?? DEFAULT_FAILOVER_CONFIG,
  });

  setSnapshot({
    health: effective,
    failover: decision.state,
    activeId: decision.state.activeId,
    explanation: decision.explanation,
    checking: false,
    lastCheckedAt: Date.now(),
  });
};

/**
 * Tell the runtime how one read went.
 *
 * Called by the fetch seam for every request it answered. A success clears the
 * streak; a failure adds to it, and once the streak is long enough the decision
 * runs again immediately — a minute is too long to keep reading from a server
 * that is failing every request.
 */
export const noteProviderReadResult = ({
  providerId,
  ok,
}: {
  providerId: string;
  ok: boolean;
}): void => {
  if (snapshot.order.every((provider) => provider.id !== providerId)) {
    return;
  }

  const readErrors: Record<string, number> = { ...snapshot.readErrors };
  if (ok) {
    delete readErrors[providerId];
  } else {
    readErrors[providerId] = (readErrors[providerId] ?? 0) + 1;
  }
  setSnapshot({ readErrors });

  if (
    readErrors[providerId] !== undefined &&
    readErrors[providerId]! >= READ_ERRORS_BEFORE_DOWN
  ) {
    applyDecision({
      order: snapshot.order,
      health: snapshot.health,
      readErrors,
    });
  }
};

/** Consecutive failed reads for a provider, for the pill and for the picker. */
export const readErrorsFor = (providerId: string): number =>
  snapshot.readErrors[providerId] ?? 0;

/**
 * Run the decision on measurements already in hand, and publish it.
 */
export const decideFromCurrentHealth = (): void =>
  applyDecision({
    order: snapshot.order,
    health: snapshot.health,
    readErrors: snapshot.readErrors,
  });

/**
 * One round of checks: measure every server, then move the live one if the
 * measurements say to. The order is decided before the probes so a provider the
 * reader just added is measured in the same round it appears in.
 */
export const checkProvidersNow = async (): Promise<void> => {
  if (checkInFlight) {
    return checkInFlight;
  }
  const run = (async () => {
    const order = refreshOrder();
    if (order.length === 0) {
      setSnapshot({ checking: false });
      return;
    }

    setSnapshot({ checking: true });
    const healthConfig = options.healthConfig ?? DEFAULT_HEALTH_CONFIG;
    const results = await Promise.all(
      order.map(async (provider) => {
        const sample = await probe(provider);
        const now = Date.now();
        return judgeProbe({
          providerId: provider.id,
          sample,
          freshness: freshnessFor({
            providerId: provider.id,
            sample,
            now,
            config: healthConfig,
          }),
          config: healthConfig,
          now,
        });
      }),
    );

    const health: Record<string, ProviderHealth> = { ...snapshot.health };
    for (const entry of results) {
      health[entry.providerId] = entry;
    }

    // A server that just passed its health check starts with a clean slate on
    // read errors: the check is the newer evidence.
    const readErrors: Record<string, number> = { ...snapshot.readErrors };
    for (const entry of results) {
      delete readErrors[entry.providerId];
    }

    setSnapshot({ order, health, readErrors });
    applyDecision({ order, health, readErrors });
  })();

  checkInFlight = run.finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
};

/** The live server's descriptor, or null when nothing is live yet. */
export const getActiveProvider = (): NodeProvider | null => {
  const { activeId, order } = snapshot;
  if (activeId === null) {
    return order[0] ?? null;
  }
  return order.find((provider) => provider.id === activeId) ?? order[0] ?? null;
};

/** The provider that would answer next if the live one were skipped. */
export const getProviderById = (id: string | null): NodeProvider | null =>
  id === null
    ? null
    : (snapshot.order.find((provider) => provider.id === id) ?? null);

/**
 * Start watching. Loading the reader's stored order is part of starting, so a
 * caller that forgot to await anything still gets the right list.
 */
export const startProviderWatch = async (
  forFid: number | null,
  runtimeOptions: ProviderRuntimeOptions = {},
): Promise<void> => {
  options = runtimeOptions;
  if (forFid !== fid) {
    fid = forFid;
    storedIds = forFid === null ? [] : await loadProviderOrder(forFid);
    // A different account is a different list; judge nothing on the old one.
    freshnessByProvider.clear();
    snapshot = {
      ...snapshot,
      health: {},
      failover: initialFailoverState(Date.now()),
      activeId: null,
      explanation: '',
    };
  }

  if (unsubscribeChoice === null) {
    unsubscribeChoice = subscribeToNodeChoice(() => {
      // The reader changed where they read from: measure again now rather than
      // waiting out the interval, so the pill never shows a stale answer.
      void checkProvidersNow();
    });
  }

  if (running) {
    await checkProvidersNow();
    return;
  }

  running = true;
  setSnapshot({ paused: false });
  await checkProvidersNow();

  if (runtimeOptions.autoStart === false) {
    return;
  }
  const interval = (runtimeOptions.failoverConfig ?? DEFAULT_FAILOVER_CONFIG)
    .checkIntervalMs;
  timer = setInterval(() => {
    void checkProvidersNow();
  }, interval);
};

export const stopProviderWatch = (): void => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribeChoice !== null) {
    unsubscribeChoice();
    unsubscribeChoice = null;
  }
  running = false;
  checkInFlight = null;
};

/** Store the reader's order and use it at once. */
export const chooseProviderOrder = async (
  forFid: number,
  ids: string[],
): Promise<void> => {
  storedIds = ids;
  await saveProviderOrder(forFid, ids);
  // Only the running watch can act on this now; before it is started, the first
  // round of `startProviderWatch` reads the order that was just stored. Probing
  // here when nothing else is watching would also run without the caller's
  // fetch stubs — which in a test means hitting the real network.
  if (running) {
    await checkProvidersNow();
  }
};

/** Move one provider to the front of the reader's list. */
export const preferProvider = async (
  forFid: number,
  id: string,
): Promise<void> => {
  const rest = storedIds.filter((entry) => entry !== id);
  await chooseProviderOrder(forFid, [id, ...rest]);
};

export const isProviderIdStored = (id: string): boolean =>
  storedIds.includes(id);

/** The ids currently stored, for the picker's own rendering. */
export const storedProviderIds = (): string[] => [...storedIds];

/** Test seam: put the store back to nothing, with no timers running. */
export const resetProviderRuntimeForTests = (): void => {
  stopProviderWatch();
  snapshot = {
    order: [],
    health: {},
    readErrors: {},
    failover: initialFailoverState(0),
    activeId: null,
    explanation: '',
    checking: false,
    lastCheckedAt: null,
    paused: false,
  };
  freshnessByProvider.clear();
  fid = null;
  storedIds = [];
  options = {};
};
