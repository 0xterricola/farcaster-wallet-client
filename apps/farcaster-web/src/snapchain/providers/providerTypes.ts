/**
 * What a "server we can read from" is, in this client's vocabulary.
 *
 * The reader may point Fiddy at any of four kinds of place, and the client is
 * not allowed to pretend they are the same thing:
 *
 *   snapchain          a Snapchain read node — the one they run, or a public one
 *                      somebody keeps open. Speaks the protocol's own HTTP API
 *                      (`/v1/info`, `/v1/castsByFid`, …), which is where all the
 *                      signed-in reads are assembled from.
 *   neynar             Neynar's hosted index. Different endpoint names, different
 *                      JSON shapes, needs the reader's own API key, and its
 *                      free tier has limits. Reached through a thin mapper so
 *                      none of that leaks into the pages.
 *   farcaster-public   `api.farcaster.xyz` — Farcaster's own public client API.
 *                      No account needed for the public reads it documents, but
 *                      it is READ-ONLY here and it cannot tell us how far behind
 *                      the network it is. MEASURED (2026-10-21): a page on
 *                      another origin cannot read it at all — it sends no
 *                      cross-origin permission for any `/v1/**` or `/v2/**`
 *                      path — so in this web client it is a thing the reader can
 *                      see and name, never one that answers. See
 *                      `publicServerOffTheWeb`.
 *
 * Two invariants, both load-bearing:
 *
 *   - A provider id is stable across reloads, because the reader's order is
 *     stored by id (`snapchain:<url>`, `neynar`, `farcaster-public`). Renaming
 *     one silently forgets a preference.
 *   - Provider specifics stop at this folder. Pages and hooks consume the
 *     hosted-API shapes they always did (see `~/snapchain/nodeApi`); the
 *     per-provider JSON is mapped back to those shapes here and nowhere else.
 */

export type ProviderKind = 'snapchain' | 'neynar' | 'farcaster-public';

/**
 * Where a server's authority to answer you comes from.
 *
 * `own` is the reader's machine (or their VPS). `public` is somebody else's
 * machine, open to read from. `builtin` is a service this client knows how to
 * speak to without the reader installing anything.
 */
export type ProviderSource = 'own' | 'public' | 'builtin';

export interface NodeProvider {
  /** Stable identity, e.g. `snapchain:https://node.example`, `neynar`. */
  id: string;
  kind: ProviderKind;
  source: ProviderSource;
  /** Plain words for the picker: "The node you run". */
  label: string;
  /** One honest sentence about what this provider is for, or its limits. */
  detail: string;
  /** Absolute base URL. Empty only for a provider that has none yet. */
  baseUrl: string;
  /** True when reads are fine but writes can never go here. */
  readOnly: boolean;
}

/** `snapchain:https://node.example` — the id every stored order is made of. */
export const snapchainProviderId = (baseUrl: string): string =>
  `snapchain:${normalizeBaseUrl(baseUrl)}`;

export const NEYNAR_PROVIDER_ID = 'neynar';
export const FARCASTER_PUBLIC_PROVIDER_ID = 'farcaster-public';

/** Trailing slashes are noise; the readers append their own paths. */
export const normalizeBaseUrl = (url: string): string =>
  url.trim().replace(/\/+$/, '');

export const isSameProviderUrl = (a: string, b: string): boolean =>
  normalizeBaseUrl(a) === normalizeBaseUrl(b);

/** An address the browser is allowed to fetch at all. */
export const isUsableProviderUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Which provider kind a stored id names — used when a stored order is read
 * back and some entry no longer describes anything this build can reach.
 */
export const providerKindFromId = (id: string): ProviderKind | null => {
  if (id === NEYNAR_PROVIDER_ID) {
    return 'neynar';
  }
  if (id === FARCASTER_PUBLIC_PROVIDER_ID) {
    return 'farcaster-public';
  }
  if (id.startsWith('snapchain:')) {
    return 'snapchain';
  }
  return null;
};

/** The URL inside a `snapchain:` id, or null when the id is not one. */
export const snapchainUrlFromId = (id: string): string | null => {
  const prefix = 'snapchain:';
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
};
