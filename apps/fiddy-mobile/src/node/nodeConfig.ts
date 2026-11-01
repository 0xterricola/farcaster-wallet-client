/**
 * Where the app reads from.
 *
 * Fiddy's whole point is reading the network through *your own* node, so the
 * build must never quietly swap in someone else's indexer. This module resolves
 * one URL and labels where it came from, and the status pill repeats that label
 * to the user — "served by your node" is only ever shown when the app is
 * actually pointed at a node it can reach.
 */

import Constants from 'expo-constants';

/** Source of the URL the app is currently reading through. */
export type NodeSource = 'env' | 'app-config' | 'default' | 'session';

export interface ResolvedNode {
  url: string;
  source: NodeSource;
}

/**
 * The Fiddy client node that ships with this build.
 *
 * Override per-build with `EXPO_PUBLIC_FIDDY_NODE_URL=…` (see `.env.example`),
 * or per-session by tapping the node pill. Never a secret: a node URL is a
 * hostname, and this repo's web client has published the same one since v1.
 */
export const DEFAULT_NODE_URL = 'http://34.101.47.167:3381';

/**
 * The FID the Feed tab starts on.
 *
 * A read node has no home feed, so v1 has to be told whose follow graph to
 * assemble. Rather than open on an empty screen, the app starts on a starter
 * FID with a well-populated graph (3) and says so in the UI — the FID is one tap
 * away from being yours, and v2 takes it from the key you hatch with.
 */
export const DEFAULT_FID = 3;

const trimUrl = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';

const envNodeUrl = trimUrl(process.env.EXPO_PUBLIC_FIDDY_NODE_URL);

const configNodeUrl = trimUrl(
  (Constants.expoConfig?.extra as { fiddy?: { nodeUrl?: string } } | undefined)?.fiddy
    ?.nodeUrl,
);

const envFid = Number.parseInt(
  String(process.env.EXPO_PUBLIC_FIDDY_FID ?? ''),
  10,
);

const configFid = Number(
  (Constants.expoConfig?.extra as { fiddy?: { fid?: number } } | undefined)?.fiddy
    ?.fid ?? 0,
);

/** Resolve the build-time node, in precedence order: env → app config → default. */
export const resolveBuildNode = (): ResolvedNode => {
  if (envNodeUrl) {
    return { url: envNodeUrl, source: 'env' };
  }
  if (configNodeUrl) {
    return { url: configNodeUrl, source: 'app-config' };
  }
  return { url: DEFAULT_NODE_URL, source: 'default' };
};

/** Resolve the FID this build starts on. */
export const resolveBuildFid = (): number => {
  if (Number.isFinite(envFid) && envFid > 0) {
    return envFid;
  }
  if (Number.isFinite(configFid) && configFid > 0) {
    return configFid;
  }
  return DEFAULT_FID;
};

/** Human label for where a URL came from — shown in the node sheet. */
export const describeSource = (source: NodeSource): string => {
  switch (source) {
    case 'env':
      return 'build · EXPO_PUBLIC_FIDDY_NODE_URL';
    case 'app-config':
      return 'build · app.json extra.fiddy.nodeUrl';
    case 'session':
      return 'this session only (not saved)';
    case 'default':
    default:
      return 'build default (this repo’s Fiddy node)';
  }
};

/** `http://34.101.47.167:3381` → `34.101.47.167:3381` */
export const hostOf = (url: string): string =>
  url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || url;

/** Normalise a user-typed node URL, or return null when it cannot be one. */
export const parseNodeUrl = (input: string): string | null => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};