/**
 * Normalized shapes for what a Snapchain read node serves over its HTTP API.
 *
 * These are deliberately *not* the node's raw JSON: the node speaks proto
 * enum names (`MESSAGE_TYPE_CAST_ADD`), 0x-hex byte fields, base64 signatures
 * and camelCase body wrappers. Everything below is what the Fiddy client
 * actually consumes — see `wire.ts` for the translation.
 */

export type NodeNetworkName =
  | 'FARCASTER_NETWORK_MAINNET'
  | 'FARCASTER_NETWORK_TESTNET'
  | 'FARCASTER_NETWORK_DEVNET'
  | 'FARCASTER_NETWORK_NONE'
  | (string & {});

export type NodeMessageTypeName =
  | 'MESSAGE_TYPE_CAST_ADD'
  | 'MESSAGE_TYPE_CAST_REMOVE'
  | 'MESSAGE_TYPE_REACTION_ADD'
  | 'MESSAGE_TYPE_REACTION_REMOVE'
  | 'MESSAGE_TYPE_LINK_ADD'
  | 'MESSAGE_TYPE_LINK_REMOVE'
  | 'MESSAGE_TYPE_USER_DATA_ADD'
  | 'MESSAGE_TYPE_KEY_ADD'
  | 'MESSAGE_TYPE_KEY_REMOVE'
  | (string & {});

export type NodeReactionTypeName =
  | 'REACTION_TYPE_LIKE'
  | 'REACTION_TYPE_RECAST'
  | 'REACTION_TYPE_NONE'
  | (string & {});

/** The query parameter form the node accepts (`ReactionType` as Rust variant). */
export type ReactionTypeQuery = 'Like' | 'Recast' | 'None';

export type NodeCastTypeName =
  | 'CAST'
  | 'LONG_CAST'
  | 'TEN_K_CAST'
  | (string & {});

export type NodeUserDataTypeName =
  | 'USER_DATA_TYPE_PFP'
  | 'USER_DATA_TYPE_DISPLAY'
  | 'USER_DATA_TYPE_BIO'
  | 'USER_DATA_TYPE_URL'
  | 'USER_DATA_TYPE_USERNAME'
  | 'USER_DATA_TYPE_LOCATION'
  | 'USER_DATA_TYPE_TWITTER'
  | 'USER_DATA_TYPE_GITHUB'
  | 'USER_DATA_TYPE_BANNER'
  | (string & {});

export type NodeSignerSourceName =
  | 'SIGNER_SOURCE_ONCHAIN'
  | 'SIGNER_SOURCE_OFFCHAIN'
  | 'SIGNER_SOURCE_NONE'
  | (string & {});

export interface NodeSignerSourceRef {
  /** 0x-hex Ed25519 public key of the signer. */
  key: string;
  /** 1 = Ed25519. */
  keyType: number;
  /** Farcaster timestamp (seconds since the Farcaster epoch) the key was added. */
  addedAt?: number;
  /** Farcaster timestamp of the last message signed with this key (off-chain only). */
  lastUsedAt?: number;
  /** Sliding expiry window in seconds (off-chain only). */
  ttl?: number;
  /** Farcaster timestamp the key expires at, derived from the last use. */
  expiresAt?: number;
  /** Message types this key may sign, as proto names (off-chain only). */
  scopes?: NodeMessageTypeName[];
  /** FID of the app that requested the key (off-chain only). */
  requestFid?: number;
  /** Per-FID nonce the key was added with (off-chain only). */
  nonce?: number;
  /**
   * Raw `SignedKeyRequestMetadata` as the node stored it (base64, or 0x-hex on
   * some servers): the ABI-encoded record of which app FID requested this key.
   * Present for most on-chain signers, which is how a cast's client is resolved
   * (`clientAttribution.ts`).
   */
  metadata?: string;
  /** `1` = `SignedKeyRequestMetadata`. */
  metadataType?: number;
}

export interface NodeSigner extends NodeSignerSourceRef {
  source: NodeSignerSourceName;
  /** The FID the signer belongs to. */
  fid: number;
  /** Present for on-chain (custody-key) signers. */
  onChainEvent?: {
    type: string;
    chainId: number;
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    transactionHash: string;
    logIndex: number;
  };
}

export interface NodeSignersPage {
  signers: NodeSigner[];
  nextPageToken?: string;
  /** Active gasless (off-chain) keys for this FID. */
  gaslessSignerCount: number;
  /** Per-FID cap on active gasless keys (1000 today). */
  gaslessSignerLimit: number;
  /**
   * Current per-FID user nonce. The next custody-signed `KEY_ADD` (or
   * custody-signed `KEY_REMOVE`) must use a nonce strictly greater than this.
   */
  currentUserNonce: number;
  /** App nonces by requester FID (needs the `requesterFids` query param). */
  requesterFidNonces?: Record<string, number>;
}

export interface NodeDbStats {
  numMessages: number;
  numFidRegistrations: number;
  approxSize: number;
}

export interface NodeShardInfo {
  shardId: number;
  maxHeight: number;
  numMessages: number;
  numFidRegistrations: number;
  [key: string]: unknown;
}

export interface NodeInfo {
  version: string;
  numShards: number;
  peerId: string;
  shardInfos: NodeShardInfo[];
  nextEngineVersionTimestamp: number;
  dbStats?: NodeDbStats;
}

export interface NodeStorageLimit {
  storeType?: string;
  name: string;
  limit: number;
  used: number;
  earliestTimestamp?: number;
}

export interface NodeStorageLimits {
  limits: NodeStorageLimit[];
}

export interface NodeCastId {
  fid: number;
  /** 0x-hex cast hash. */
  hash: string;
}

export type NodeEmbed = { url: string } | { castId: NodeCastId };

export interface NodeCastAddBody {
  text: string;
  castType: NodeCastTypeName;
  embeds: NodeEmbed[];
  embedsDeprecated: string[];
  mentions: number[];
  mentionsPositions: number[];
  parentCastId?: NodeCastId;
  parentUrl?: string;
}

export interface NodeCastRemoveBody {
  /** 0x-hex hash of the cast being removed. */
  targetHash: string;
}

export interface NodeReactionBody {
  reactionType: NodeReactionTypeName;
  targetCastId?: NodeCastId;
  targetUrl?: string;
}

export interface NodeLinkBody {
  /** Free-form in the protocol: `follow`, `block`, ... */
  linkType: string;
  targetFid?: number;
  displayTimestamp?: number;
}

export interface NodeUserDataBody {
  userDataType: NodeUserDataTypeName;
  value: string;
}

export interface NodeKeyAddBody {
  /** 0x-hex Ed25519 public key being added. */
  key: string;
  keyType: number;
  /** 0x-hex EIP-712 signature from the custody address. */
  custodySignature: string;
  /** Farcaster timestamp after which the custody authorization expires. */
  deadline: number;
  nonce: number;
  /** ABI-encoded SignedKeyRequest metadata, 0x-hex. */
  metadata: string;
  metadataType: number;
  registrationTxHash: string;
  scopes: NodeMessageTypeName[];
  ttl: number;
}

export interface NodeKeyRemoveBody {
  key: string;
  signature: string;
  signatureType: number;
  deadline: number;
  nonce: number;
}

/**
 * A message as the node hands it back: envelope fields plus exactly one
 * decoded body, discriminated by `type`.
 */
export interface NodeMessage {
  /** 0x-hex 20-byte blake3 digest of the serialized `data`. */
  hash: string;
  /** 0x-hex Ed25519 public key (or custody address for EIP-712 messages). */
  signer: string;
  /** base64 signature over `hash`. */
  signature: string;
  signatureScheme: string;
  hashScheme: string;
  fid: number;
  /** Farcaster timestamp in seconds (seconds since 2021-01-01). */
  timestamp: number;
  /** `timestamp` as a Unix millisecond time. */
  timestampMs: number;
  network: NodeNetworkName;
  type: NodeMessageTypeName;
  castAdd?: NodeCastAddBody;
  castRemove?: NodeCastRemoveBody;
  reaction?: NodeReactionBody;
  link?: NodeLinkBody;
  userData?: NodeUserDataBody;
  keyAdd?: NodeKeyAddBody;
  keyRemove?: NodeKeyRemoveBody;
}

export interface NodeMessagesPage {
  messages: NodeMessage[];
  nextPageToken?: string;
}

/** Convenience: a cast-add message with its body non-optional. */
export interface NodeCastMessage extends NodeMessage {
  castAdd: NodeCastAddBody;
}

export interface NodeLinkMessage extends NodeMessage {
  link: NodeLinkBody;
}

export interface NodeUserDataMessage extends NodeMessage {
  userData: NodeUserDataBody;
}

export interface NodeOnChainSignersPage {
  /** Raw on-chain signer events as the node reports them. */
  events: unknown[];
  nextPageToken?: string;
}

export interface NodeHealth {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  info?: NodeInfo;
  error?: string;
}

/** A built-and-signed message, ready to submit or to inspect in tests. */
export interface BuiltMessage {
  /** Protobuf bytes as they go on the wire. */
  bytes: Uint8Array;
  /** 0x-hex message hash (the node's message id). */
  hash: string;
  /** The core message object (data, hash, signature, signer). */
  message: import('@farcaster/core').Message;
}
