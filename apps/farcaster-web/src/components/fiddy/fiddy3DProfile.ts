/**
 * Utilities for embedding Fiddy 3D profile assets (GIF/GLB) in user profiles.
 *
 * Fiddy 3D generates turntable GIFs and GLB models for user FIDs at:
 *   - /3d/api/assets/<fid>/turntable.gif
 *   - /3d/api/assets/<fid>/model.glb
 *   - /3d/api/assets/<fid>/thumbnail.png
 *
 * The user can link their FID to enable this feature. Storage is local-only:
 * we do not mutate any server-side profile data.
 */

/** Base URL for Fiddy 3D assets. */
export const FIDDY_3D_ASSET_BASE = 'https://fiddy.fun/3d/api/assets';

/** The production link users can visit to generate their 3D figure. */
export const FIDDY_3D_CREATE_URL = 'https://fiddy.fun/3d/';

/**
 * Build the URL for a specific asset type for a given FID.
 */
export const fiddy3DAssetUrl = (
  fid: number,
  asset: 'turntable.gif' | 'model.glb' | 'thumbnail.png',
): string => `${FIDDY_3D_ASSET_BASE}/${fid}/${asset}`;

/**
 * Local storage key for storing the Fiddy 3D FID for the signed-in user.
 * Only used when the user explicitly opts in.
 */
export const FIDDY_3D_STORAGE_KEY = 'fiddy3d_fid';

/**
 * Get the stored Fiddy 3D FID for the current user (if any).
 */
export const getStoredFiddy3DFid = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = localStorage.getItem(FIDDY_3D_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = Number(stored);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Store the Fiddy 3D FID for the current user.
 */
export const setStoredFiddy3DFid = (fid: number): void => {
  if (typeof window === 'undefined' || !Number.isSafeInteger(fid) || fid <= 0) {
    return;
  }
  try {
    localStorage.setItem(FIDDY_3D_STORAGE_KEY, String(fid));
  } catch {
    // Storage unavailable or quota exceeded — ignore.
  }
};

/**
 * Clear the stored Fiddy 3D FID.
 */
export const clearStoredFiddy3DFid = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(FIDDY_3D_STORAGE_KEY);
  } catch {
    // Ignore failures.
  }
};

/**
 * Is reduced motion requested?
 *
 * Read before any assets are fetched, so a user who asked for stillness
 * never downloads the GIF. `null` (unsupported browser) counts as allowed.
 */
export const fiddy3DMotionAllowed = (): boolean => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return true;
  }
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  return !query.matches;
};
