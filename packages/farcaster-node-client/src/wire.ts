/**
 * The node's HTTP wire format: JSON in, JSON out, protobuf for writes.
 *
 * Everything the node answers `/v1/*` with is JSON, but the byte fields inside
 * are inconsistent on purpose-adjacent grounds (see snapchain's
 * `src/network/http_server.rs`):
 *
 *   - `signature` on a message envelope is base64,
 *   - `hash` / `signer` / `targetHash` / embed cast hashes are `0x`-hex,
 *   - proto enums arrive as their `as_str_name()` values
 *     (`MESSAGE_TYPE_CAST_ADD`, `REACTION_TYPE_LIKE`, ...), except
 *     `linkBody.type`, which is a free-form protocol string (`follow`),
 *   - `parentUrl` is explicitly `null` rather than omitted,
 *   - `pageToken`/`nextPageToken` are base64.
 *
 * Writes are not JSON at all: `POST /v1/submitMessage` demands
 * `Content-Type: application/octet-stream` and a binary protobuf `Message`
 * body. `encodeMessage` / `decodeMessage` below are the two directions, both
 * delegating to `@farcaster/core` so we never re-implement protobuf by hand.
 */

import {
  CastType,
  castTypeToJSON,
  FARCASTER_EPOCH,
  type FarcasterNetwork,
  farcasterNetworkToJSON,
  fromFarcasterTime,
  getFarcasterTime,
  type HashScheme,
  hashSchemeToJSON,
  Message,
  MessageType,
  messageTypeToJSON,
  type ReactionType,
  reactionTypeToJSON,
  type SignatureScheme,
  signatureSchemeToJSON,
  toFarcasterTime,
  userDataTypeToJSON,
} from '@farcaster/core';

import type {
  NodeCastAddBody,
  NodeCastId,
  NodeCastRemoveBody,
  NodeEmbed,
  NodeInfo,
  NodeKeyAddBody,
  NodeKeyRemoveBody,
  NodeLinkBody,
  NodeMessage,
  NodeMessagesPage,
  NodeMessageTypeName,
  NodeReactionBody,
  NodeSigner,
  NodeSignersPage,
  NodeStorageLimits,
  NodeUserDataBody,
} from './types';

// --- byte helpers ---------------------------------------------------------

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '0x';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out as `0x${string}`;
}

export function hexToBytes(value: string): Uint8Array {
  const hex =
    value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string (odd length): ${value}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex string: ${value}`);
    }
    out[i] = byte;
  }
  return out;
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (standard, padded) that works in both browsers and Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out +=
      b1 === undefined
        ? '='
        : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean.endsWith('=')
    ? clean
    : clean.padEnd(Math.ceil(clean.length / 4) * 4, '=');
  const out = new Uint8Array((padded.length / 4) * 3);
  let cursor = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const chunk = [0, 0, 0, 0];
    for (let j = 0; j < 4; j += 1) {
      const char = padded[i + j];
      chunk[j] = char === '=' ? 0 : BASE64_ALPHABET.indexOf(char);
      if (chunk[j] < 0) {
        throw new Error(`Invalid base64 string: ${value}`);
      }
    }
    out[cursor++] = (chunk[0] << 2) | (chunk[1] >> 4);
    if (padded[i + 2] !== '=') {
      out[cursor++] = ((chunk[1] & 0x0f) << 4) | (chunk[2] >> 2);
    }
    if (padded[i + 3] !== '=') {
      out[cursor++] = ((chunk[2] & 0x03) << 6) | chunk[3];
    }
  }
  return out.slice(0, cursor);
}

// --- time -----------------------------------------------------------------

/** Farcaster seconds -> Unix milliseconds. */
export const farcasterSecondsToUnixMs = (seconds: number): number =>
  seconds * 1000 + FARCASTER_EPOCH;

/** Unix milliseconds -> Farcaster seconds. */
export const unixMsToFarcasterSeconds = (ms: number): number => {
  const converted = toFarcasterTime(ms);
  if (converted.isErr()) {
    throw new Error(
      `Cannot convert ${ms} to Farcaster time: ${converted.error.message}`,
    );
  }
  return converted.value;
};

/** Farcaster-seconds "now" (seconds since the Farcaster epoch). */
export const getFarcasterSeconds = (): number => {
  const timestamp = getFarcasterTime();
  if (timestamp.isErr()) {
    throw new Error(`Cannot read Farcaster time: ${timestamp.error.message}`);
  }
  return timestamp.value;
};

/** Farcaster seconds -> Unix seconds (what `/v1/signersByFid` reports). */
export const farcasterSecondsToUnixSeconds = (seconds: number): number =>
  Math.floor(farcasterSecondsToUnixMs(seconds) / 1000);

/** Unix seconds -> Farcaster seconds. */
export const unixSecondsToFarcasterSeconds = (seconds: number): number =>
  unixMsToFarcasterSeconds(seconds * 1000);

export const unixMsToFarcasterSecondsSafe = (ms: number): number => {
  const converted = fromFarcasterTime(
    Math.round((ms - FARCASTER_EPOCH) / 1000),
  );
  return converted.isOk() ? converted.value : 0;
};

// --- enum names -----------------------------------------------------------

/** `MessageType` -> proto name, e.g. `1` -> `MESSAGE_TYPE_CAST_ADD`. */
export const messageTypeName = (type: MessageType): NodeMessageTypeName =>
  messageTypeToJSON(type) as NodeMessageTypeName;

export const reactionTypeName = (type: ReactionType): string =>
  reactionTypeToJSON(type);

export const castTypeName = (type: CastType): string => castTypeToJSON(type);

export const networkName = (network: FarcasterNetwork): string =>
  farcasterNetworkToJSON(network);

export const signatureSchemeName = (scheme: SignatureScheme): string =>
  signatureSchemeToJSON(scheme);

export const hashSchemeName = (scheme: HashScheme): string =>
  hashSchemeToJSON(scheme);

export const userDataTypeName = (type: number): string =>
  userDataTypeToJSON(type as Parameters<typeof userDataTypeToJSON>[0]);

/** Accepts either the wire name (`REACTION_TYPE_LIKE`) or the short form. */
export const isLikeReaction = (name: string | undefined): boolean =>
  name === 'REACTION_TYPE_LIKE' || name === 'LIKE' || name === 'like';

export const isRecastReaction = (name: string | undefined): boolean =>
  name === 'REACTION_TYPE_RECAST' || name === 'RECAST' || name === 'recast';

// --- protobuf -------------------------------------------------------------

/** Serialize a core `Message` exactly as the node expects it on the wire. */
export const encodeMessage = (message: Message): Uint8Array => {
  const bytes = (
    Message as unknown as { encode(m: Message): { finish(): Uint8Array } }
  )
    .encode(message)
    .finish();
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
};

/** Parse protobuf bytes back into a core `Message`. */
export const decodeMessageBytes = (bytes: Uint8Array): Message => {
  const decoded = (
    Message as unknown as { decode(b: Uint8Array): Message }
  ).decode(bytes);
  return decoded;
};

// --- responses ------------------------------------------------------------

type Json = Record<string, unknown>;

const asJson = (value: unknown): Json =>
  value && typeof value === 'object' ? (value as Json) : {};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asNumber = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0);

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const decodeCastId = (value: unknown): NodeCastId | undefined => {
  const json = asJson(value);
  if (typeof json.hash !== 'string' || typeof json.fid !== 'number') {
    return undefined;
  }
  return { fid: json.fid, hash: json.hash };
};

const decodeEmbeds = (value: unknown): NodeEmbed[] =>
  asArray(value).flatMap((entry): NodeEmbed[] => {
    const json = asJson(entry);
    if (typeof json.url === 'string') {
      return [{ url: json.url }];
    }
    const castId = decodeCastId(json.castId);
    return castId ? [{ castId }] : [];
  });

export const decodeCastAddBody = (value: unknown): NodeCastAddBody => {
  const json = asJson(value);
  return {
    text: asString(json.text),
    castType: asString(json.type) || 'CAST',
    embeds: decodeEmbeds(json.embeds),
    embedsDeprecated: asArray(json.embedsDeprecated).map((entry) =>
      String(entry),
    ),
    mentions: asArray(json.mentions).map((entry) => asNumber(entry)),
    mentionsPositions: asArray(json.mentionsPositions).map((entry) =>
      asNumber(entry),
    ),
    parentCastId: decodeCastId(json.parentCastId),
    parentUrl: asOptionalString(json.parentUrl) ?? undefined,
  };
};

const decodeCastRemoveBody = (value: unknown): NodeCastRemoveBody => {
  const json = asJson(value);
  return { targetHash: asString(json.targetHash) };
};

const decodeReactionBody = (value: unknown): NodeReactionBody => {
  const json = asJson(value);
  return {
    reactionType: asString(json.type),
    targetCastId: decodeCastId(json.targetCastId),
    targetUrl: asOptionalString(json.targetUrl),
  };
};

const decodeLinkBody = (value: unknown): NodeLinkBody => {
  const json = asJson(value);
  return {
    linkType: asString(json.type),
    targetFid: asOptionalNumber(json.targetFid),
    displayTimestamp: asOptionalNumber(json.displayTimestamp),
  };
};

const decodeUserDataBody = (value: unknown): NodeUserDataBody => {
  const json = asJson(value);
  return {
    userDataType: asString(json.type),
    value: asString(json.value),
  };
};

const decodeKeyAddBody = (value: unknown): NodeKeyAddBody => {
  const json = asJson(value);
  return {
    key: asString(json.key),
    keyType: asNumber(json.keyType),
    custodySignature: asString(json.custodySignature),
    deadline: asNumber(json.deadline),
    nonce: asNumber(json.nonce),
    metadata: asString(json.metadata),
    metadataType: asNumber(json.metadataType),
    registrationTxHash: asString(json.registrationTxHash),
    scopes: asArray(json.scopes).map((entry) => String(entry)),
    ttl: asNumber(json.ttl),
  };
};

const decodeKeyRemoveBody = (value: unknown): NodeKeyRemoveBody => {
  const json = asJson(value);
  return {
    key: asString(json.key),
    signature: asString(json.signature),
    signatureType: asNumber(json.signatureType),
    deadline: asNumber(json.deadline),
    nonce: asNumber(json.nonce),
  };
};

/** Node JSON message -> normalized message. */
export const decodeNodeMessage = (value: unknown): NodeMessage => {
  const json = asJson(value);
  const data = asJson(json.data);
  const timestamp = asNumber(data.timestamp);
  return {
    hash: asString(json.hash),
    signer: asString(json.signer),
    signature: asString(json.signature),
    signatureScheme: asString(json.signatureScheme),
    hashScheme: asString(json.hashScheme),
    fid: asNumber(data.fid),
    timestamp,
    timestampMs: farcasterSecondsToUnixMs(timestamp),
    network: asString(data.network),
    type: asString(data.type),
    castAdd: data.castAddBody ? decodeCastAddBody(data.castAddBody) : undefined,
    castRemove: data.castRemoveBody
      ? decodeCastRemoveBody(data.castRemoveBody)
      : undefined,
    reaction: data.reactionBody
      ? decodeReactionBody(data.reactionBody)
      : undefined,
    link: data.linkBody ? decodeLinkBody(data.linkBody) : undefined,
    userData: data.userDataBody
      ? decodeUserDataBody(data.userDataBody)
      : undefined,
    keyAdd: data.keyAddBody ? decodeKeyAddBody(data.keyAddBody) : undefined,
    keyRemove: data.keyRemoveBody
      ? decodeKeyRemoveBody(data.keyRemoveBody)
      : undefined,
  };
};

/**
 * Is this page token the end of the results?
 *
 * MEASURED against a live read node: the last page comes back with the token
 * `W251bGwsbnVsbF0=` (base64 of `[null,null]`), and asking *with* that token
 * returns the FIRST page again rather than an empty one. So a pager that loops
 * while a token is present loops for ever — and on a feed that means the follow
 * list grows without limit until the tab dies. Every paging loop in this
 * package must stop when this returns true.
 */
export const isTerminalPageToken = (token: string | undefined): boolean => {
  if (!token) {
    return true;
  }
  try {
    return /\[\s*null\s*,\s*null\s*\]/.test(atob(token));
  } catch {
    // An unreadable token cannot be shown to be a cursor, and looping is worse
    // than stopping one page early.
    return true;
  }
};

export const decodeMessagesPage = (value: unknown): NodeMessagesPage => {
  const json = asJson(value);
  return {
    messages: asArray(json.messages).map(decodeNodeMessage),
    nextPageToken: asOptionalString(json.nextPageToken),
  };
};

export const decodeInfo = (value: unknown): NodeInfo => {
  const json = asJson(value);
  const dbStats = asJson(json.dbStats);
  return {
    version: asString(json.version),
    numShards: asNumber(json.numShards),
    peerId: asString(json.peer_id ?? json.peerId),
    shardInfos: asArray(json.shardInfos).map((entry) => {
      const shard = asJson(entry);
      return {
        ...shard,
        shardId: asNumber(shard.shardId),
        maxHeight: asNumber(shard.maxHeight),
        numMessages: asNumber(shard.numMessages),
        numFidRegistrations: asNumber(shard.numFidRegistrations),
      };
    }) as NodeInfo['shardInfos'],
    nextEngineVersionTimestamp: asNumber(json.nextEngineVersionTimestamp),
    dbStats:
      typeof json.dbStats === 'undefined' || json.dbStats === null
        ? undefined
        : {
            numMessages: asNumber(dbStats.numMessages),
            numFidRegistrations: asNumber(dbStats.numFidRegistrations),
            approxSize: asNumber(dbStats.approxSize),
          },
  };
};

export const decodeSigner = (value: unknown): NodeSigner => {
  const json = asJson(value);
  // The signed-key-request metadata lives in a different place in every shape
  // the node has used for a signer record: on the message body, inside the
  // on-chain event's signer event body, or at the top level for a gasless key.
  // All three are read, because which one a cast's client can be resolved from
  // depends on which one carries it.
  const onChainSignerBody = asJson(asJson(json.onChainEvent).signerEventBody);
  const messageBody = asJson(json.signerMessageBody);
  const metadata =
    asOptionalString(json.metadata) ??
    asOptionalString(onChainSignerBody.metadata) ??
    asOptionalString(messageBody.metadata);
  const metadataType =
    asOptionalNumber(json.metadataType) ??
    asOptionalNumber(onChainSignerBody.metadataType) ??
    asOptionalNumber(messageBody.metadataType);
  return {
    source: asString(json.source),
    key: asString(json.key),
    keyType: asNumber(json.keyType),
    fid: asNumber(json.fid),
    addedAt: asOptionalNumber(json.addedAt),
    lastUsedAt: asOptionalNumber(json.lastUsedAt),
    ttl: asOptionalNumber(json.ttl),
    expiresAt: asOptionalNumber(json.expiresAt),
    scopes: Array.isArray(json.scopes)
      ? json.scopes.map((entry) => String(entry))
      : undefined,
    requestFid: asOptionalNumber(json.requestFid),
    nonce: asOptionalNumber(json.nonce),
    ...(metadata ? { metadata } : {}),
    ...(metadataType === undefined ? {} : { metadataType }),
    onChainEvent: json.onChainEvent
      ? (asJson(json.onChainEvent) as NodeSigner['onChainEvent'])
      : undefined,
  };
};

export const decodeSignersPage = (value: unknown): NodeSignersPage => {
  const json = asJson(value);
  const rawNonces = asJson(json.requesterFidNonces);
  const requesterFidNonces: Record<string, number> = {};
  for (const [key, nonce] of Object.entries(rawNonces)) {
    requesterFidNonces[key] = asNumber(nonce);
  }
  return {
    signers: asArray(json.signers).map(decodeSigner),
    nextPageToken: asOptionalString(json.nextPageToken),
    gaslessSignerCount: asNumber(json.gaslessSignerCount),
    gaslessSignerLimit: asNumber(json.gaslessSignerLimit),
    currentUserNonce: asNumber(json.currentUserNonce),
    requesterFidNonces:
      Object.keys(requesterFidNonces).length > 0
        ? requesterFidNonces
        : undefined,
  };
};

export const decodeStorageLimits = (value: unknown): NodeStorageLimits => {
  const json = asJson(value);
  return {
    limits: asArray(json.limits).map((entry) => {
      const limit = asJson(entry);
      return {
        storeType: asOptionalString(limit.storeType),
        name: asString(limit.name),
        limit: asNumber(limit.limit),
        used: asNumber(limit.used),
        earliestTimestamp: asOptionalNumber(limit.earliestTimestamp),
      };
    }),
  };
};

// --- requests (encoding) --------------------------------------------------

/**
 * Normalized message -> the node's JSON message shape. Used by the fake node
 * in tests and by `serialize` helpers; the real submit path sends protobuf.
 */
export const encodeNodeMessageJson = (message: NodeMessage): Json => ({
  data: {
    type: message.type,
    fid: message.fid,
    timestamp: message.timestamp,
    network: message.network,
    ...(message.castAdd
      ? {
          castAddBody: {
            embedsDeprecated: message.castAdd.embedsDeprecated,
            mentions: message.castAdd.mentions,
            parentCastId: message.castAdd.parentCastId ?? null,
            parentUrl: message.castAdd.parentUrl ?? null,
            text: message.castAdd.text,
            embeds: message.castAdd.embeds.map((embed) =>
              'url' in embed ? { url: embed.url } : { castId: embed.castId },
            ),
            mentionsPositions: message.castAdd.mentionsPositions,
            type: message.castAdd.castType,
          },
        }
      : {}),
    ...(message.castRemove ? { castRemoveBody: message.castRemove } : {}),
    ...(message.reaction
      ? {
          reactionBody: {
            type: message.reaction.reactionType,
            targetCastId: message.reaction.targetCastId ?? null,
            targetUrl: message.reaction.targetUrl ?? null,
          },
        }
      : {}),
    ...(message.link
      ? {
          linkBody: {
            type: message.link.linkType,
            displayTimestamp: message.link.displayTimestamp ?? null,
            targetFid: message.link.targetFid ?? null,
          },
        }
      : {}),
    ...(message.userData
      ? {
          userDataBody: {
            type: message.userData.userDataType,
            value: message.userData.value,
          },
        }
      : {}),
    ...(message.keyAdd ? { keyAddBody: message.keyAdd } : {}),
    ...(message.keyRemove ? { keyRemoveBody: message.keyRemove } : {}),
  },
  hash: message.hash,
  hashScheme: message.hashScheme,
  signature: message.signature,
  signatureScheme: message.signatureScheme,
  signer: message.signer,
});

/**
 * Query parameters for `/v1/*`. The node accepts both the snake_case field
 * names and camelCase aliases for paging; `reaction_type` / `link_type` are
 * snake_case only, and the values are Rust variant names (`Like`), not proto
 * names (`REACTION_TYPE_LIKE`).
 */
export const buildQuery = (
  params: Record<string, string | number | boolean | undefined>,
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
};
