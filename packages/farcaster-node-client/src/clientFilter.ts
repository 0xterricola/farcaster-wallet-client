/**
 * "Include or exclude casts from other clients" — a *view-layer* preference,
 * never a protocol claim.
 *
 * Farcaster casts carry no client field. What they do carry is the `signer`
 * public key that signed them, and the protocol records which app FID requested
 * that key (see `clientAttribution.ts`, which decodes it and reads the app's own
 * profile). So every cast resolves to one of five honest answers:
 *
 *   - `self`    — signed by the app key this client requested (Fiddy's own app)
 *   - `known`   — the app FID has a name: either yours, or its own profile
 *   - `own`     — the key was requested by the account itself, so no app is
 *                 involved (a self-hosted setup posting as itself)
 *   - `unknown` — an app FID whose account says nothing about itself
 *   - `onchain` — an on-chain key whose metadata names no requesting app
 *
 * Nothing here filters at the protocol level: the messages are all still on
 * your node and still valid. Hiding is a rendering decision the reader owns.
 */

import {
  type AppClientName,
  type AppClientNameLookup,
  appFidFromSignerRecord,
} from './clientAttribution';
import type { SnapchainNodeClient } from './http';
import type { NodeMessage, NodeSigner } from './types';

export type ClientKind = 'self' | 'known' | 'own' | 'unknown' | 'onchain';

export interface ClientIdentity {
  /** Stable id used by the filter UI (`self`, `app:9152`, `own`). */
  id: string;
  /** Human-readable label: the app's own name, or a plain-words description. */
  label: string;
  kind: ClientKind;
  /** The app FID that requested the key, when the protocol reports one. */
  requestFid?: number;
  /** The signer public key this identity was resolved from. */
  signerHex: string;
  /** `SIGNER_SOURCE_ONCHAIN` / `SIGNER_SOURCE_OFFCHAIN` / `unknown`. */
  source: string;
  /** Message scopes the key may sign (gasless keys only). */
  scopes?: string[];
  /** The app account's own handle, when it has one. */
  username?: string;
  /** The app account's own picture, when it has one. */
  pfpUrl?: string;
}

/**
 * requestFid -> display name. Deliberately *not* pre-populated: a name a reader
 * types is theirs and wins over everything else.
 *
 * Accepts a live getter as well as a record: a name a reader types must take
 * effect on the very next cast rendered, and the resolver caches what the
 * *protocol* said rather than the label built from it for exactly that reason.
 */
export type KnownClients = Record<number, string>;

export type KnownClientsSource = KnownClients | (() => KnownClients);

export const readKnownClients = (
  source: KnownClientsSource | undefined,
): KnownClients | undefined => {
  if (typeof source === 'function') {
    try {
      return source();
    } catch {
      return undefined;
    }
  }
  return source;
};

export interface ResolveIdentityOptions {
  signerHex: string;
  /** The signer record from the node, when it could be fetched. */
  signer?: NodeSigner;
  /** The app FID of the client doing the reading: a key it requested is `self`. */
  thisAppFid?: number;
  /** The FID whose cast this is: a key it requested itself is `own`. */
  authorFid?: number;
  knownClients?: KnownClients;
  /** The app FID's own profile, when the caller read it. */
  name?: AppClientName;
  /** How this client's own app key reads. Defaults to `Fiddy`. */
  selfLabel?: string;
}

export const SELF_CLIENT_ID = 'self';
export const OWN_KEY_CLIENT_ID = 'own';
export const DEFAULT_SELF_LABEL = 'Fiddy';

/**
 * The best name for an app FID, in the order of who is most entitled to the
 * claim: the reader's own label, then the app account's own profile, then
 * nothing at all (rendered as the FID, never as a vendor this repo invented).
 */
export const appClientLabel = (
  requestFid: number,
  { knownClients, name }: Pick<ResolveIdentityOptions, 'knownClients' | 'name'>,
): { label: string; kind: ClientKind; username?: string; pfpUrl?: string } => {
  const readers = knownClients?.[requestFid];
  if (readers && readers.trim().length > 0) {
    return { label: readers.trim(), kind: 'known' };
  }
  const username = name?.username?.trim();
  const displayName = name?.displayName?.trim();
  if (displayName || username) {
    return {
      // The app's display name is what it calls itself (`Warpcast`); the handle
      // is the fallback when it has not set one.
      label: displayName || username || `app ${requestFid}`,
      kind: 'known',
      ...(username ? { username } : {}),
      ...(name?.pfpUrl ? { pfpUrl: name.pfpUrl } : {}),
    };
  }
  return { label: `app ${requestFid}`, kind: 'unknown' };
};

/** Pure: turn a signer record into a client identity. */
export const clientIdentityFor = ({
  signerHex,
  signer,
  thisAppFid,
  authorFid,
  knownClients,
  name,
  selfLabel,
}: ResolveIdentityOptions): ClientIdentity | undefined => {
  const normalizedSigner = signerHex.toLowerCase();

  if (!signer) {
    // No signer record at all: the node was asked and could not say. A cast
    // whose client is not established carries no label (see `reads.ts`), which
    // is why this returns nothing rather than an "unknown client" badge.
    return undefined;
  }

  const source = signer.source;
  const requestFid = appFidFromSignerRecord(signer);

  if (requestFid === undefined) {
    // An on-chain key whose metadata names no requesting app: the protocol is
    // explicit that no app asked for it, and that is worth saying.
    return {
      id: `signer:${normalizedSigner}`,
      label: 'an on-chain key',
      kind: 'onchain',
      signerHex: normalizedSigner,
      source,
      ...(signer.scopes ? { scopes: signer.scopes } : {}),
    };
  }

  if (typeof thisAppFid === 'number' && requestFid === thisAppFid) {
    return {
      id: SELF_CLIENT_ID,
      label: selfLabel ?? DEFAULT_SELF_LABEL,
      kind: 'self',
      requestFid,
      signerHex: normalizedSigner,
      source,
      ...(signer.scopes ? { scopes: signer.scopes } : {}),
    };
  }

  if (typeof authorFid === 'number' && requestFid === authorFid) {
    // The account asked for the key itself: nobody else's app is involved.
    //
    // Decided from the protocol BEFORE the app's own profile is consulted, and
    // the difference is not cosmetic: for a self-requested key the "app" account
    // IS the author, so naming it from its profile puts the AUTHOR'S OWN NAME on
    // their cast as if it were the client that posted it. MEASURED on live
    // 2026-10-24: fid 7237's cast read "via Thomas" — Thomas being that
    // account's own display name, printed under a cast written by Thomas. The
    // readable answer is that no app is involved here, which is what `own` says.
    return {
      id: OWN_KEY_CLIENT_ID,
      label: 'their own key',
      kind: 'own',
      requestFid,
      signerHex: normalizedSigner,
      source,
      ...(signer.scopes ? { scopes: signer.scopes } : {}),
    };
  }

  const named = appClientLabel(requestFid, { knownClients, name });

  return {
    id: `app:${requestFid}`,
    label: named.label,
    kind: named.kind,
    requestFid,
    signerHex: normalizedSigner,
    source,
    ...(named.username ? { username: named.username } : {}),
    ...(named.pfpUrl ? { pfpUrl: named.pfpUrl } : {}),
    ...(signer.scopes ? { scopes: signer.scopes } : {}),
  };
};

export interface CastClientResolverOptions {
  node: SnapchainNodeClient;
  /** The app FID of this client (Fiddy's own app key). */
  thisAppFid?: number;
  knownClients?: KnownClientsSource;
  /**
   * What an app FID calls itself. Defaults to nothing (unlabelled app FIDs stay
   * `app <fid>`); pass `createAppClientNameLookup({ node })` to read each app
   * account's own profile off the node.
   */
  names?: AppClientNameLookup;
  /** How this client's own app key reads. */
  selfLabel?: string;
}

/** What the protocol said about one signing key: cached, and nothing more. */
interface ResolvedClientFacts {
  signer?: NodeSigner;
  name?: AppClientName;
}

/**
 * Resolves the client behind each cast by looking up its signer on your node,
 * caching per signer key so a feed of 25 casts from 20 keys costs 20 reads (and
 * names cost one read per distinct app).
 *
 * What is cached is the *evidence* — the signer record and the app account's own
 * profile — never the assembled label. A reader who names an app sees that name
 * on the next cast rendered, without a reload and without the cache being
 * cleared.
 */
export class CastClientResolver {
  private readonly cache = new Map<string, ResolvedClientFacts>();
  private readonly node: SnapchainNodeClient;
  private readonly thisAppFid?: number;
  private readonly knownClients?: KnownClientsSource;
  private readonly names?: AppClientNameLookup;
  private readonly selfLabel?: string;

  constructor(options: CastClientResolverOptions) {
    this.node = options.node;
    this.thisAppFid = options.thisAppFid;
    this.knownClients = options.knownClients;
    this.names = options.names;
    this.selfLabel = options.selfLabel;
  }

  clear(): void {
    this.cache.clear();
  }

  async resolve(
    cast: Pick<NodeMessage, 'fid' | 'signer'>,
  ): Promise<ClientIdentity | undefined> {
    const key = cast.signer.toLowerCase();
    const cacheKey = `${cast.fid}:${key}`;
    let facts = this.cache.get(cacheKey);
    if (!facts) {
      let signer: NodeSigner | undefined;
      try {
        signer = await this.node.signer({ fid: cast.fid, signer: key });
      } catch {
        signer = undefined;
      }
      const requestFid = appFidFromSignerRecord(signer);
      let name: AppClientName | undefined;
      if (
        requestFid !== undefined &&
        requestFid !== this.thisAppFid &&
        this.names
      ) {
        name = await this.names(requestFid);
      }
      facts = {
        ...(signer ? { signer } : {}),
        ...(name ? { name } : {}),
      };
      this.cache.set(cacheKey, facts);
    }

    return clientIdentityFor({
      signerHex: key,
      ...(facts.signer ? { signer: facts.signer } : {}),
      ...(this.thisAppFid === undefined ? {} : { thisAppFid: this.thisAppFid }),
      authorFid: cast.fid,
      ...(this.knownClients
        ? { knownClients: readKnownClients(this.knownClients) }
        : {}),
      ...(facts.name ? { name: facts.name } : {}),
      ...(this.selfLabel ? { selfLabel: this.selfLabel } : {}),
    });
  }

  /**
   * Resolve clients for a page of casts, de-duplicating signer lookups. Casts
   * whose signer cannot be resolved come back absent rather than failing the
   * whole feed, and a cast with no client identity is drawn without a label.
   */
  async resolveAll(
    casts: Pick<NodeMessage, 'fid' | 'signer'>[],
  ): Promise<Map<string, ClientIdentity>> {
    const unique = new Map<string, Pick<NodeMessage, 'fid' | 'signer'>>();
    for (const cast of casts) {
      const key = cast.signer.toLowerCase();
      if (!unique.has(key)) {
        unique.set(key, cast);
      }
    }
    const entries = await Promise.all(
      [...unique.values()].map(
        async (cast) =>
          [cast.signer.toLowerCase(), await this.resolve(cast)] as const,
      ),
    );
    return new Map(
      entries.filter(
        (entry): entry is [string, ClientIdentity] => entry[1] !== undefined,
      ),
    );
  }
}

export type ClientFilterMode = 'all' | 'only' | 'exclude';

export interface ClientFilterPolicy {
  /** `all` shows everything; `only` keeps listed clients; `exclude` hides them. */
  mode: ClientFilterMode;
  /** Client ids from {@link ClientIdentity.id} (`self`, `app:9152`, ...). */
  clientIds: string[];
}

export const defaultClientFilterPolicy: ClientFilterPolicy = {
  mode: 'all',
  clientIds: [],
};

export interface FilterByClientOptions {
  messages: NodeMessage[];
  /** Resolved identities keyed by lowercased signer hex. */
  clients: Map<string, ClientIdentity>;
  policy: ClientFilterPolicy;
  /** What to do when a cast's client is unknown: keep it (default) or hide it. */
  unknownClientBehavior?: 'keep' | 'hide';
}

/**
 * Pure view-layer filter.
 *
 * Two behaviours worth stating because they are asymmetric on purpose:
 *
 *   - `only` means *only*: a cast whose client could not be resolved is not one
 *     of the listed clients, so it is hidden. Narrowing to one client is an
 *     explicit request and honouring it half-way would be a bug.
 *   - `exclude` names clients to drop, so an unresolved client is kept (unless
 *     the caller passes `hide`) — hiding a stranger's cast because a lookup
 *     failed is worse than showing one you meant to filter.
 */
export const filterCastsByClient = ({
  messages,
  clients,
  policy,
  unknownClientBehavior = 'keep',
}: FilterByClientOptions): NodeMessage[] => {
  if (policy.mode === 'all' || policy.clientIds.length === 0) {
    return messages;
  }
  const listed = new Set(policy.clientIds);
  const keepListed = policy.mode === 'only';

  return messages.filter((message) => {
    const identity = clients.get(message.signer.toLowerCase());
    if (keepListed) {
      return identity ? listed.has(identity.id) : false;
    }
    if (!identity) {
      return unknownClientBehavior === 'keep';
    }
    return !listed.has(identity.id);
  });
};
