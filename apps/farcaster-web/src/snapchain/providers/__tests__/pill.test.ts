/**
 * The pill's words, as tests.
 *
 * The pill is the only place a reader is told where their feed comes from, so
 * the two claims that matter are pinned here: it always names the server that is
 * answering, and when the engine moved to a backup it says why in plain words
 * (the sentence the user asked for: "switched to a backup node — your first
 * choice got slow").
 */

import { describe, expect, it } from 'vitest';

import {
  farcasterPublicProvider,
  ownNodeProvider,
  publicNodeProvider,
} from '~/snapchain/providers/catalog';
import type { FailoverState } from '~/snapchain/providers/failover';
import type { ProviderHealth } from '~/snapchain/providers/health';
import { providerPillView } from '~/snapchain/providers/pill';
import type { ProviderRuntimeSnapshot } from '~/snapchain/providers/runtime';

const health = (
  providerId: string,
  status: ProviderHealth['status'],
  detail = '',
): ProviderHealth => ({
  providerId,
  status,
  latencyMs: 300,
  watermark: 10,
  freshness: 'fresh',
  detail,
  checkedAt: 0,
});

const failover = (
  activeId: string | null,
  reason: FailoverState['reason'],
): FailoverState => ({
  activeId,
  activeSince: 0,
  lastSwitchAt: null,
  reason,
  preferredGoodChecks: 0,
});

const snapshot = (
  overrides: Partial<ProviderRuntimeSnapshot> &
    Pick<ProviderRuntimeSnapshot, 'order'>,
): ProviderRuntimeSnapshot => ({
  health: {},
  readErrors: {},
  failover: failover(overrides.order[0]?.id ?? null, 'start'),
  activeId: overrides.order[0]?.id ?? null,
  explanation: '',
  checking: false,
  lastCheckedAt: 0,
  paused: false,
  ...overrides,
});

describe('providerPillView', () => {
  it('says the truth before anything has been measured', () => {
    const view = providerPillView(snapshot({ order: [], activeId: null }));
    expect(view.state).toBe('checking');
    expect(view.label).toContain('Checking');
  });

  it('names the node the reader runs, when that is the one answering', () => {
    const provider = ownNodeProvider('https://mine.example');
    const view = providerPillView(
      snapshot({
        order: [provider, farcasterPublicProvider()],
        activeId: provider.id,
        health: { [provider.id]: health(provider.id, 'live') },
      }),
    );
    expect(view.state).toBe('served');
    expect(view.label).toBe('Answers come from the node you run');
    expect(view.shortLabel).toBe('Your own');
  });

  it('calls a public node a public node, never the reader’s own', () => {
    const provider = publicNodeProvider('https://haatz.quilibrium.com');
    const view = providerPillView(
      snapshot({
        order: [provider],
        activeId: provider.id,
        health: { [provider.id]: health(provider.id, 'live') },
      }),
    );
    expect(view.label).toBe('Answers come from a public node');
    expect(view.shortLabel).toBe('Public');
  });

  it('says the feed moved to a backup, and why', () => {
    const mine = ownNodeProvider('https://mine.example');
    const backup = farcasterPublicProvider();
    const view = providerPillView(
      snapshot({
        order: [mine, backup],
        activeId: backup.id,
        explanation: 'Switched to a backup node — your first choice got slow.',
        failover: failover(backup.id, 'preferred-slow'),
        health: {
          [mine.id]: health(
            mine.id,
            'slow',
            'Answering, but slowly — about 6.5s.',
          ),
          [backup.id]: health(backup.id, 'live'),
        },
      }),
    );
    expect(view.state).toBe('switched');
    expect(view.shortLabel).toBe('Backup');
    expect(view.label).toBe(
      'Switched to a backup node — your first choice got slow.',
    );
    expect(view.title).toContain('Everything you read now comes from');
  });

  it('does not call a healthy first choice a backup', () => {
    const mine = ownNodeProvider('https://mine.example');
    const backup = farcasterPublicProvider();
    const view = providerPillView(
      snapshot({
        order: [mine, backup],
        activeId: mine.id,
        explanation: 'Your first choice is answering, so nothing moved.',
        health: {
          [mine.id]: health(mine.id, 'live'),
          [backup.id]: health(backup.id, 'live'),
        },
      }),
    );
    expect(view.state).toBe('served');
    expect(view.label).toBe('Answers come from the node you run');
  });

  it('says a single offline server is offline instead of claiming it works', () => {
    const mine = ownNodeProvider('https://mine.example');
    const view = providerPillView(
      snapshot({
        order: [mine],
        activeId: mine.id,
        explanation: 'Kept this one — it is the only server on your list.',
        health: {
          [mine.id]: health(mine.id, 'down', 'It did not answer at all.'),
        },
      }),
    );
    expect(view.state).toBe('unreachable');
    expect(view.label).toContain('offline');
    expect(view.title).toBe('It did not answer at all.');
  });

  it('keeps a sentence in the title even when the server is only slow', () => {
    const mine = ownNodeProvider('https://mine.example');
    const view = providerPillView(
      snapshot({
        order: [mine],
        activeId: mine.id,
        health: {
          [mine.id]: health(
            mine.id,
            'slow',
            'Answering, but slowly — about 6.5s.',
          ),
        },
      }),
    );
    expect(view.title).toContain('6.5s');
  });

  it('carries the measured freshness sentence when a node is hours behind', () => {
    // MEASURED (2026-10-24 16:27 UTC, https://haatz.quilibrium.com): the node
    // answered while shards 1 and 2 were 4h 39m and 13m 15s behind. That
    // sentence is what the reader gets when their feed is served from it, and
    // the pill has to hold it verbatim — the number comes from the node.
    const relay = publicNodeProvider('https://haatz.quilibrium.com');
    const view = providerPillView(
      snapshot({
        order: [relay, farcasterPublicProvider()],
        activeId: relay.id,
        explanation:
          'Our public node stopped keeping up with the network — but nothing else on your list is answering either, so nothing moved.',
        health: {
          [relay.id]: health(
            relay.id,
            'stale',
            'It answered, but the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old.',
          ),
        },
      }),
    );
    expect(view.title).toContain(
      'It answered, but the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old.',
    );
    expect(view.title).toContain('is still the one answering');
  });
});
