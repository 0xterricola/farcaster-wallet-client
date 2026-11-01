// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { NodeHealth } from 'farcaster-node-client';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  nodePillState,
  NodeStatusPillView,
} from '~/components/snapchain/NodeStatusPill';

// The pill links into the router; the anchor is all this test needs from it.
vi.mock('~/components/links/Link', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({
      children,
      title,
      className,
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
      title: string;
      params: unknown;
      searchParams: unknown;
      to: string;
    }) =>
      createElement(
        'a',
        { href: '/~/settings/node', title, className },
        children,
      ),
  };
});

const health = (ok: boolean, version = '0.13.5'): NodeHealth => ({
  ok,
  baseUrl: 'https://node.example.com',
  latencyMs: 12,
  ...(ok ? { info: { version, numShards: 2 } as NodeHealth['info'] } : {}),
});

afterEach(cleanup);

describe('nodePillState', () => {
  it('never claims your node when no node is configured', () => {
    expect(
      nodePillState({ configured: false, loading: false, health: null }),
    ).toBe('relay');
    // Even a stale healthy reading must not upgrade a build with no node.
    expect(
      nodePillState({
        configured: false,
        loading: false,
        health: health(true),
      }),
    ).toBe('relay');
  });

  it('is checking while the first call is in flight', () => {
    expect(
      nodePillState({ configured: true, loading: true, health: null }),
    ).toBe('checking');
  });

  it('says served only when the node answered', () => {
    expect(
      nodePillState({ configured: true, loading: false, health: health(true) }),
    ).toBe('served');
  });

  it('says unreachable when a configured node failed or stopped answering', () => {
    expect(
      nodePillState({
        configured: true,
        loading: false,
        health: health(false),
      }),
    ).toBe('unreachable');
    // A previous healthy reading followed by a failed refresh is still a
    // failed refresh: the pill reports the last call, not a memory of success.
    expect(
      nodePillState({
        configured: true,
        loading: true,
        health: health(false),
      }),
    ).toBe('unreachable');
  });
});

describe('NodeStatusPillView', () => {
  it('names your own setup, with the version and no shard count', () => {
    render(
      <NodeStatusPillView state="served" health={health(true, '0.13.4')} />,
    );
    expect(
      screen.getByText('Answers come from your own setup · v0.13.4'),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('your own setup');
  });

  it('never uses infrastructure words a first-time owner would not know', () => {
    const seen = new Set<string>();
    for (const state of [
      'checking',
      'served',
      'unreachable',
      'relay',
    ] as const) {
      const { unmount } = render(
        <NodeStatusPillView
          state={state}
          health={health(state === 'served')}
        />,
      );
      seen.add(
        `${screen.getByRole('status').textContent ?? ''} ${
          screen.getByRole('link').getAttribute('title') ?? ''
        }`,
      );
      unmount();
    }
    const all = [...seen].join(' ').toLowerCase();
    for (const jargon of [
      'node',
      'snapchain',
      'relay',
      'shard',
      'scope',
      'ttl',
      'signer',
      'gasless',
      '/v1/',
    ]) {
      expect(all).not.toContain(jargon);
    }
  });

  it('says Fiddy serves it, and never claims your own, when there is none', () => {
    render(<NodeStatusPillView state="relay" health={null} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toBe('Answers come from Fiddy');
    expect(text.toLowerCase()).not.toContain('your own');
  });

  it('says unreachable in words, so a fallback is never silent', () => {
    render(<NodeStatusPillView state="unreachable" health={health(false)} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Your own setup is offline',
    );
  });

  it('shortens to one word for the phone top bar', () => {
    render(<NodeStatusPillView state="served" health={health(true)} short />);
    expect(screen.getByRole('status').textContent).toBe('Your own');
  });

  it('links to the advanced surface in every state', () => {
    render(<NodeStatusPillView state="relay" health={null} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/~/settings/node',
    );
  });

  it('says a public server when a public one answered, not your own setup', () => {
    render(
      <NodeStatusPillView state="served" health={health(true)} kind="public" />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Answers come from a public server · v0.13.5',
    );
  });

  it('keeps saying your own setup when that is the one that answered', () => {
    render(
      <NodeStatusPillView state="served" health={health(true)} kind="own" />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Answers come from your own setup · v0.13.5',
    );
  });

  it('does not let a public server borrow the words for a machine you own', () => {
    render(
      <NodeStatusPillView
        state="unreachable"
        health={health(false)}
        kind="public"
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'That public server is offline',
    );
    // And the phone-length version still says which kind it was.
    render(
      <NodeStatusPillView
        state="served"
        health={health(true)}
        kind="public"
        short
      />,
    );
    expect(screen.getAllByRole('status')[1].textContent).toBe('Public');
  });

  it('keeps the jargon ban once a server has been chosen', () => {
    const seen = new Set<string>();
    for (const kind of ['public', 'own'] as const) {
      for (const state of [
        'checking',
        'served',
        'unreachable',
        'relay',
      ] as const) {
        const { unmount } = render(
          <NodeStatusPillView
            state={state}
            health={health(state === 'served')}
            kind={kind}
          />,
        );
        seen.add(
          `${screen.getByRole('status').textContent ?? ''} ${
            screen.getByRole('link').getAttribute('title') ?? ''
          }`,
        );
        unmount();
      }
    }
    const all = [...seen].join(' ').toLowerCase();
    for (const jargon of [
      'node',
      'snapchain',
      'relay',
      'shard',
      'scope',
      'ttl',
      'signer',
      'gasless',
      '/v1/',
    ]) {
      expect(all).not.toContain(jargon);
    }
  });
});
