/**
 * Message builders: text, follows, reactions, profile data — signed by the
 * client's own Ed25519 app key and addressed to your own node.
 *
 * Every builder returns {@link BuiltMessage}: the protobuf bytes that go on
 * the wire plus the core `Message` object for inspection. Nothing here signs
 * anything with the custody key — that is only ever used for the gasless
 * `KEY_ADD` authorization in `appKey.ts`.
 */

import {
  CastType,
  FarcasterNetwork,
  type HubAsyncResult,
  type HubResult,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  makeUserDataAdd,
  type Message,
  MessageType,
  NobleEd25519Signer,
  ReactionType,
  UserDataType,
} from '@farcaster/core';
import type { LocalAccount } from 'viem';

import { MessageBuildError } from './errors';
import type { BuiltMessage } from './types';
import { bytesToHex, encodeMessage, hexToBytes } from './wire';

/**
 * The custody signer: a viem `LocalAccount` — exactly what `mnemonicToAccount`
 * returns in the browser, so the same value flows from the seed-phrase import
 * into the EIP-712 `KeyAdd` authorization without a translation layer.
 */
export type SignerAccount = LocalAccount;

export interface BaseMessageOptions {
  /** FID that authors the message. */
  fid: number;
  /** 32-byte Ed25519 private key of the app key. */
  signerPrivateKey: Uint8Array;
  /** Farcaster-seconds timestamp; defaults to now. */
  timestamp?: number;
  network?: FarcasterNetwork;
}

export type CastEmbedInput =
  | { url: string }
  | { castId: { fid: number; hash: string } };

export interface BuildCastAddOptions extends BaseMessageOptions {
  text: string;
  /** Parent cast (reply) or parent URL (channel cast). */
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
  embeds?: CastEmbedInput[];
  mentions?: number[];
  mentionsPositions?: number[];
  /** Overrides the type derived from the text length. */
  castType?: CastType;
}

export interface BuildCastRemoveOptions extends BaseMessageOptions {
  /** 0x-hex hash of the cast to remove. */
  targetHash: string;
}

export interface BuildReactionOptions extends BaseMessageOptions {
  reactionType: 'like' | 'recast';
  targetCastId?: { fid: number; hash: string };
  targetUrl?: string;
}

export interface BuildLinkOptions extends BaseMessageOptions {
  targetFid: number;
  /** Protocol link type; `follow` covers the client's follow button. */
  linkType?: string;
  displayTimestamp?: number;
}

export interface BuildUserDataOptions extends BaseMessageOptions {
  userDataType:
    | 'pfp'
    | 'display'
    | 'bio'
    | 'url'
    | 'username'
    | 'location'
    | 'twitter'
    | 'github'
    | 'banner';
  value: string;
}

/** Unwrap a `@farcaster/core` result, turning rejections into build errors. */
export const unwrap = <T>(result: HubResult<T>): T => {
  if (result.isErr()) {
    const error = result.error as unknown as {
      errCode?: string;
      code?: string;
      message: string;
    };
    throw new MessageBuildError(error.message, error.errCode ?? error.code);
  }
  return result.value;
};

export const unwrapAsync = async <T>(result: HubAsyncResult<T>): Promise<T> =>
  unwrap(await result);

export const utf8ByteLength = (value: string): number =>
  typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(value).length
    : Buffer.byteLength(value, 'utf8');

/**
 * The protocol's three cast sizes: 320 bytes, then `LONG_CAST` up to 1024, then
 * `TEN_K_CAST` up to 10,000. The node validates the declared type against the
 * text length, so the client must pick the right one rather than always CAST.
 */
export const castTypeForText = (text: string): CastType => {
  const bytes = utf8ByteLength(text);
  if (bytes <= 320) {
    return CastType.CAST;
  }
  if (bytes <= 1024) {
    return CastType.LONG_CAST;
  }
  if (bytes <= 10000) {
    return CastType.TEN_K_CAST;
  }
  throw new MessageBuildError(
    `Cast text is ${bytes} bytes; the protocol caps casts at 10,000`,
  );
};

const reactionTypeFor = (type: 'like' | 'recast'): ReactionType =>
  type === 'like' ? ReactionType.LIKE : ReactionType.RECAST;

const userDataTypeFor = (
  type: BuildUserDataOptions['userDataType'],
): UserDataType => {
  switch (type) {
    case 'pfp':
      return UserDataType.PFP;
    case 'display':
      return UserDataType.DISPLAY;
    case 'bio':
      return UserDataType.BIO;
    case 'url':
      return UserDataType.URL;
    case 'username':
      return UserDataType.USERNAME;
    case 'location':
      return UserDataType.LOCATION;
    case 'twitter':
      return UserDataType.TWITTER;
    case 'github':
      return UserDataType.GITHUB;
    case 'banner':
      return UserDataType.BANNER;
    default:
      throw new MessageBuildError(
        `Unsupported user data type: ${String(type)}`,
      );
  }
};

const defaultNetwork = (network?: FarcasterNetwork): FarcasterNetwork =>
  network ?? FarcasterNetwork.MAINNET;

const toBuiltMessage = (message: Message): BuiltMessage => ({
  bytes: encodeMessage(message),
  hash: bytesToHex(message.hash),
  message,
});

const dataOptionsFor = ({ fid, timestamp, network }: BaseMessageOptions) => ({
  fid,
  network: defaultNetwork(network),
  ...(timestamp === undefined ? {} : { timestamp }),
});

export const buildCastAddMessage = async (
  options: BuildCastAddOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const text = options.text ?? '';
  const body = {
    text,
    type: options.castType ?? castTypeForText(text),
    embeds: (options.embeds ?? []).map((embed) =>
      'url' in embed
        ? { url: embed.url }
        : {
            castId: {
              fid: embed.castId.fid,
              hash: hexToBytes(embed.castId.hash),
            },
          },
    ),
    embedsDeprecated: [],
    mentions: options.mentions ?? [],
    mentionsPositions: options.mentionsPositions ?? [],
    ...(options.parentCastId
      ? {
          parentCastId: {
            fid: options.parentCastId.fid,
            hash: hexToBytes(options.parentCastId.hash),
          },
        }
      : {}),
    ...(options.parentUrl ? { parentUrl: options.parentUrl } : {}),
  };
  const message = await unwrapAsync(
    makeCastAdd(body as never, dataOptionsFor(options), signer),
  );
  return toBuiltMessage(message);
};

export const buildCastRemoveMessage = async (
  options: BuildCastRemoveOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const message = await unwrapAsync(
    makeCastRemove(
      { targetHash: hexToBytes(options.targetHash) },
      dataOptionsFor(options),
      signer,
    ),
  );
  return toBuiltMessage(message);
};

export const buildReactionAddMessage = async (
  options: BuildReactionOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const body = {
    type: reactionTypeFor(options.reactionType),
    ...(options.targetCastId
      ? {
          targetCastId: {
            fid: options.targetCastId.fid,
            hash: hexToBytes(options.targetCastId.hash),
          },
        }
      : {}),
    ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
  };
  const message = await unwrapAsync(
    makeReactionAdd(body as never, dataOptionsFor(options), signer),
  );
  return toBuiltMessage(message);
};

export const buildReactionRemoveMessage = async (
  options: BuildReactionOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const body = {
    type: reactionTypeFor(options.reactionType),
    ...(options.targetCastId
      ? {
          targetCastId: {
            fid: options.targetCastId.fid,
            hash: hexToBytes(options.targetCastId.hash),
          },
        }
      : {}),
    ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
  };
  const message = await unwrapAsync(
    makeReactionRemove(body as never, dataOptionsFor(options), signer),
  );
  return toBuiltMessage(message);
};

export const buildLinkAddMessage = async (
  options: BuildLinkOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const body = {
    type: options.linkType ?? 'follow',
    targetFid: options.targetFid,
    ...(options.displayTimestamp === undefined
      ? {}
      : { displayTimestamp: options.displayTimestamp }),
  };
  const message = await unwrapAsync(
    makeLinkAdd(body, dataOptionsFor(options), signer),
  );
  return toBuiltMessage(message);
};

export const buildLinkRemoveMessage = async (
  options: BuildLinkOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const body = {
    type: options.linkType ?? 'follow',
    targetFid: options.targetFid,
  };
  const message = await unwrapAsync(
    makeLinkRemove(body, dataOptionsFor(options), signer),
  );
  return toBuiltMessage(message);
};

export const buildUserDataAddMessage = async (
  options: BuildUserDataOptions,
): Promise<BuiltMessage> => {
  const signer = new NobleEd25519Signer(options.signerPrivateKey);
  const message = await unwrapAsync(
    makeUserDataAdd(
      { type: userDataTypeFor(options.userDataType), value: options.value },
      dataOptionsFor(options),
      signer,
    ),
  );
  return toBuiltMessage(message);
};

/**
 * Profile fields are cleared by adding an empty value — the protocol has no
 * `USER_DATA_REMOVE` message type (and `@farcaster/core` has no builder for it).
 */
export const clearUserData = (
  options: Omit<BuildUserDataOptions, 'value'>,
): Promise<BuiltMessage> => buildUserDataAddMessage({ ...options, value: '' });

/** The message types a client app key requests by default. */
export const DEFAULT_APP_KEY_SCOPES: MessageType[] = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
  MessageType.USER_DATA_ADD,
];
