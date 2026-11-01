// @vitest-environment jsdom
/**
 * The list, as the reader sees it.
 *
 * What matters here: the row that is live says so, a server that failed its last
 * check is not dressed up as working, a Neynar row that has no key says it needs
 * one, and a server further down the list offers the one action that matters —
 * try this one first. The snapshot is injected (test seam), so nothing here
 * touches the network or the clock.
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
  publicNodeProvider,
} from '~/snapchain/providers/catalog';
import type { FailoverState } from '~/snapchain/providers/failover';
import type { ProviderHealth } from '~/snapchain/providers/health';
import type { ProviderRuntimeSnapshot } from '~/snapchain/providers/runtime';

import { ProviderListCard, providerStatusWord } from './ProviderListCard';

afterEach(cleanup);

const failover = (activeId: string | null): FailoverState => ({
  activeId,
  activeSince: 0,
  lastSwitchAt: null,
  reason: 'preferred-down',
  preferredGoodChecks: 0,
});

const health = (
  providerId: string,
  status: ProviderHealth['status'],
  detail: string,
): ProviderHealth => ({
  providerId,
  status,
  latencyMs: 200,
  watermark: 1,
  freshness: 'fresh',
  detail,
  checkedAt: 0,
});

const build = (
  overrides: Partial<ProviderRuntimeSnapshot> = {},
): ProviderRuntimeSnapshot => {
  const mine = ownNodeProvider('https://mine.example');
  const backup = farcasterPublicProvider();
  return {
    order: [mine, backup],
    health: {
      [mine.id]: health(mine.id, 'down', 'It did not answer at all.'),
      [backup.id]: health(
        backup.id,
        'live',
        'Answering normally, in about 0.2s.',
      ),
    },
    readErrors: {},
    failover: failover(backup.id),
    activeId: backup.id,
    explanation:
      'Switched to a backup node — your first choice stopped answering.',
    checking: false,
    lastCheckedAt: 0,
    paused: false,
    ...overrides,
  };
};

describe('providerStatusWord', () => {
  it('says what each status means without a protocol word', () => {
    expect(providerStatusWord('live')).toBe('working');
    expect(providerStatusWord('slow')).toBe('working, but slowly');
    expect(providerStatusWord('stale')).toBe('behind the network');
    expect(providerStatusWord('down')).toBe('not answering');
    expect(providerStatusWord('unconfigured')).toBe('needs a key');
    expect(providerStatusWord(undefined)).toBe('not checked yet');
  });
});

describe('ProviderListCard', () => {
  it('tells the reader the feed moved to a backup, and why', () => {
    render(<ProviderListCard fid={undefined} snapshot={build()} />);
    expect(
      screen.getByText(
        'Switched to a backup node — your first choice stopped answering.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('in use')).toBeTruthy();
  });

  it('names each server’s status in plain words', () => {
    render(<ProviderListCard fid={undefined} snapshot={build()} />);
    expect(screen.getByText('working')).toBeTruthy();
    expect(screen.getByText('not answering')).toBeTruthy();
  });

  it('offers the one action that matters for a server further down the list', () => {
    const onPrefer = vi.fn();
    const mine = ownNodeProvider('https://mine.example');
    render(
      <ProviderListCard
        fid={undefined}
        snapshot={build({
          order: [mine, farcasterPublicProvider()],
          activeId: mine.id,
          explanation: 'Your first choice is answering, so nothing moved.',
        })}
        onPrefer={onPrefer}
      />,
    );
    const button = screen.getByText('Try this one first');
    button.click();
    expect(onPrefer).toHaveBeenCalledTimes(1);
    expect(onPrefer.mock.calls[0]![0].id).toContain('farcaster-public');
  });

  it('says a Neynar row needs a key rather than showing it as usable', () => {
    const neynar = neynarProvider();
    render(
      <ProviderListCard
        fid={undefined}
        snapshot={build({
          order: [neynar],
          activeId: neynar.id,
          health: {
            [neynar.id]: health(
              neynar.id,
              'unconfigured',
              'Neynar needs your key before it can be used.',
            ),
          },
          explanation: '',
        })}
      />,
    );
    expect(screen.getByText('needs a key')).toBeTruthy();
    expect(
      screen.getByText('Neynar needs your key before it can be used.'),
    ).toBeTruthy();
  });

  it('shows a stale row behind the network, with the node’s own numbers', () => {
    // The sentence the client composes for a node that answers while a shard is
    // hours behind (MEASURED 2026-10-24 16:27 UTC, the public node). It has to
    // reach this row verbatim: this is where a reader goes to find out why their
    // feed looks quiet.
    const relay = publicNodeProvider('https://haatz.quilibrium.com');
    render(
      <ProviderListCard
        fid={undefined}
        snapshot={build({
          order: [relay, farcasterPublicProvider()],
          activeId: relay.id,
          health: {
            [relay.id]: health(
              relay.id,
              'stale',
              'It answered, but the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old.',
            ),
          },
          explanation: '',
        })}
      />,
    );
    expect(screen.getByText('behind the network')).toBeTruthy();
    expect(
      screen.getByText(
        'It answered, but the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old.',
      ),
    ).toBeTruthy();
  });

  it('says nothing has been measured yet instead of implying it works', () => {
    render(
      <ProviderListCard
        fid={undefined}
        snapshot={build({ order: [], activeId: null })}
      />,
    );
    expect(screen.getByText('Checking your servers…')).toBeTruthy();
    expect(screen.getByText(/Nothing to read from yet/)).toBeTruthy();
  });
});
