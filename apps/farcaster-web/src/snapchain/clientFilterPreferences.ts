/**
 * The client filter the app is using right now, readable synchronously.
 *
 * Same two layers as the node choice (`nodeChoice.ts`), and for the same
 * reason:
 *
 *   storage  (`nodePreferences`) — per FID, survives reloads, validated on read
 *   active   (here)             — this tab's filter and labels, in memory
 *
 * The read seam (`~/snapchain/nodeApi/reads`) has to answer "which clients does
 * this reader want to see?" *during* a request, without suspending and without
 * awaiting storage — localforage is asynchronous, so a lookup inside a read
 * cannot be one. This module is the synchronous answer, kept in step with
 * storage by `loadActiveClientPreferences` (when the FID is known) and by
 * `applyClientFilterPolicy` / `applyClientLabels` (on save).
 *
 * One store, not three copies: the feed's filter, the settings card's controls
 * and the labels a cast is named with all read the same values, so a change can
 * never half-happen.
 */

import type { ClientFilterPolicy, KnownClients } from 'farcaster-node-client';

import {
  type ClientLabels,
  DEFAULT_FILTER_POLICY,
  loadClientLabels,
  loadFilterPolicy,
  saveClientLabels,
  saveFilterPolicy,
  toKnownClients,
} from './nodePreferences';

export interface ActiveClientPreferences {
  /** Whose preferences these are. */
  fid: number;
  /** Which clients' casts to show in a feed. */
  policy: ClientFilterPolicy;
  /** The reader's own names for apps, by app FID. */
  knownClients: KnownClients;
}

let active: ActiveClientPreferences | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  listeners.forEach((listener) => listener());
};

/**
 * The preferences in use, or `null` when none have been loaded.
 *
 * `null` is not "no filter": a signed-out read has no preferences at all, and
 * the honest answer for it is "show everything", which is what every caller
 * does with `null` (`clientFilterPolicyInUse` returns `undefined` for it).
 */
export const getActiveClientPreferences = (): ActiveClientPreferences | null =>
  active;

export const subscribeToClientPreferences = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setActive = (next: ActiveClientPreferences | null): void => {
  const same =
    active === next ||
    (active !== null &&
      next !== null &&
      active.fid === next.fid &&
      active.policy.mode === next.policy.mode &&
      active.policy.clientIds.join(',') === next.policy.clientIds.join(',') &&
      JSON.stringify(active.knownClients) ===
        JSON.stringify(next.knownClients));
  if (same) {
    return;
  }
  active = next;
  emit();
};

/**
 * What the read seam asks for: the filter in force, or `undefined` for "no
 * filter" — which covers both "nothing has been loaded yet" and "the reader
 * chose to see everything". Both answers mean the same thing to a feed, and
 * neither may be invented as a default that hides somebody's casts.
 */
export const clientFilterPolicyInUse = (): ClientFilterPolicy | undefined => {
  if (!active || active.policy.mode === 'all') {
    return undefined;
  }
  return active.policy;
};

/** The reader's own names for apps, as the resolver's `knownClients` map. */
export const knownClientsInUse = (): KnownClients => active?.knownClients ?? {};

/** Read this FID's filter and labels and make them the ones in use. */
export const loadActiveClientPreferences = async (
  fid: number,
): Promise<ActiveClientPreferences> => {
  const [policy, labels] = await Promise.all([
    loadFilterPolicy(fid),
    loadClientLabels(fid),
  ]);
  const next: ActiveClientPreferences = {
    fid,
    policy,
    knownClients: toKnownClients(labels),
  };
  setActive(next);
  return next;
};

/** Save the filter and apply it to the running session at once. */
export const applyClientFilterPolicy = async (
  fid: number,
  policy: ClientFilterPolicy,
): Promise<void> => {
  await saveFilterPolicy(fid, policy);
  setActive({
    fid,
    policy,
    knownClients: active?.fid === fid ? active.knownClients : {},
  });
};

/** Save the labels and apply them to the running session at once. */
export const applyClientLabels = async (
  fid: number,
  labels: ClientLabels,
): Promise<void> => {
  await saveClientLabels(fid, labels);
  setActive({
    fid,
    policy: active?.fid === fid ? active.policy : DEFAULT_FILTER_POLICY,
    knownClients: toKnownClients(labels),
  });
};

/**
 * Forget what was loaded — a different account's filter is a different
 * reader's business, and a session that ends must not leave the next one
 * filtering by somebody else's choices.
 */
export const resetActiveClientPreferences = (): void => {
  setActive(null);
};
