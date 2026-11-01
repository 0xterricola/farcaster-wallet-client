/**
 * Which network Fiddy is reading, and the two it can read.
 *
 * Two networks carry the same kind of social data and do not talk to each
 * other:
 *
 *   Snapchain  — Farcaster's own network. Every account, cast and follow lives
 *                on it. This is the one to pick.
 *   Hypersnap  — an independent parallel network built by the Quilibrium
 *                community. Same kind of social data, different plumbing and
 *                different economics. It is for explorers, and it is not where
 *                a Farcaster account lives.
 *
 * THE HARD PART IS HONESTY, NOT VOCABULARY: a node does not say which network
 * it is. MEASURED (2026-10-24) `GET /v1/info` on the public Hypersnap node
 * answers exactly `dbStats`, `numShards`, `shardInfos`, `version`, `peer_id`,
 * `nextEngineVersionTimestamp` — no network name, and the version string shares
 * lineage with Snapchain, so it cannot tell them apart either. So this module
 * never GUESSES a network from a response, and the UI never shows one it did
 * not learn from one of these two places:
 *
 *   address — a listed public node whose network was measured when it was added
 *             (`PUBLIC_READ_NODES` in `~/snapchain/nodeChoice`);
 *   build   — the deployment recorded it (`VITE_FIDDY_NETWORK`), which is what
 *             `fiddy client up` writes for the node it just pointed the client
 *             at. That is provenance: the thing that installed the node says
 *             what it is, instead of the client inferring it.
 *
 * Everything else reads as "not recorded", with the reason, rather than as a
 * shrug that looks like an answer. And a network is only OFFERED when there is
 * an address for it that the client can actually read: Hypersnap has the
 * public node; Snapchain has nothing public (measured: snapchain-api.neynar.com
 * and hub-api.neynar.com both answer `402 X-PAYMENT header or API key
 * required`), so on a build with no node of its own Snapchain is shown as
 * unavailable with the one command that changes that, not as a button that
 * silently fails.
 */

import { PUBLIC_READ_NODES } from './nodeChoice';
import { configuredNodeUrl } from './nodeEnv';

export type FiddyNetwork = 'snapchain' | 'hypersnap';

/** The network a build reads unless somebody says otherwise. */
export const FIDDY_DEFAULT_NETWORK: FiddyNetwork = 'snapchain';

/** The variable that records which network the configured node speaks. */
export const NETWORK_ENV_KEY = 'VITE_FIDDY_NETWORK';

export interface FiddyNetworkFacts {
  id: FiddyNetwork;
  /** The name to write, exactly as the network writes it. */
  name: string;
  /** Who runs it, in one plain phrase. */
  builtBy: string;
  /** What it is, for a reader who has never heard of either. */
  sentence: string;
  /** And the rest of it — same idea, different plumbing. */
  detail: string;
  /** The one thing that decides the choice for most people. */
  accountLine: string;
}

export const FIDDY_NETWORKS: readonly FiddyNetworkFacts[] = [
  {
    id: 'snapchain',
    name: 'Snapchain',
    builtBy: "Farcaster's own network",
    sentence:
      "Farcaster's own network — the one every account, cast and follow lives on.",
    detail: 'Pick this one. It is where your Farcaster account already is.',
    accountLine: 'Your Farcaster account lives here.',
  },
  {
    id: 'hypersnap',
    name: 'Hypersnap',
    builtBy: "the Quilibrium community's parallel network",
    sentence:
      'An independent parallel network built by the Quilibrium community — same kind of social data, different plumbing and different economics.',
    detail: 'For explorers. It is not where your Farcaster account lives.',
    accountLine: 'Your Farcaster account does not live here.',
  },
];

export const isFiddyNetwork = (value: unknown): value is FiddyNetwork =>
  value === 'snapchain' || value === 'hypersnap';

export const networkFacts = (
  id: FiddyNetwork | null,
): FiddyNetworkFacts | null =>
  id === null
    ? null
    : (FIDDY_NETWORKS.find((entry) => entry.id === id) ?? null);

/** The name to show for a reading, including the honest unknown. */
export const networkName = (id: FiddyNetwork | null): string =>
  id === null ? 'Not recorded' : (networkFacts(id)?.name ?? 'Not recorded');

/** Addresses are compared the way a reader pastes them, not byte for byte. */
const normalizeAddress = (url: string): string =>
  url.trim().replace(/\/+$/, '').toLowerCase();

/**
 * The network of a listed public node — known because it was measured when the
 * entry was added, not because the address string looks like anything.
 */
export const networkOfPublicAddress = (
  url: string | null | undefined,
): FiddyNetwork | null => {
  if (!url) {
    return null;
  }
  const wanted = normalizeAddress(url);
  const entry = PUBLIC_READ_NODES.find(
    (candidate) => normalizeAddress(candidate.url) === wanted,
  );
  return entry ? entry.network : null;
};

/** The listed public address for a network, when there is one. */
export const publicAddressForNetwork = (id: FiddyNetwork): string | null =>
  PUBLIC_READ_NODES.find((entry) => entry.network === id)?.url ?? null;

/** What a deployment recorded about the node it reads through. */
/**
 * The value the DEPLOYMENT baked in, read once through the literal property
 * access Vite inlines at build time.
 *
 * `import.meta.env.VITE_FIDDY_NETWORK` is substituted statically; a dynamic
 * lookup (`import.meta.env[name]`) would find nothing in the shipped bundle,
 * which is the difference between a client that can name its network in
 * production and one that only can on a dev server.
 */
const BUILT_NETWORK: unknown = import.meta.env.VITE_FIDDY_NETWORK;

const declaredFromValue = (value: unknown): FiddyNetwork | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return isFiddyNetwork(trimmed) ? trimmed : null;
};

/** What a deployment recorded about the node it reads through. */
export const declaredNetwork = (
  env?: Record<string, unknown>,
): FiddyNetwork | null =>
  declaredFromValue(env ? env[NETWORK_ENV_KEY] : BUILT_NETWORK);

export type NetworkSource = 'address' | 'build';

export interface NetworkReading {
  /** null when nothing known says which network this server is. */
  network: FiddyNetwork | null;
  /** Where that answer came from — never "it looked like one". */
  source: NetworkSource | null;
  /** The sentence the UI shows next to the reading. */
  why: string;
}

/**
 * Which network the client is reading right now, and why we think so.
 *
 * `choiceUrl` is the address the reader chose (null when they have chosen
 * nothing). Nothing here falls back to "probably Snapchain": a server whose
 * network nobody recorded is reported as exactly that.
 */
export const readNetwork = ({
  choiceUrl,
  choiceKind,
  env,
}: {
  choiceUrl: string | null;
  choiceKind?: 'public' | 'own' | null;
  env?: Record<string, unknown>;
}): NetworkReading => {
  const byAddress = networkOfPublicAddress(choiceUrl);
  if (byAddress) {
    return {
      network: byAddress,
      source: 'address',
      why: `${choiceUrl} is a listed public node, and its network was measured when it was listed.`,
    };
  }

  const declared = declaredNetwork(env);
  if (declared) {
    const where =
      choiceUrl ?? configuredNodeUrl(env) ?? 'the node it reads through';
    return {
      network: declared,
      source: 'build',
      why: `Whoever set this client up recorded ${networkName(
        declared,
      )} for ${where}.`,
    };
  }

  if (!choiceUrl && !configuredNodeUrl(env)) {
    return {
      network: null,
      source: null,
      why: 'No server has been named yet, so there is no network to name.',
    };
  }

  return {
    network: null,
    source: null,
    why: `This server does not say which network it is${
      choiceKind === 'own'
        ? ', and this build did not record one for your own node'
        : ', and this build did not record one'
    }. Fiddy will not guess: pick a network below to say it plainly.`,
  };
};

/** A place reads for a network really go. */
export interface NetworkRoute {
  network: FiddyNetwork;
  /** `own` = the reader runs this server; `public` = someone else keeps it open. */
  kind: 'public' | 'own';
  url: string;
  /** Plain words for the picker row. */
  note: string;
}

/**
 * Where reads would go if the reader picked this network — or null when this
 * client has no address for it that can answer.
 */
export const routeForNetwork = (
  id: FiddyNetwork,
  {
    choiceUrl = null,
    env,
  }: { choiceUrl?: string | null; env?: Record<string, unknown> } = {},
): NetworkRoute | null => {
  const declared = declaredNetwork(env);
  const ownUrl = choiceUrl ?? configuredNodeUrl(env);

  // The reader's own node, when this build says it is the network asked for.
  if (declared === id && ownUrl && !networkOfPublicAddress(ownUrl)) {
    return {
      network: id,
      kind: 'own',
      url: ownUrl,
      note: 'Your own node. Nobody else reads through it, and nobody can turn it off.',
    };
  }

  // Otherwise the listed public node for the network, when there is one.
  const publicUrl = publicAddressForNetwork(id);
  if (publicUrl) {
    return {
      network: id,
      kind: 'public',
      url: publicUrl,
      note: 'A public node anyone can read from. Nothing to install, and nothing of yours runs on it.',
    };
  }

  return null;
};

export interface NetworkOffer {
  facts: FiddyNetworkFacts;
  /** null = Fiddy has nothing to read this network from, and says why. */
  route: NetworkRoute | null;
  /** The reason a reader sees when route is null. */
  why: string;
}

const NOT_OFFERED: Record<FiddyNetwork, string> = {
  snapchain:
    'Nothing public answers for Snapchain: the well-known endpoints (snapchain-api.neynar.com, hub-api.neynar.com) answer "payment or API key required" to anyone without a paid key. Run `fiddy node up --network snapchain` and then `fiddy client up`, and this network appears here with your own node behind it.',
  hypersnap:
    'Fiddy has no address for Hypersnap here. The public node it reads from is listed in the node picker above.',
};

/** Both networks, each with the route this client can actually read it from. */
export const networkOffers = (
  opts: {
    choiceUrl?: string | null;
    env?: Record<string, unknown>;
  } = {},
): NetworkOffer[] =>
  FIDDY_NETWORKS.map((facts) => ({
    facts,
    route: routeForNetwork(facts.id, opts),
    why: NOT_OFFERED[facts.id],
  }));

/** The current reading, phrased for a one-line status. */
export const networkReadingLine = (reading: NetworkReading): string =>
  reading.network === null
    ? 'Network: not recorded'
    : `Network: ${networkName(reading.network)}`;
