/**
 * App key storage: persists ONLY the app key's private key hex per FID.
 *
 * Security invariants:
 * - Never stores seed phrases or custody keys
 * - Only stores the Ed25519 private key hex that the app uses to sign messages
 * - Uses localforage with namespaced keys to avoid collisions
 *
 * WHERE THE PHRASE LIVES INSTEAD: `~/snapchain/accounts/localAccounts` keeps the
 * recovery phrase of an account this device created, in the same localforage
 * store, and that is a deliberate trade — the phrase never leaves the browser,
 * but it sits at rest unencrypted alongside the keys here. This module's
 * invariant is about what THIS module writes, and it still holds.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

/** Namespace prefix for all app key storage. */
const APP_KEY_NAMESPACE = 'snapchain_app_key';

/** Nonce storage namespace for tracking app key nonces. */
const APP_NONCE_NAMESPACE = 'snapchain_app_nonce';

/**
 * Generate a storage key for a FID's app key.
 */
const appKeyStorageKey = (fid: number): string => `${APP_KEY_NAMESPACE}_${fid}`;

/**
 * Generate a storage key for a FID's app nonce.
 */
const appNonceStorageKey = (fid: number): string =>
  `${APP_NONCE_NAMESPACE}_${fid}`;

/**
 * Load the stored app key private key hex for a given FID.
 * Returns null if no key is stored.
 */
export const loadAppKey = async (fid: number): Promise<string | null> => {
  const key = await getItem<string | null>({
    key: appKeyStorageKey(fid),
    fallback: null,
  });
  return key;
};

/**
 * Save an app key's private key hex for a given FID.
 * Replaces any existing key.
 */
export const saveAppKey = async (
  fid: number,
  privateKeyHex: string,
): Promise<void> => {
  await setItem({
    key: appKeyStorageKey(fid),
    value: privateKeyHex,
  });
};

/**
 * Clear the stored app key for a given FID.
 */
export const clearAppKey = async (fid: number): Promise<void> => {
  await deleteItem(appKeyStorageKey(fid));
  // Also clear the nonce
  await deleteItem(appNonceStorageKey(fid));
};

/**
 * Load the stored app nonce for a given FID.
 * Returns 1 as the default if not set.
 */
export const loadAppNonce = async (fid: number): Promise<number> => {
  const nonce = await getItem<number | null>({
    key: appNonceStorageKey(fid),
    fallback: null,
  });
  return nonce ?? 1;
};

/**
 * Save the app nonce for a given FID.
 */
export const saveAppNonce = async (
  fid: number,
  nonce: number,
): Promise<void> => {
  await setItem({
    key: appNonceStorageKey(fid),
    value: nonce,
  });
};
