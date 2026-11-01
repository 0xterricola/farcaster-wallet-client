/**
 * The builders must produce messages the *node* accepts, not just objects that
 * look right in JS. Every assertion here is on the protobuf bytes: decode them
 * with an independent decode call, recompute the blake3 hash, verify the
 * Ed25519 signature, and compare the `dataBytes` field snapchain relies on.
 */

import {
  CastType,
  ed25519,
  makeMessageHash,
  Message,
  MessageData,
  MessageType,
  ReactionType,
  UserDataType,
} from '@farcaster/core';
import { describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import { MessageBuildError } from '../errors';
import {
  buildCastAddMessage,
  buildCastRemoveMessage,
  buildLinkAddMessage,
  buildLinkRemoveMessage,
  buildReactionAddMessage,
  buildReactionRemoveMessage,
  buildUserDataAddMessage,
  castTypeForText,
  utf8ByteLength,
} from '../messages';
import { bytesToHex, decodeMessageBytes, hexToBytes } from '../wire';
import { fixedRandomBytes, TEST_FID } from './fixtures';

const appKey = async () => generateAppKey(fixedRandomBytes(7));

const verifyBytes = async (bytes: Uint8Array): Promise<Message['data']> => {
  const decoded = decodeMessageBytes(bytes);

  // 1. The hash the node recomputes from `data` must match the envelope hash.
  const recomputed = await makeMessageHash(decoded.data as never);
  expect(recomputed.isErr()).toBe(false);
  expect(bytesToHex(recomputed._unsafeUnwrap())).toBe(bytesToHex(decoded.hash));

  // 2. The envelope signature must verify against the signer key.
  const verified = await ed25519.verifyMessageHashSignature(
    decoded.signature,
    decoded.hash,
    decoded.signer,
  );
  expect(verified.isErr()).toBe(false);
  expect(verified._unsafeUnwrap()).toBe(true);

  // 3. snapchain serializes `data` in Rust, so messages must carry `dataBytes`
  //    (the JS serialization) — core sets it, and it must be the real encoding.
  expect(decoded.dataBytes?.length ?? 0).toBeGreaterThan(0);
  expect(bytesToHex(decoded.dataBytes as Uint8Array)).toBe(
    bytesToHex(MessageData.encode(decoded.data as never).finish()),
  );

  return decoded.data;
};

describe('cast add', () => {
  it('signs a cast whose bytes the node can verify', async () => {
    const key = await appKey();
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'Reading and writing through my own Snapchain node.',
      timestamp: 12_000_000,
    });

    const data = await verifyBytes(built.bytes);
    expect(data?.type).toBe(MessageType.CAST_ADD);
    expect(data?.fid).toBe(TEST_FID);
    expect(data?.timestamp).toBe(12_000_000);
    expect(data?.castAddBody?.text).toBe(
      'Reading and writing through my own Snapchain node.',
    );
    expect(data?.castAddBody?.type).toBe(CastType.CAST);
    expect(bytesToHex(built.message.signer)).toBe(key.publicKeyHex);
    expect(built.hash).toBe(bytesToHex(built.message.hash));
  });

  it('carries url and castId embeds, mentions and their positions', async () => {
    const key = await appKey();
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'look at this',
      embeds: [
        { url: 'https://fiddy.fun/client' },
        { castId: { fid: 2, hash: `0x${'11'.repeat(20)}` } },
      ],
      mentions: [3],
      mentionsPositions: [0],
    });

    const data = await verifyBytes(built.bytes);
    const embeds = data?.castAddBody?.embeds ?? [];
    expect(embeds).toHaveLength(2);
    expect(embeds[0]).toMatchObject({ url: 'https://fiddy.fun/client' });
    expect(bytesToHex(embeds[1]?.castId?.hash ?? new Uint8Array())).toBe(
      `0x${'11'.repeat(20)}`,
    );
    expect(data?.castAddBody?.mentions).toEqual([3]);
    expect(data?.castAddBody?.mentionsPositions).toEqual([0]);
  });

  it('addresses a reply with parentCastId and a channel cast with parentUrl', async () => {
    const key = await appKey();
    const reply = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'replying',
      parentCastId: { fid: 2, hash: `0x${'22'.repeat(20)}` },
    });
    const channel = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'in a channel',
      parentUrl: 'https://farcaster.xyz/~/channel/fiddy',
    });

    const replyData = await verifyBytes(reply.bytes);
    expect(replyData?.castAddBody?.parentCastId?.fid).toBe(2);
    expect(
      bytesToHex(
        replyData?.castAddBody?.parentCastId?.hash ?? new Uint8Array(),
      ),
    ).toBe(`0x${'22'.repeat(20)}`);
    expect(replyData?.castAddBody?.parentUrl).toBeUndefined();

    const channelData = await verifyBytes(channel.bytes);
    expect(channelData?.castAddBody?.parentUrl).toBe(
      'https://farcaster.xyz/~/channel/fiddy',
    );
  });
});

describe('cast sizes', () => {
  it('maps text length to CAST, LONG_CAST and TEN_K_CAST at the protocol boundaries', () => {
    expect(castTypeForText('a'.repeat(320))).toBe(CastType.CAST);
    expect(castTypeForText('a'.repeat(321))).toBe(CastType.LONG_CAST);
    expect(castTypeForText('a'.repeat(1024))).toBe(CastType.LONG_CAST);
    expect(castTypeForText('a'.repeat(1025))).toBe(CastType.TEN_K_CAST);
    expect(castTypeForText('a'.repeat(10_000))).toBe(CastType.TEN_K_CAST);
  });

  it('counts bytes, not characters, so unicode does not slip past the 320-byte cap', () => {
    const emoji = '🎯'.repeat(80); // 4 bytes each
    expect(utf8ByteLength(emoji)).toBe(320);
    expect(castTypeForText(emoji)).toBe(CastType.CAST);
    expect(castTypeForText(`${emoji}🎯`)).toBe(CastType.LONG_CAST);
  });

  it('refuses text the protocol cannot carry', () => {
    expect(() => castTypeForText('a'.repeat(10_001))).toThrow(
      MessageBuildError,
    );
  });

  it('signs a long cast with the long cast type', async () => {
    const key = await appKey();
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'a'.repeat(1000),
    });
    const data = await verifyBytes(built.bytes);
    expect(data?.castAddBody?.type).toBe(CastType.LONG_CAST);
  });
});

describe('reactions, follows and profile data', () => {
  it('likes and unlikes a cast', async () => {
    const key = await appKey();
    const target = { fid: 2, hash: `0x${'33'.repeat(20)}` };
    const like = await buildReactionAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      reactionType: 'like',
      targetCastId: target,
    });
    const unlike = await buildReactionRemoveMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      reactionType: 'like',
      targetCastId: target,
    });

    const likeData = await verifyBytes(like.bytes);
    expect(likeData?.type).toBe(MessageType.REACTION_ADD);
    expect(likeData?.reactionBody?.type).toBe(ReactionType.LIKE);
    expect(
      bytesToHex(
        likeData?.reactionBody?.targetCastId?.hash ?? new Uint8Array(),
      ),
    ).toBe(target.hash);
    expect((await verifyBytes(unlike.bytes))?.type).toBe(
      MessageType.REACTION_REMOVE,
    );
  });

  it('recasts and reacts to a URL target', async () => {
    const key = await appKey();
    const recast = await buildReactionAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      reactionType: 'recast',
      targetCastId: { fid: 2, hash: `0x${'44'.repeat(20)}` },
    });
    const urlLike = await buildReactionAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      reactionType: 'like',
      targetUrl: 'https://farcaster.xyz/~/channel/fiddy',
    });

    expect((await verifyBytes(recast.bytes))?.reactionBody?.type).toBe(
      ReactionType.RECAST,
    );
    expect((await verifyBytes(urlLike.bytes))?.reactionBody?.targetUrl).toBe(
      'https://farcaster.xyz/~/channel/fiddy',
    );
  });

  it('follows and unfollows with a link message', async () => {
    const key = await appKey();
    const follow = await buildLinkAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      targetFid: 3,
    });
    const unfollow = await buildLinkRemoveMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      targetFid: 3,
    });

    const followData = await verifyBytes(follow.bytes);
    expect(followData?.type).toBe(MessageType.LINK_ADD);
    expect(followData?.linkBody?.type).toBe('follow');
    expect(followData?.linkBody?.targetFid).toBe(3);
    expect((await verifyBytes(unfollow.bytes))?.type).toBe(
      MessageType.LINK_REMOVE,
    );
  });

  it('sets profile fields', async () => {
    const key = await appKey();
    const built = await buildUserDataAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      userDataType: 'display',
      value: 'Fiddy',
    });
    const data = await verifyBytes(built.bytes);
    expect(data?.type).toBe(MessageType.USER_DATA_ADD);
    expect(data?.userDataBody?.type).toBe(UserDataType.DISPLAY);
    expect(data?.userDataBody?.value).toBe('Fiddy');
  });
});

describe('signing keys stay separate', () => {
  it('signs client messages with the app key, never the custody key', async () => {
    const key = await appKey();
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'signed by my app key',
    });
    const decoded = decodeMessageBytes(built.bytes);
    // The envelope signer is the 32-byte Ed25519 app key — not a 20-byte address.
    expect(decoded.signer.length).toBe(32);
    expect(bytesToHex(decoded.signer)).toBe(key.publicKeyHex);
  });

  it('produces different bytes for the same text at different timestamps', async () => {
    const key = await appKey();
    const first = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'same text',
      timestamp: 12_000_000,
    });
    const second = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'same text',
      timestamp: 12_000_001,
    });
    expect(first.hash).not.toBe(second.hash);
  });

  it('removes a cast by its hash', async () => {
    const key = await appKey();
    const built = await buildCastRemoveMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      targetHash: `0x${'55'.repeat(20)}`,
    });
    const data = await verifyBytes(built.bytes);
    expect(data?.type).toBe(MessageType.CAST_REMOVE);
    expect(
      bytesToHex(data?.castRemoveBody?.targetHash ?? new Uint8Array()),
    ).toBe(`0x${'55'.repeat(20)}`);
  });
});

describe('protobuf round trip', () => {
  it('re-encodes the decoded message to identical bytes', async () => {
    const key = await appKey();
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'round trip',
      embeds: [{ url: 'https://fiddy.fun' }],
    });
    const decoded = decodeMessageBytes(built.bytes);
    const reEncoded = (
      Message as unknown as {
        encode(message: Message): { finish(): Uint8Array };
      }
    )
      .encode(decoded)
      .finish();
    expect(bytesToHex(reEncoded)).toBe(bytesToHex(built.bytes));
  });

  it('decodes a hex cast id back to the same bytes the builder put in', async () => {
    const key = await appKey();
    const hash = `0x${'66'.repeat(20)}`;
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: key.privateKey,
      text: 'hash identity',
      parentCastId: { fid: 9, hash },
    });
    const decoded = decodeMessageBytes(built.bytes);
    expect(
      bytesToHex(
        decoded.data?.castAddBody?.parentCastId?.hash ?? new Uint8Array(),
      ),
    ).toBe(hash);
    expect(hexToBytes(hash).length).toBe(20);
  });
});
