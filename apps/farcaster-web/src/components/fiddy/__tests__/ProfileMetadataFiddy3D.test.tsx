// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ApiUserProfile } from 'farcaster-client-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStoredFiddy3DFid } from '~/components/fiddy/fiddy3DProfile';

const state = vi.hoisted(() => ({
  currentFid: 123,
  user: {
    fid: 123,
    displayName: 'Own User',
    pfp: { url: 'https://example.com/pfp.png' },
  } as {
    fid: number;
    displayName: string;
    pfp?: { url: string };
  },
}));

vi.mock('farcaster-client-hooks', () => ({
  useGloballyCachedUser: () => state.user,
}));

vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => ({ fid: state.currentFid }),
}));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => false,
}));

vi.mock('~/hooks/data/useUserLevel', () => ({
  useUserLevel: () => undefined,
}));

vi.mock('~/components/avatar/Avatar', () => ({
  Avatar: () => <div data-testid="normal-avatar" />,
}));

vi.mock('~/components/fiddy/Fiddy3DAvatar', () => ({
  Fiddy3DAvatar: ({ fid }: { fid: number }) => (
    <div data-testid="fiddy-3d-avatar" data-fid={fid} />
  ),
}));

vi.mock('~/components/profiles/AuthedProfileHeader', () => ({
  AuthedProfileHeader: () => null,
}));

vi.mock('~/components/profiles/UnauthedProfileHeader', () => ({
  UnauthedProfileHeader: () => null,
}));

const { ProfileMetadata } =
  await import('~/components/profiles/ProfileMetadata');

const renderProfile = () =>
  render(
    <ProfileMetadata userProfile={{ user: state.user } as ApiUserProfile} />,
  );

beforeEach(() => {
  localStorage.clear();
  state.currentFid = 123;
  state.user = {
    fid: 123,
    displayName: 'Own User',
    pfp: { url: 'https://example.com/pfp.png' },
  };
});

afterEach(cleanup);

describe('ProfileMetadata Fiddy 3D visibility', () => {
  it('shows the 3D avatar and share link on the opted-in own profile', () => {
    setStoredFiddy3DFid(123);
    renderProfile();

    expect(screen.getByTestId('fiddy-3d-avatar')).toHaveProperty(
      'dataset.fid',
      '123',
    );
    expect(screen.queryByTestId('normal-avatar')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open 3D figure' })).toHaveProperty(
      'href',
      'https://fiddy.fun/3d/share/123',
    );
  });

  it('keeps the normal avatar on the own profile when opted out', () => {
    renderProfile();

    expect(screen.getByTestId('normal-avatar')).toBeTruthy();
    expect(screen.queryByTestId('fiddy-3d-avatar')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open 3D figure' })).toBeNull();
  });

  it('never applies the opt-in to another user profile', () => {
    setStoredFiddy3DFid(123);
    state.user = {
      fid: 456,
      displayName: 'Other User',
      pfp: { url: 'https://example.com/other.png' },
    };
    renderProfile();

    expect(screen.getByTestId('normal-avatar')).toBeTruthy();
    expect(screen.queryByTestId('fiddy-3d-avatar')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open 3D figure' })).toBeNull();
  });

  it('does not treat a signed-out viewer as the profile owner', () => {
    setStoredFiddy3DFid(123);
    state.currentFid = 0;
    renderProfile();

    expect(screen.getByTestId('normal-avatar')).toBeTruthy();
    expect(screen.queryByTestId('fiddy-3d-avatar')).toBeNull();
  });
});
