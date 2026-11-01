/**
 * Which server should answer *right now* — the decision, and nothing else.
 *
 * The reader's list is a preference, not a promise: it says what they would like
 * first, and this is what happens when that first choice stops being good. Three
 * rules, in the order they matter:
 *
 *   DOWN, on a real fault. A first choice that stopped answering, fell behind
 *   the network, or got slow loses its place to the next server down the list.
 *   "Slow" means a measured answer worse than the threshold — the same number
 *   the pill shows, never a hunch.
 *
 *   UP, but only after it has actually recovered. Coming back to the first
 *   choice takes `recoveryChecks` good checks in a row. One good answer after a
 *   wobble is not recovery, and switching on it is how a client flaps.
 *
 *   NEVER INSIDE THE COOLDOWN. No switch of any kind within `cooldownMs` of the
 *   last one. A server that is up, slow, up again would otherwise move the feed
 *   between two machines every minute; the cooldown makes the cost of a switch
 *   real. While the cooldown holds, the state says so in plain words instead of
 *   pretending nothing is wrong.
 *
 * The state is plain data and the transition is a pure function, so every one
 * of those claims is a test rather than a story about how it usually behaves.
 */

import type { ProviderHealth, ProviderStatus } from './health';
import type { NodeProvider } from './providerTypes';

export interface FailoverConfig {
  /** No switch within this long of the last one. */
  cooldownMs: number;
  /** Good checks in a row before the reader's first choice gets its place back. */
  recoveryChecks: number;
  /** How often the checks run while the client is open. */
  checkIntervalMs: number;
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  // One minute: long enough that a wobbly server cannot move the feed twice in
  // a row, short enough that a genuinely dead one is left quickly.
  cooldownMs: 60_000,
  recoveryChecks: 2,
  checkIntervalMs: 60_000,
};

/** Why the live server is the live one. */
export type SwitchReason =
  | 'start'
  | 'first-choice'
  | 'preferred-slow'
  | 'preferred-stale'
  | 'preferred-down'
  | 'preferred-unconfigured'
  | 'backup-slow'
  | 'backup-stale'
  | 'backup-down'
  | 'backup-recovered'
  | 'cooldown'
  | 'no-better-option';

export interface FailoverState {
  activeId: string | null;
  /** When the live server became live. */
  activeSince: number;
  lastSwitchAt: number | null;
  reason: SwitchReason;
  /** Consecutive good checks for the first choice, while a backup is live. */
  preferredGoodChecks: number;
}

export type SwitchDirection = 'down' | 'up' | 'held';

export interface FailoverDecision {
  state: FailoverState;
  switched: boolean;
  direction: SwitchDirection;
  /** One sentence, plain words: "switched to a backup node — your first choice got slow". */
  explanation: string;
}

/** Is this status good enough to stay on when a better server exists? */
export const isAcceptable = (status: ProviderStatus | undefined): boolean =>
  status === 'live';

const reasonForFailure = (
  status: ProviderStatus,
  onFirstChoice: boolean,
): SwitchReason => {
  const suffix =
    status === 'stale'
      ? 'stale'
      : status === 'down'
        ? 'down'
        : status === 'unconfigured'
          ? 'unconfigured'
          : 'slow';
  if (onFirstChoice) {
    return `preferred-${suffix}` as SwitchReason;
  }
  return `backup-${suffix}` as SwitchReason;
};

const failureWords = (status: ProviderStatus): string => {
  switch (status) {
    case 'stale':
      return 'stopped keeping up with the network';
    case 'down':
      return 'stopped answering';
    case 'unconfigured':
      return 'still needs your key';
    case 'slow':
    default:
      return 'got slow';
  }
};

export const explainReason = (
  reason: SwitchReason,
  howManyServers: number,
): string => {
  switch (reason) {
    case 'start':
      return 'Everything you read comes from your first choice.';
    case 'first-choice':
      return 'Your first choice is answering, so nothing moved.';
    case 'preferred-slow':
      return 'Switched to a backup node — your first choice got slow.';
    case 'preferred-stale':
      return 'Switched to a backup node — your first choice stopped keeping up with the network.';
    case 'preferred-down':
      return 'Switched to a backup node — your first choice stopped answering.';
    case 'preferred-unconfigured':
      return 'Switched to a backup node — your first choice still needs your key.';
    case 'backup-slow':
      return 'Switched again — the node you were on got slow.';
    case 'backup-stale':
      return 'Switched again — the node you were on stopped keeping up with the network.';
    case 'backup-down':
      return 'Switched again — the node you were on stopped answering.';
    case 'backup-recovered':
      return 'Back on your first choice — it is answering again.';
    case 'cooldown':
      return 'Staying here a little longer so the client does not flip back and forth.';
    case 'no-better-option':
    default:
      return howManyServers > 1
        ? 'Kept this one — nothing else on your list is answering either.'
        : 'Kept this one — it is the only server on your list.';
  }
};

const initialState = (now: number): FailoverState => ({
  activeId: null,
  activeSince: now,
  lastSwitchAt: null,
  reason: 'start',
  preferredGoodChecks: 0,
});

/**
 * Advance the decision.
 *
 * `health` is keyed by provider id; a provider with no entry yet is treated as
 * unknown and is never promoted over one that answered.
 */
export const nextFailoverState = ({
  order,
  health,
  state,
  now,
  config = DEFAULT_FAILOVER_CONFIG,
}: {
  order: NodeProvider[];
  health: Record<string, ProviderHealth>;
  state: FailoverState;
  now: number;
  config?: FailoverConfig;
}): FailoverDecision => {
  const ids = order.map((provider) => provider.id);
  const previous = state ?? initialState(now);
  const statusOf = (id: string): ProviderStatus | undefined =>
    health[id]?.status;

  if (ids.length === 0) {
    return {
      state: { ...previous, activeId: null, reason: 'start' },
      switched: previous.activeId !== null,
      direction: 'held',
      explanation: 'There is no server to read from yet.',
    };
  }

  const labelOf = (id: string): string =>
    order.find((provider) => provider.id === id)?.label ?? 'that server';

  // ── nothing live yet: take the best available, first choice first ─────────
  if (previous.activeId === null || !ids.includes(previous.activeId)) {
    const firstLive = ids.find((id) => isAcceptable(statusOf(id)));
    const activeId = firstLive ?? ids[0]!;
    const skippedFirstChoice = activeId !== ids[0];
    // Starting on a backup is still a story worth telling: the reader's first
    // choice was measured and skipped, and the pill says which way it failed
    // rather than presenting the backup as if it were the first choice.
    const reason: SwitchReason = skippedFirstChoice
      ? reasonForFailure(statusOf(ids[0]!) ?? 'down', true)
      : statusOf(activeId) === 'unconfigured'
        ? 'preferred-unconfigured'
        : firstLive
          ? 'start'
          : 'no-better-option';
    return {
      state: {
        activeId,
        activeSince: now,
        lastSwitchAt: previous.lastSwitchAt,
        reason,
        preferredGoodChecks: 0,
      },
      switched: previous.activeId !== activeId,
      direction: 'held',
      explanation: explainReason(reason, ids.length),
    };
  }

  const activeId = previous.activeId;
  const activeIndex = ids.indexOf(activeId);
  const activeStatus = statusOf(activeId) ?? 'down';

  // ── the live server is fine ───────────────────────────────────────────────
  if (isAcceptable(activeStatus)) {
    if (activeIndex === 0) {
      return {
        state: { ...previous, reason: 'first-choice', preferredGoodChecks: 0 },
        switched: false,
        direction: 'held',
        explanation: explainReason('first-choice', ids.length),
      };
    }

    // On a backup: the first choice only gets its place back after it has been
    // good several checks in a row, and never inside the cooldown.
    const preferredId = ids[0]!;
    const preferredGood = isAcceptable(statusOf(preferredId));
    const goodChecks = preferredGood ? previous.preferredGoodChecks + 1 : 0;
    const withinCooldown =
      previous.lastSwitchAt !== null &&
      now - previous.lastSwitchAt < config.cooldownMs;

    if (
      preferredGood &&
      goodChecks >= config.recoveryChecks &&
      !withinCooldown
    ) {
      return {
        state: {
          activeId: preferredId,
          activeSince: now,
          lastSwitchAt: now,
          reason: 'backup-recovered',
          preferredGoodChecks: 0,
        },
        switched: true,
        direction: 'up',
        explanation: explainReason('backup-recovered', ids.length),
      };
    }

    const heldReason: SwitchReason = !preferredGood
      ? // A backup is serving the reader and their first choice is measured and
        // not good enough. The pill has to say which way it failed: holding the
        // old reason here (often `start`, which reads "Everything you read comes
        // from your first choice") would describe a server that is not the one
        // answering.
        reasonForFailure(statusOf(preferredId) ?? 'down', true)
      : withinCooldown ||
          previous.reason === 'start' ||
          previous.reason === 'first-choice'
        ? // The first choice is answering again but has not proved itself the
          // required number of checks in a row, so the reader is still on a
          // backup: that is the hysteresis rule, and this says so in plain words.
          'cooldown'
        : previous.reason;

    return {
      state: {
        ...previous,
        reason: heldReason,
        preferredGoodChecks: goodChecks,
      },
      switched: false,
      direction: 'held',
      explanation: explainReason(heldReason, ids.length),
    };
  }

  // ── the live server is not good enough ────────────────────────────────────
  const withinCooldown =
    previous.lastSwitchAt !== null &&
    now - previous.lastSwitchAt < config.cooldownMs;
  if (withinCooldown) {
    return {
      state: { ...previous, reason: 'cooldown', preferredGoodChecks: 0 },
      switched: false,
      direction: 'held',
      explanation: explainReason('cooldown', ids.length),
    };
  }

  const candidateIndex = ids.findIndex(
    (id, index) => index > activeIndex && isAcceptable(statusOf(id)),
  );
  if (candidateIndex === -1) {
    // One server on the list is a special case worth saying out loud: there is
    // nothing to fail over TO, and the reader should hear that rather than
    // wonder why nothing moved.
    if (ids.length === 1) {
      return {
        state: {
          ...previous,
          reason: 'no-better-option',
          preferredGoodChecks: 0,
        },
        switched: false,
        direction: 'held',
        explanation: `${labelOf(activeId)} ${failureWords(activeStatus)} — and it is the only server on your list, so nothing moved.`,
      };
    }
    const reason: SwitchReason =
      previous.reason === 'start' || previous.reason === 'first-choice'
        ? reasonForFailure(activeStatus, activeIndex === 0)
        : 'no-better-option';
    return {
      state: { ...previous, reason, preferredGoodChecks: 0 },
      switched: false,
      direction: 'held',
      // Say what actually happened to the server we are on, then be honest that
      // there is nowhere better to go.
      explanation:
        activeIndex === 0
          ? `${labelOf(activeId)} ${failureWords(activeStatus)} — but nothing else on your list is answering either, so nothing moved.`
          : `${labelOf(activeId)} ${failureWords(activeStatus)} — and nothing better is answering either, so nothing moved.`,
    };
  }

  const nextId = ids[candidateIndex]!;
  const reason = reasonForFailure(activeStatus, activeIndex === 0);
  return {
    state: {
      activeId: nextId,
      activeSince: now,
      lastSwitchAt: now,
      reason,
      preferredGoodChecks: 0,
    },
    switched: true,
    direction: 'down',
    explanation: explainReason(reason, ids.length),
  };
};

export const initialFailoverState = initialState;
