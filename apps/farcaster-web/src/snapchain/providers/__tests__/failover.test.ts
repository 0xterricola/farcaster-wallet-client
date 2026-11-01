/**
 * The failover engine's claims, as tests.
 *
 * Every rule the card promises is here: a first choice that gets slow, falls
 * behind or dies loses its place; coming back takes more than one good answer;
 * nothing moves inside the cooldown; and when there is nowhere better to go the
 * state says so instead of moving the feed to an equally bad server.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAILOVER_CONFIG,
  type FailoverState,
  initialFailoverState,
  isAcceptable,
  nextFailoverState,
} from '~/snapchain/providers/failover';
import type {
  ProviderHealth,
  ProviderStatus,
} from '~/snapchain/providers/health';
import type { NodeProvider } from '~/snapchain/providers/providerTypes';

const provider = (id: string, label = id): NodeProvider => ({
  id,
  kind: id === 'neynar' ? 'neynar' : 'snapchain',
  source: id === 'neynar' ? 'builtin' : 'own',
  label,
  detail: '',
  baseUrl: `https://${id}.example`,
  readOnly: false,
});

const order = [
  provider('mine', 'The node you run'),
  provider('relay', 'Our public node'),
];

const healthOf = (
  statuses: Record<string, ProviderStatus>,
  latency: Record<string, number> = {},
): Record<string, ProviderHealth> => {
  const health: Record<string, ProviderHealth> = {};
  for (const [id, status] of Object.entries(statuses)) {
    health[id] = {
      providerId: id,
      status,
      latencyMs: latency[id] ?? 200,
      watermark: null,
      freshness: 'fresh',
      detail: '',
      checkedAt: 0,
    };
  }
  return health;
};

const CONFIG = {
  ...DEFAULT_FAILOVER_CONFIG,
  cooldownMs: 60_000,
  recoveryChecks: 2,
};

describe('isAcceptable', () => {
  it('treats only a live server as good enough to stay on', () => {
    expect(isAcceptable('live')).toBe(true);
    expect(isAcceptable('slow')).toBe(false);
    expect(isAcceptable('stale')).toBe(false);
    expect(isAcceptable('down')).toBe(false);
    expect(isAcceptable(undefined)).toBe(false);
  });
});

describe('nextFailoverState: first decisions', () => {
  it('starts on the first choice when it is live', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: initialFailoverState(0),
      now: 1_000,
      config: CONFIG,
    });
    expect(decision.state.activeId).toBe('mine');
    expect(decision.switched).toBe(true);
    expect(decision.direction).toBe('held');
    expect(decision.explanation).toContain('first choice');
  });

  it('starts on the first server that answered when the first choice is down', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'down', relay: 'live' }),
      state: initialFailoverState(0),
      now: 1_000,
      config: CONFIG,
    });
    // The very first pick is not a "switch": there was nothing live before. It
    // is still reported as the first choice failing, because that is what the
    // reader is looking at — a backup answering while their node is down.
    expect(decision.state.activeId).toBe('relay');
    expect(decision.direction).toBe('held');
    expect(decision.state.reason).toBe('preferred-down');
    expect(decision.explanation).toContain(
      'your first choice stopped answering',
    );
  });

  it('keeps the first choice when nothing answers, and says so', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'down', relay: 'down' }),
      state: initialFailoverState(0),
      now: 1_000,
      config: CONFIG,
    });
    expect(decision.state.activeId).toBe('mine');
    expect(decision.state.reason).toBe('no-better-option');
    expect(decision.explanation).toContain(
      'nothing else on your list is answering either',
    );
  });
});

describe('nextFailoverState: switching down', () => {
  const live = (): FailoverState => ({
    activeId: 'mine',
    activeSince: 0,
    lastSwitchAt: 0,
    reason: 'start',
    preferredGoodChecks: 0,
  });

  it('switches on a first choice that got slow', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'slow', relay: 'live' }),
      state: live(),
      now: 120_000,
      config: CONFIG,
    });
    expect(decision.state.activeId).toBe('relay');
    expect(decision.switched).toBe(true);
    expect(decision.direction).toBe('down');
    expect(decision.state.reason).toBe('preferred-slow');
    expect(decision.explanation).toBe(
      'Switched to a backup node — your first choice got slow.',
    );
  });

  it('switches on a first choice that fell behind the network', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'stale', relay: 'live' }),
      state: live(),
      now: 120_000,
      config: CONFIG,
    });
    expect(decision.state.reason).toBe('preferred-stale');
    expect(decision.explanation).toContain(
      'stopped keeping up with the network',
    );
  });

  it('switches on a first choice that stopped answering', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'down', relay: 'live' }),
      state: live(),
      now: 120_000,
      config: CONFIG,
    });
    expect(decision.state.reason).toBe('preferred-down');
    expect(decision.explanation).toContain('stopped answering');
  });

  it('never walks past a good first choice to reach a later one', () => {
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: live(),
      now: 120_000,
      config: CONFIG,
    });
    expect(decision.switched).toBe(false);
    expect(decision.state.activeId).toBe('mine');
  });
});

describe('nextFailoverState: no flapping', () => {
  it('refuses to move inside the cooldown, and says why', () => {
    const state: FailoverState = {
      activeId: 'mine',
      activeSince: 0,
      // Just switched, one second ago.
      lastSwitchAt: 100_000,
      reason: 'start',
      preferredGoodChecks: 0,
    };
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'down', relay: 'live' }),
      state,
      now: 101_000,
      config: CONFIG,
    });
    expect(decision.switched).toBe(false);
    expect(decision.state.activeId).toBe('mine');
    expect(decision.state.reason).toBe('cooldown');
    expect(decision.explanation).toContain('flip back and forth');
  });

  it('holds a backup while the first choice wobbles, then returns after steady checks', () => {
    const onBackup: FailoverState = {
      activeId: 'relay',
      activeSince: 100_000,
      lastSwitchAt: 100_000,
      reason: 'preferred-down',
      preferredGoodChecks: 0,
    };

    // Check 1 (after the cooldown): the first choice answers again — one good
    // answer is not recovery.
    const first = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: onBackup,
      now: 200_000,
      config: CONFIG,
    });
    expect(first.switched).toBe(false);
    expect(first.state.preferredGoodChecks).toBe(1);

    // Check 2: still good — now it earns its place back.
    const second = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: first.state,
      now: 260_000,
      config: CONFIG,
    });
    expect(second.switched).toBe(true);
    expect(second.direction).toBe('up');
    expect(second.state.activeId).toBe('mine');
    expect(second.state.reason).toBe('backup-recovered');
    expect(second.explanation).toContain('answering again');
  });

  it('resets the recovery count when the first choice wobbles again', () => {
    const onBackup: FailoverState = {
      activeId: 'relay',
      activeSince: 100_000,
      lastSwitchAt: 100_000,
      reason: 'preferred-down',
      preferredGoodChecks: 1,
    };
    const wobbly = nextFailoverState({
      order,
      health: healthOf({ mine: 'slow', relay: 'live' }),
      state: onBackup,
      now: 200_000,
      config: CONFIG,
    });
    expect(wobbly.state.preferredGoodChecks).toBe(0);
    expect(wobbly.switched).toBe(false);
  });

  it('does not switch up inside the cooldown even when the first choice is healthy', () => {
    const onBackup: FailoverState = {
      activeId: 'relay',
      activeSince: 100_000,
      lastSwitchAt: 200_000,
      reason: 'preferred-down',
      preferredGoodChecks: 5,
    };
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: onBackup,
      now: 210_000,
      config: CONFIG,
    });
    expect(decision.switched).toBe(false);
    expect(decision.state.reason).toBe('cooldown');
  });
});

describe('nextFailoverState: what the pill says while a backup serves the reader', () => {
  it('never claims the first choice is answering when a backup is the one answering', () => {
    // The reader was on their first choice, then changed their list in
    // Advanced: the state still remembers `start` from before, while the first
    // choice has just been measured as slow. The old reason must not survive —
    // it reads "Everything you read comes from your first choice", which is a
    // claim about a server that is not the one answering.
    const stale: FailoverState = {
      activeId: 'relay',
      activeSince: 0,
      lastSwitchAt: 0,
      reason: 'start',
      preferredGoodChecks: 0,
    };
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'slow', relay: 'live' }),
      state: stale,
      now: 120_000,
      config: CONFIG,
    });

    expect(decision.state.activeId).toBe('relay');
    expect(decision.state.reason).toBe('preferred-slow');
    expect(decision.explanation).toContain('your first choice got slow');
    expect(decision.explanation).not.toContain('comes from your first choice');
  });

  it('names the failure for each way the first choice can fail', () => {
    const stale: FailoverState = {
      activeId: 'relay',
      activeSince: 0,
      lastSwitchAt: 0,
      reason: 'start',
      preferredGoodChecks: 0,
    };
    const words = (status: ProviderStatus): string =>
      nextFailoverState({
        order,
        health: healthOf({ mine: status, relay: 'live' }),
        state: stale,
        now: 120_000,
        config: CONFIG,
      }).explanation;

    expect(words('down')).toContain('stopped answering');
    expect(words('stale')).toContain('stopped keeping up');
    expect(words('unconfigured')).toContain('still needs your key');
  });

  it('says it is waiting out the hysteresis when the first choice is good again', () => {
    // The first choice is live but has not proven itself twice in a row yet, and
    // the old reason is not a failure of the first choice: the honest sentence is
    // that the client is staying put a little longer.
    const stale: FailoverState = {
      activeId: 'relay',
      activeSince: 0,
      lastSwitchAt: 0,
      reason: 'start',
      preferredGoodChecks: 0,
    };
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'live' }),
      state: stale,
      now: 120_000,
      config: CONFIG,
    });

    expect(decision.state.reason).toBe('cooldown');
    expect(decision.explanation).toContain('flip back and forth');
  });
});

describe('nextFailoverState: a backup that goes bad too', () => {
  it('moves to the next server down the list', () => {
    const three = [...order, provider('spare', 'A spare node')];
    const onBackup: FailoverState = {
      activeId: 'relay',
      activeSince: 0,
      lastSwitchAt: 0,
      reason: 'preferred-down',
      preferredGoodChecks: 0,
    };
    const decision = nextFailoverState({
      order: three,
      health: healthOf({ mine: 'down', relay: 'stale', spare: 'live' }),
      state: onBackup,
      now: 200_000,
      config: CONFIG,
    });
    expect(decision.state.activeId).toBe('spare');
    expect(decision.state.reason).toBe('backup-stale');
    expect(decision.explanation).toContain('stopped keeping up');
  });

  it('stays put and explains when nothing better is answering', () => {
    const onBackup: FailoverState = {
      activeId: 'relay',
      activeSince: 0,
      lastSwitchAt: 0,
      reason: 'preferred-down',
      preferredGoodChecks: 0,
    };
    const decision = nextFailoverState({
      order,
      health: healthOf({ mine: 'live', relay: 'down' }),
      state: onBackup,
      now: 200_000,
      config: CONFIG,
    });
    // The reader's first choice is healthy and sits ABOVE the live one, which
    // the recovery rule owns — a switch upward is never made on one check.
    expect(decision.state.activeId).toBe('relay');
    expect(decision.switched).toBe(false);
  });

  it('keeps the only server there is, whatever it is doing', () => {
    const decision = nextFailoverState({
      order: [provider('mine')],
      health: healthOf({ mine: 'down' }),
      state: {
        activeId: 'mine',
        activeSince: 0,
        lastSwitchAt: 0,
        reason: 'start',
        preferredGoodChecks: 0,
      },
      now: 200_000,
      config: CONFIG,
    });
    expect(decision.state.activeId).toBe('mine');
    expect(decision.switched).toBe(false);
    expect(decision.explanation).toContain('only server on your list');
  });
});
