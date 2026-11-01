// @vitest-environment jsdom
/**
 * The rail's "Spaces" entry must reach the surface that can make a space.
 *
 * This is the bug, at the point it was reported: signed in on fiddy.fun,
 * "creating a space" threw `createAudioRoom 501 — … nothing was signed and
 * nothing was sent`, because the entry named Spaces pointed at the fork's
 * audio-room list, whose create button asked for a write no node can carry.
 * Fiddy's spaces are Together (`/~together`): name one, a Farcaster identity
 * joins it, a board is shared.
 *
 * Pinned here: the Spaces entry is the Together route; the audio-room surface
 * is named where it would have sat and is NOT a link (the same shape the Direct
 * Casts entry already uses when a node cannot serve the inbox); and no entry in
 * the rail points at the audio-room list.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('farcaster-client-hooks', () => ({
  useUnseen: () => ({
    notificationsCount: 0,
    inboxCount: 0,
    channelFeedsUnseenStatus: {},
    countsUnavailable: false,
  }),
}));

vi.mock('~/contexts/UserAppContextProvider', () => ({
  useUserAppContext: () => ({ developerModeEnabled: false }),
}));

vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => ({
    pfp: undefined,
    displayName: 'A tester',
    username: 'tester',
  }),
}));

vi.mock('~/hooks/navigation/useCurrentUserProfileCastsLinkProps', () => ({
  useCurrentUserProfileCastsLinkProps: () => ({ to: 'profileCasts' }),
}));

// The rail's own entries are the subject; everything around them is stubbed so
// a failure here is about the nav, not about a neighbouring component.
vi.mock('~/components/agent/AgentNavItem', () => ({
  AgentNavEntry: () => null,
}));
vi.mock('~/components/avatar/AvatarImage', () => ({ AvatarImage: () => null }));
vi.mock('~/components/fiddy/accounts/AccountSwitcher', () => ({
  AccountSwitcherEntry: () => null,
}));
vi.mock('~/components/sidebar/ChannelNavLinks', () => ({
  ChannelNavLinks: () => null,
}));
vi.mock('~/components/snapchain/NodeStatusPill', () => ({
  NodeStatusPill: () => null,
}));
vi.mock('~/layouts/LeftSideBar', () => ({
  LeftSideBar: ({ children }: { children: React.ReactNode }) =>
    React.createElement('nav', { 'data-fiddy': 'rail' }, children),
}));
vi.mock('~/layouts/LeftSideBarLogo', () => ({
  LeftSideBarLogo: () => null,
}));
vi.mock('~/components/links/NavLinkIcon', () => ({
  NavLinkIcon: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));
vi.mock('~/components/links/NavLinkLabel', () => ({
  NavLinkLabel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));
vi.mock('~/components/links/NavLinkBadge', () => ({
  NavLinkBadge: () => null,
}));
vi.mock('~/components/links/NavLink', () => ({
  NavLink: ({
    to,
    title,
    children,
  }: {
    to: string;
    title?: string;
    children: React.ReactNode;
  }) =>
    React.createElement(
      'a',
      { 'data-nav': to, title, href: `#${to}` },
      children,
    ),
}));

const { AuthedLeftSideBar } = await import('~/layouts/AuthedLeftSideBar');

/** Every route this rail can navigate to. */
const entries = () =>
  Array.from(document.querySelectorAll('a[data-nav]')).map((anchor) =>
    anchor.getAttribute('data-nav'),
  );

describe('the rail’s Spaces entry', () => {
  it('goes to Together, where a space can actually be made', () => {
    render(<AuthedLeftSideBar />);

    const spaces = screen.getByTitle('Spaces');

    expect(spaces.getAttribute('data-nav')).toBe('together');
  });

  it('never routes anyone to the audio-room list', () => {
    render(<AuthedLeftSideBar />);

    expect(entries()).not.toContain('spacesDiscovery');
  });

  it('names audio rooms where the entry used to sit instead of linking them', () => {
    render(<AuthedLeftSideBar />);

    const note = screen.getByText('Audio rooms').closest('[role="status"]');

    expect(note?.getAttribute('data-fiddy')).toBe('audio-rooms-soon');
  });
});
