// @vitest-environment jsdom
/**
 * Tests for Fiddy 3D profile embedding utilities.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  clearStoredFiddy3DFid,
  FIDDY_3D_ASSET_BASE,
  FIDDY_3D_CREATE_URL,
  fiddy3DAssetUrl,
  fiddy3DMotionAllowed,
  getStoredFiddy3DFid,
  setStoredFiddy3DFid,
} from '~/components/fiddy/fiddy3DProfile';

describe('fiddy3DAssetUrl', () => {
  it('builds correct URLs for turntable.gif', () => {
    expect(fiddy3DAssetUrl(123, 'turntable.gif')).toBe(
      `${FIDDY_3D_ASSET_BASE}/123/turntable.gif`,
    );
  });

  it('builds correct URLs for model.glb', () => {
    expect(fiddy3DAssetUrl(456, 'model.glb')).toBe(
      `${FIDDY_3D_ASSET_BASE}/456/model.glb`,
    );
  });

  it('builds correct URLs for thumbnail.png', () => {
    expect(fiddy3DAssetUrl(789, 'thumbnail.png')).toBe(
      `${FIDDY_3D_ASSET_BASE}/789/thumbnail.png`,
    );
  });
});

describe('motion preference', () => {
  const setReducedMotion = (matches: boolean) => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  it('returns true when reduced motion is NOT requested', () => {
    setReducedMotion(false);
    expect(fiddy3DMotionAllowed()).toBe(true);
  });

  it('returns false when reduced motion IS requested', () => {
    setReducedMotion(true);
    expect(fiddy3DMotionAllowed()).toBe(false);
  });

  it('returns true when matchMedia is unavailable', () => {
    const originalMatchMedia = window.matchMedia;
    // @ts-expect-error - deliberately making unavailable
    delete window.matchMedia;
    expect(fiddy3DMotionAllowed()).toBe(true);
    window.matchMedia = originalMatchMedia;
  });
});

describe('localStorage integration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
  });

  it('stores and retrieves FID correctly', () => {
    setStoredFiddy3DFid(12345);
    expect(getStoredFiddy3DFid()).toBe(12345);
  });

  it('returns null when nothing stored', () => {
    expect(getStoredFiddy3DFid()).toBe(null);
  });

  it('returns null for invalid stored values', () => {
    for (const value of ['not-a-number', '123abc', '0', '-1', '1.5']) {
      localStorage.setItem('fiddy3d_fid', value);
      expect(getStoredFiddy3DFid()).toBe(null);
    }
  });

  it('does not store an invalid FID', () => {
    setStoredFiddy3DFid(0);
    expect(getStoredFiddy3DFid()).toBe(null);
  });

  it('clears stored value', () => {
    setStoredFiddy3DFid(999);
    clearStoredFiddy3DFid();
    expect(getStoredFiddy3DFid()).toBe(null);
  });
});

describe('constants', () => {
  it('FIDDY_3D_CREATE_URL points to the creation page', () => {
    expect(FIDDY_3D_CREATE_URL).toBe('https://fiddy.fun/3d/');
  });

  it('FIDDY_3D_ASSET_BASE is correct', () => {
    expect(FIDDY_3D_ASSET_BASE).toBe('https://fiddy.fun/3d/api/assets');
  });
});
