// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIDDY_3D_CREATE_URL,
  getStoredFiddy3DFid,
  setStoredFiddy3DFid,
} from '~/components/fiddy/fiddy3DProfile';
import { ProfileFiddy3DSettings } from '~/components/fiddy/ProfileFiddy3DSettings';

vi.stubGlobal('fetch', vi.fn());
const mockFetch = vi.mocked(fetch);

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true } as Response);
});

afterEach(cleanup);

describe('ProfileFiddy3DSettings', () => {
  it('opts in only the signed-in FID and can opt back out', async () => {
    render(<ProfileFiddy3DSettings signedInFid={123} isOwnProfile={true} />);

    expect(screen.getByText('Fiddy 3D (beta)')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Get your chibi figure →' }),
    ).toHaveProperty('href', FIDDY_3D_CREATE_URL);

    const toggle = screen.getByRole('switch', {
      name: 'Use Fiddy 3D on your profile',
    });
    expect(toggle).toHaveProperty('checked', false);

    fireEvent.click(toggle);
    expect(getStoredFiddy3DFid()).toBe(123);
    await waitFor(() => {
      expect(screen.getByText('✓ 3D avatar found')).toBeTruthy();
    });

    fireEvent.click(toggle);
    expect(getStoredFiddy3DFid()).toBe(null);
  });

  it('does not adopt a different FID already in local storage', async () => {
    setStoredFiddy3DFid(999);

    render(<ProfileFiddy3DSettings signedInFid={123} isOwnProfile={true} />);

    const toggle = screen.getByRole('switch', {
      name: 'Use Fiddy 3D on your profile',
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty('checked', false);
    });

    fireEvent.click(toggle);
    expect(getStoredFiddy3DFid()).toBe(123);
    await waitFor(() => {
      expect(screen.getByText('✓ 3D avatar found')).toBeTruthy();
    });
  });

  it('renders no settings on another profile', () => {
    const { container } = render(
      <ProfileFiddy3DSettings signedInFid={123} isOwnProfile={false} />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
