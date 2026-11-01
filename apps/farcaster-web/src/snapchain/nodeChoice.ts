/**
 * Which server Fiddy reads and writes through, as the reader chose it.
 *
 * Two layers, on purpose:
 *
 *   storage  (`nodePreferences`) — per FID, survives reloads, validated on read
 *   active   (here)             — the choice this tab is using right now
 *
 * The active layer is a module store rather than React state because the
 * resolution has to be readable *synchronously* and from anywhere: the reads
 * adapter, the writes client and the status pill all ask "where do my answers
 * come from?" during a render, and none of them may suspend or guess. It is
 * kept in step with storage by `loadActiveNodeChoice` (on mount, and whenever
 * the FID changes) and by `chooseNode` / `resetNodeChoice` (on save).
 *
 * Two honest details live here too:
 *
 *   - the public list is MEASURED, not remembered. Every entry answered
 *     `GET /v1/info` when it was added; anything that did not is not listed.
 *   - an address the browser itself will refuse (a plain-http address from an
 *     https page) is refused up front, in plain words, instead of being saved
 *     and quietly failing later.
 */

import type { FiddyNetwork } from './networks';
import { isNodeExplicitlyConfigured, resolveNodeBaseUrl } from './nodeEnv';
import {
  clearNodeChoice,
  loadNodeChoice,
  type NodeChoice,
  type NodeChoiceKind,
  saveNodeChoice,
} from './nodePreferences';

export type { NodeChoice, NodeChoiceKind };

/**
 * Public read nodes anyone may read from, verified live.
 *
 * Adding one is a measurement, not a preference: `curl -s -m 10 <url>/v1/info`
 * has to come back 200 with a shard/version body. Measured 2026-10-20, only
 * the first answered; the rest of the well-known candidates did not and are
 * therefore absent — `snapchain-api.neynar.com` and `hub-api.neynar.com` answer
 * 402 without payment, `hub.farcaster.standardcrypto.vc` and Ardea's node
 * (`209.97.147.208:3381`, plain http) did not answer, and
 * `snapchain.farcaster.xyz` is documentation, not a node. A list is only worth
 * showing if everything on it works, so it stays short until more are checked.
 */
export const PUBLIC_READ_NODES: readonly {
  url: string;
  name: string;
  note: string;
  /**
   * Which network this address speaks — measured when the node was added, and
   * the only way this client can name a network without being told: a node's
   * `/v1/info` carries no network name (see `~/snapchain/networks`).
   */
  network: FiddyNetwork;
}[] = [
  {
    url: 'https://haatz.quilibrium.com',
    name: 'The public Hypersnap node',
    note: 'Open to everyone, no account, answers in about a second from here.',
    // Hypersnap's own documentation names this host as their public node, and
    // the reader-facing picker says which network it is rather than leaving the
    // address to look like a Farcaster one.
    network: 'hypersnap',
  },
];

/** Trailing slashes are noise; the client appends its own paths. */
const normalizeNodeUrl = (url: string): string =>
  url.trim().replace(/\/+$/, '');

export const nodeChoiceBaseUrl = (choice: NodeChoice | null): string | null =>
  choice ? normalizeNodeUrl(choice.url) : null;

// ── the active choice ──────────────────────────────────────────────────────

let activeChoice: NodeChoice | null = null;
const listeners = new Set<() => void>();

export const getActiveNodeChoice = (): NodeChoice | null => activeChoice;

export const subscribeToNodeChoice = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setActive = (choice: NodeChoice | null): void => {
  const same =
    activeChoice === choice ||
    (activeChoice !== null &&
      choice !== null &&
      activeChoice.kind === choice.kind &&
      activeChoice.url === choice.url);
  if (same) {
    return;
  }
  activeChoice = choice;
  listeners.forEach((listener) => listener());
};

/** Read the choice stored for a FID and make it the one in use. */
export const loadActiveNodeChoice = async (
  fid: number,
): Promise<NodeChoice | null> => {
  const stored = await loadNodeChoice(fid);
  setActive(stored);
  return stored;
};

export const chooseNode = async (
  fid: number,
  choice: NodeChoice,
): Promise<NodeChoice> => {
  const normalized: NodeChoice = {
    kind: choice.kind,
    url: normalizeNodeUrl(choice.url),
  };
  await saveNodeChoice(fid, normalized);
  setActive(normalized);
  return normalized;
};

/** Forget the choice: back to what this build was configured with. */
export const resetNodeChoice = async (fid: number): Promise<void> => {
  await clearNodeChoice(fid);
  setActive(null);
};

// ── what the client actually reads from ────────────────────────────────────

/**
 * The address every node-backed read and write goes to.
 *
 * A chosen server wins over the build's own configuration — that is the whole
 * point of choosing; with nothing chosen this is exactly the previous
 * behaviour, so a build nobody has configured keeps working as it did.
 */
export const resolveEffectiveNodeBaseUrl = (
  env?: Record<string, unknown>,
  pageOrigin?: string,
): string => {
  const chosen = nodeChoiceBaseUrl(activeChoice);
  return chosen ?? resolveNodeBaseUrl(env, pageOrigin);
};

/**
 * The address for one choice, taken as an argument.
 *
 * The same rule as above — a chosen server wins over the build's own
 * configuration — with the choice passed in instead of read out of the module
 * store. That is what lets a React memo depend on exactly the value it
 * resolves from: `useNodeClient` re-resolves when the reader switches server,
 * and a dependency it never read would be one the hooks rule is right to
 * question.
 */
export const resolveBaseUrlForChoice = (choice: NodeChoice | null): string =>
  nodeChoiceBaseUrl(choice) ?? resolveEffectiveNodeBaseUrl();

/** Has this reader named a server at all (either kind)? */
export const isNodeChosen = (): boolean => activeChoice !== null;

/**
 * Is there anywhere to read from: the build's own configuration, or the
 * reader's choice? The device-only session turns on this question.
 */
export const isNodeConfigured = (env?: Record<string, unknown>): boolean =>
  isNodeExplicitlyConfigured(env) || isNodeChosen();

// ── may this address be used, and if not, why ──────────────────────────────

const HTTP_FROM_HTTPS =
  'This page is served over https, and browsers refuse to let an https page ' +
  'talk to a plain http address — so Fiddy cannot read from this one. Give ' +
  'your server an https address (a small proxy in front of it is enough), or ' +
  'open Fiddy itself over http.';

const NOT_AN_ADDRESS =
  'That does not look like an address. It should start with https:// — or ' +
  'http:// for a server on this machine.';

/**
 * Why this address cannot be used, in plain words — or null when it can.
 *
 * Deliberately not a validator for tidiness: an http address is refused only
 * when the browser itself would refuse it, which depends on how this page is
 * served. Everything else is the reader's business.
 */
export const nodeAddressProblem = (
  raw: string,
  pageProtocol: string,
): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 'Paste the address of the server you want Fiddy to read from.';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return NOT_AN_ADDRESS;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NOT_AN_ADDRESS;
  }

  if (parsed.protocol === 'http:' && pageProtocol === 'https:') {
    return HTTP_FROM_HTTPS;
  }

  return null;
};
