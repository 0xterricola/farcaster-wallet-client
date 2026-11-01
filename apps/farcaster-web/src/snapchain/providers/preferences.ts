/**
 * The reader's provider order, remembered across reloads.
 *
 * Stored per FID, like the other view-layer preferences in this client, because
 * "which servers do I want to read from" is a choice about this account's
 * client, not a fact about the protocol. The node the reader picked in the node
 * picker is *not* duplicated here — it already has its own storage
 * (`~/snapchain/nodeChoice`) and it always takes the first place; this file
 * holds only what comes after it.
 *
 * A stored order is user-editable and survives upgrades, so it is validated on
 * the way in: ids that name nothing this build knows are dropped rather than
 * guessed at.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

import {
  FARCASTER_PUBLIC_PROVIDER_ID,
  NEYNAR_PROVIDER_ID,
  snapchainUrlFromId,
} from './providerTypes';

const PROVIDER_ORDER_NAMESPACE = 'snapchain_provider_order';

const orderKey = (fid: number): string => `${PROVIDER_ORDER_NAMESPACE}_${fid}`;

/** Is this a provider id this client can still resolve to a server? */
export const isKnownProviderId = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  if (value === NEYNAR_PROVIDER_ID || value === FARCASTER_PUBLIC_PROVIDER_ID) {
    return true;
  }
  const url = snapchainUrlFromId(value);
  if (url === null) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export const loadProviderOrder = async (fid: number): Promise<string[]> => {
  const stored = await getItem<unknown>({
    key: orderKey(fid),
    fallback: null,
  });
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter(isKnownProviderId);
};

export const saveProviderOrder = async (
  fid: number,
  ids: string[],
): Promise<void> => {
  await setItem({ key: orderKey(fid), value: ids.filter(isKnownProviderId) });
};

export const clearProviderOrder = (fid: number): Promise<void> =>
  deleteItem(orderKey(fid));

/** Where a Neynar key would come from, if this build has one. */
export const NEYNAR_API_KEY_ENV = 'VITE_NEYNAR_API_KEY';

/**
 * The Neynar key this build was given, or null.
 *
 * Read from the build's own configuration (`.env.local`, written by
 * `scripts/fiddy-setup.command`) rather than from storage: it is a credential,
 * not a preference, and the wizard is the only thing that should ever write it.
 */
export const neynarApiKeyFromEnv = (
  env: Record<string, unknown> = import.meta.env,
): string | null => {
  const raw = env[NEYNAR_API_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
};

/** Does this build have a Neynar key at all? */
export const isNeynarConfigured = (
  env: Record<string, unknown> = import.meta.env,
): boolean => neynarApiKeyFromEnv(env) !== null;
