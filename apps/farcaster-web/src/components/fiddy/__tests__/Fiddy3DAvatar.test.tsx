// @vitest-environment jsdom
/**
 * Tests for Fiddy3DAvatar component.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Fiddy3DAvatar } from '~/components/fiddy/Fiddy3DAvatar';
import { fiddy3DAssetUrl } from '~/components/fiddy/fiddy3DProfile';

vi.stubGlobal('fetch', vi.fn());

const mockFetch = vi.mocked(fetch);

const setReducedMotion = (matches: boolean) => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
  setReducedMotion(false);
  // Default: no 3D assets
  mockFetch.mockResolvedValue({
    ok: false,
    headers: new Headers({ 'content-type': 'text/html' }),
  } as unknown as Response);
});

afterEach(cleanup);

describe('Fiddy3DAvatar', () => {
  it('shows fallback PFP when no 3D assets exist', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      headers: new Headers({ 'content-type': 'text/html' }),
    } as unknown as Response);

    const { container } = render(
      <Fiddy3DAvatar
        fid={123}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    // Should show fallback immediately (no 3D)
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBe('https://example.com/pfp.png');
    });
  });

  it('shows 3D GIF thumbnail when assets exist and motion allowed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    } as unknown as Response);

    setReducedMotion(false);

    const { container } = render(
      <Fiddy3DAvatar
        fid={456}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    // Wait for the probe check
    await waitFor(() => {
      // Since 3D exists and motion allowed, should try GIF first
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBe(
        fiddy3DAssetUrl(456, 'turntable.gif'),
      );
    });
  });

  it('shows static thumbnail when reduced motion is requested', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    } as unknown as Response);

    setReducedMotion(true);

    const { container } = render(
      <Fiddy3DAvatar
        fid={789}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    await waitFor(() => {
      // With reduced motion, should show static thumbnail
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBe(
        fiddy3DAssetUrl(789, 'thumbnail.png'),
      );
    });

    // Verify the GIF wasn't fetched
    expect(
      mockFetch.mock.calls.some((call) =>
        String(call[0]).includes('turntable.gif'),
      ),
    ).toBe(false);
  });

  it('falls back to regular PFP on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { container } = render(
      <Fiddy3DAvatar
        fid={111}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBe('https://example.com/pfp.png');
    });
  });

  it('uses correct size from preset', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      headers: new Headers({ 'content-type': 'text/html' }),
    } as unknown as Response);

    const { container } = render(
      <Fiddy3DAvatar
        fid={222}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
        size="md"
      />,
    );

    await waitFor(() => {
      const div = container.querySelector('div');
      expect(div?.style.width).toBe('40px');
      expect(div?.style.height).toBe('40px');
    });
  });

  it('has proper accessible role and label', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    } as unknown as Response);

    const { container } = render(
      <Fiddy3DAvatar
        fid={333}
        displayName="Fiddy Fan"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    await waitFor(() => {
      const div = container.querySelector('div');
      expect(div?.getAttribute('role')).toBe('img');
      expect(div?.getAttribute('aria-label')).toContain('Fiddy Fan');
    });
  });

  it('lazy loads images', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    } as unknown as Response);

    const { container } = render(
      <Fiddy3DAvatar
        fid={444}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('loading')).toBe('lazy');
    });
  });
});

describe('Reduced motion handling', () => {
  it('does not fetch GIF when reduced motion is enabled', async () => {
    const gifUrl = fiddy3DAssetUrl(555, 'turntable.gif');
    const thumbnailUrl = fiddy3DAssetUrl(555, 'thumbnail.png');

    // First call (thumbnail) returns image, second call (GIF) would return image too
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === thumbnailUrl) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
        } as unknown as Response;
      }
      if (url === gifUrl) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/gif' }),
        } as unknown as Response;
      }
      return {
        ok: false,
        headers: new Headers({ 'content-type': 'text/html' }),
      } as unknown as Response;
    });

    setReducedMotion(true);

    render(
      <Fiddy3DAvatar
        fid={555}
        displayName="Test User"
        fallbackPfpUrl="https://example.com/pfp.png"
      />,
    );

    await waitFor(() => {
      // GIF should NOT have been fetched when reduced motion is on
      expect(mockFetch.mock.calls.some((call) => call[0] === gifUrl)).toBe(
        false,
      );
    });
  });
});
