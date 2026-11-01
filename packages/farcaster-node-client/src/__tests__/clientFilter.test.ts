/**
 * Include/exclude casts by the client they came from.
 *
 * The resolving half talks to the node (signer -> `requestFid`); the filtering
 * half is pure. Both are tested: the pure part exhaustively, the resolving part
 * against the fake node counting its own `/v1/signer` lookups so the caching
 * claim is measured, not asserted by eye.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import { SnapchainNodeClient } from '../http';
import {
  appFidFromSignerRecord,
  CastClientResolver,
  clientIdentityFor,
  createAppClientNameLookup,
  decodeSignedKeyRequestMetadata,
  defaultClientFilterPolicy,
  filterCastsByClient,
} from '../index';
import { buildCastAddMessage, buildUserDataAddMessage } from '../messages';
import type { NodeMessage } from '../types';
import {
  fixedRandomBytes,
  startTestNode,
  TEST_FID,
  type TestNode,
} from './fixtures';

const OTHER_APP_FID = 9152;
/** An account that posts through the app above — never the app FID itself. */
const POSTING_FID = 4242;

/**
 * A REAL on-chain signer's metadata, taken from a live mainnet node
 * (`GET /v1/signer?fid=3&signer=0xc887…`): the key @dwr's casts are signed
 * with, whose signed key request names app FID 9152 (Warpcast). Kept verbatim
 * so the ABI decoder is tested against bytes the protocol actually produced,
 * not against bytes this repo encoded for itself.
 */
const LIVE_ONCHAIN_METADATA =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjwAAAAAAAAAAAAAAAAALveQ3XmTo1/YR8BT7drpQNBVWWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZO55jgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBmUVWQv9Ny0b1L47L0MPftfyiF8T0lECNeNpo2QK0Kv0HB3HHy1nUZ0J19bcxVHVt7jamCIeKonCMgLQe8kfOKBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let node: TestNode;
let client: SnapchainNodeClient;

beforeEach(async () => {
  node = await startTestNode();
  client = new SnapchainNodeClient({ baseUrl: node.url });
});

afterEach(async () => {
  await node.close();
});

const seedCast = async (options: {
  fid: number;
  signerPrivateKey: Uint8Array;
  text: string;
  timestamp: number;
}): Promise<NodeMessage> => {
  const built = await buildCastAddMessage(options);
  node.store(built.message);
  const page = await client.castsByFid({ fid: options.fid });
  return page.messages.find((message) => message.hash === built.hash)!;
};

const messageFor = (signer: string, fid = TEST_FID): NodeMessage =>
  ({
    hash: '0x00',
    signer,
    signature: '',
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    fid,
    timestamp: 1,
    timestampMs: 1,
    network: 'FARCASTER_NETWORK_MAINNET',
    type: 'MESSAGE_TYPE_CAST_ADD',
    castAdd: {
      text: 'x',
      castType: 'CAST',
      embeds: [],
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
    },
  }) as NodeMessage;

describe('clientIdentityFor (pure)', () => {
  it('calls a key that this client\u2019s own app FID requested "this client"', () => {
    const identity = clientIdentityFor({
      signerHex: '0xabc',
      signer: {
        source: 'SIGNER_SOURCE_OFFCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: TEST_FID,
        requestFid: TEST_FID,
        scopes: ['MESSAGE_TYPE_CAST_ADD'],
      },
      thisAppFid: TEST_FID,
    });
    expect(identity).toMatchObject({
      id: 'self',
      kind: 'self',
      label: 'Fiddy',
    });
  });

  it('calls a key the account asked for itself "their own key", not an app', () => {
    const identity = clientIdentityFor({
      signerHex: '0xabc',
      signer: {
        source: 'SIGNER_SOURCE_OFFCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: TEST_FID,
        requestFid: TEST_FID,
      },
      thisAppFid: 999,
      authorFid: TEST_FID,
    });
    expect(identity).toMatchObject({
      id: 'own',
      kind: 'own',
      label: 'their own key',
    });
  });

  it('keeps that answer even when the account has a profile of its own', () => {
    // The self-requested case, as a real node answers it: fid 7237's own key
    // has `requestFid: 7237`, and that account's own profile says "Thomas".
    // Reading the profile here would print "via Thomas" under a cast written by
    // Thomas — the author's own name wearing the client's clothes (measured on
    // live 2026-10-24, before this test existed).
    const identity = clientIdentityFor({
      signerHex: '0xabc',
      signer: {
        source: 'SIGNER_SOURCE_OFFCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: 7237,
        requestFid: 7237,
      },
      thisAppFid: 999,
      authorFid: 7237,
      name: { fid: 7237, username: 'aviationdoctor.eth', displayName: 'Thomas' },
    });
    expect(identity).toMatchObject({
      id: 'own',
      kind: 'own',
      label: 'their own key',
    });
  });

  it('names an app when the caller supplies a registry entry, and names it from its own profile otherwise', () => {
    const signer = {
      source: 'SIGNER_SOURCE_OFFCHAIN' as const,
      key: '0xdef',
      keyType: 1,
      fid: 5,
      requestFid: OTHER_APP_FID,
    };
    const named = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      thisAppFid: TEST_FID,
      knownClients: { [OTHER_APP_FID]: 'Some Client' },
    });
    expect(named).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Some Client',
    });

    // No reader label, but the app account says who it is.
    const fromProfile = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      thisAppFid: TEST_FID,
      name: {
        fid: OTHER_APP_FID,
        username: 'warpcast',
        displayName: 'Warpcast',
      },
    });
    expect(fromProfile).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Warpcast',
      username: 'warpcast',
    });

    // A reader's own label beats the app's own profile.
    const both = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      thisAppFid: TEST_FID,
      knownClients: { [OTHER_APP_FID]: 'Warpy' },
      name: {
        fid: OTHER_APP_FID,
        username: 'warpcast',
        displayName: 'Warpcast',
      },
    });
    expect(both?.label).toBe('Warpy');

    const unnamed = clientIdentityFor({
      signerHex: '0xdef',
      signer,
      thisAppFid: TEST_FID,
    });
    expect(unnamed?.kind).toBe('unknown');
    expect(unnamed?.label).toBe(`app ${OTHER_APP_FID}`);
  });

  it('reads an app FID out of an on-chain signer\u2019s ABI metadata', () => {
    const identity = clientIdentityFor({
      signerHex: '0xfed',
      signer: {
        source: 'SIGNER_SOURCE_ONCHAIN',
        key: '0xfed',
        keyType: 1,
        fid: 3,
        metadata: LIVE_ONCHAIN_METADATA,
        metadataType: 1,
      },
      name: {
        fid: OTHER_APP_FID,
        username: 'warpcast',
        displayName: 'Warpcast',
      },
    });
    expect(identity).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Warpcast',
      requestFid: OTHER_APP_FID,
    });
  });

  it('says "an on-chain key" when the protocol names no requesting app', () => {
    const identity = clientIdentityFor({
      signerHex: '0xfed',
      signer: {
        source: 'SIGNER_SOURCE_ONCHAIN',
        key: '0xfed',
        keyType: 1,
        fid: 2,
      },
    });
    expect(identity).toMatchObject({
      kind: 'onchain',
      label: 'an on-chain key',
    });
    expect(identity?.requestFid).toBeUndefined();
  });

  it('carries no label at all when the node has no signer record', () => {
    // An unresolved client is drawn without a label rather than as an "unknown"
    // badge: the node was asked and could not say, which is not a fact about
    // the cast.
    expect(clientIdentityFor({ signerHex: '0x999' })).toBeUndefined();
  });
});

describe('decodeSignedKeyRequestMetadata', () => {
  it('decodes real mainnet metadata (base64) to the app FID that requested the key', () => {
    const decoded = decodeSignedKeyRequestMetadata(LIVE_ONCHAIN_METADATA);
    expect(decoded?.requestFid).toBe(OTHER_APP_FID);
    expect(decoded?.requestSigner).toBe(
      '0x02ef790dd7993a35fd847c053eddae940d055596',
    );
    expect(decoded?.deadline).toBe(1693350286);
  });

  it('decodes the same bytes as 0x-hex, and reads the FID off a bare tuple', () => {
    const bytes = Buffer.from(LIVE_ONCHAIN_METADATA, 'base64');
    const hex = `0x${bytes.toString('hex')}`;
    expect(decodeSignedKeyRequestMetadata(hex)?.requestFid).toBe(OTHER_APP_FID);
    // The same tuple without the leading offset word (both shapes are real).
    const bare = `0x${bytes.subarray(32).toString('hex')}`;
    expect(decodeSignedKeyRequestMetadata(bare)?.requestFid).toBe(
      OTHER_APP_FID,
    );
  });

  it('refuses metadata that is not a signed key request rather than inventing a FID', () => {
    expect(decodeSignedKeyRequestMetadata(undefined)).toBeUndefined();
    expect(decodeSignedKeyRequestMetadata('')).toBeUndefined();
    expect(decodeSignedKeyRequestMetadata('not base64!!')).toBeUndefined();
    // All-zero words: no requesting FID.
    expect(
      decodeSignedKeyRequestMetadata(Buffer.alloc(128).toString('base64')),
    ).toBeUndefined();
  });

  it('prefers the record\u2019s own requestFid over anything encoded', () => {
    expect(
      appFidFromSignerRecord({
        source: 'SIGNER_SOURCE_OFFCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: 5,
        requestFid: 4242,
        metadata: LIVE_ONCHAIN_METADATA,
      }),
    ).toBe(4242);
    // A metadata type that is not a signed key request carries no app FID.
    expect(
      appFidFromSignerRecord({
        source: 'SIGNER_SOURCE_ONCHAIN',
        key: '0xabc',
        keyType: 1,
        fid: 5,
        metadata: LIVE_ONCHAIN_METADATA,
        metadataType: 0,
      }),
    ).toBeUndefined();
  });
});

describe('CastClientResolver (against the node)', () => {
  it('resolves the client behind each cast from the node\u2019s signer records', async () => {
    const ownKey = await generateAppKey(fixedRandomBytes(21));
    const otherKey = await generateAppKey(fixedRandomBytes(22));
    node.addSigner({
      key: ownKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: TEST_FID,
    });
    // The shape every app key really has: an APP asked for a key, and that key
    // signs for somebody else. `requestFid` is the app; the key's own `fid` is
    // the account posting through it.
    node.addSigner({
      key: otherKey.publicKeyHex,
      fid: POSTING_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: OTHER_APP_FID,
    });

    const mine = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: ownKey.privateKey,
      text: 'from my node',
      timestamp: 12_000_001,
    });
    const theirs = await seedCast({
      fid: POSTING_FID,
      signerPrivateKey: otherKey.privateKey,
      text: 'from another client',
      timestamp: 12_000_002,
    });

    const resolver = new CastClientResolver({
      node: client,
      thisAppFid: TEST_FID,
      knownClients: { [OTHER_APP_FID]: 'Warpcast-like client' },
    });
    const clients = await resolver.resolveAll([mine, theirs]);

    expect(clients.get(mine.signer.toLowerCase())).toMatchObject({
      id: 'self',
      kind: 'self',
    });
    expect(clients.get(theirs.signer.toLowerCase())).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Warpcast-like client',
      requestFid: OTHER_APP_FID,
    });
  });

  it('resolves an on-chain key\u2019s client from its ABI metadata, and names it from the app\u2019s own profile', async () => {
    const onChainKey = await generateAppKey(fixedRandomBytes(24));
    // A cast signed by an on-chain key, exactly as the protocol stores one:
    // no top-level requestFid, the app FID encoded in the signer event.
    node.addSigner({
      key: onChainKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_ONCHAIN',
      metadata: LIVE_ONCHAIN_METADATA,
      metadataType: 1,
    });
    // ...and the app account's own profile, which is where the name comes from.
    const username = await buildUserDataAddMessage({
      fid: OTHER_APP_FID,
      signerPrivateKey: fixedRandomBytes(25)(32),
      userDataType: 'username',
      value: 'warpcast',
      timestamp: 12_100_000,
    });
    node.store(username.message);
    const display = await buildUserDataAddMessage({
      fid: OTHER_APP_FID,
      signerPrivateKey: fixedRandomBytes(25)(32),
      userDataType: 'display',
      value: 'Warpcast',
      timestamp: 12_100_001,
    });
    node.store(display.message);

    const cast = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: onChainKey.privateKey,
      text: 'posted through an app',
      timestamp: 12_000_001,
    });

    const resolver = new CastClientResolver({
      node: client,
      thisAppFid: 999,
      names: createAppClientNameLookup({ node: client }),
    });
    const identity = await resolver.resolve(cast);
    expect(identity).toMatchObject({
      id: `app:${OTHER_APP_FID}`,
      kind: 'known',
      label: 'Warpcast',
      username: 'warpcast',
      requestFid: OTHER_APP_FID,
    });
    expect(node.requestsFor('/v1/signer')).toHaveLength(1);
    expect(node.requestsFor('/v1/userDataByFid')).toHaveLength(1);

    // The name is cached: a second page of casts from the same app costs no
    // second read.
    await resolver.resolve(cast);
    expect(node.requestsFor('/v1/userDataByFid')).toHaveLength(1);
  });

  it('looks up each signer once, even across repeat calls', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(23));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: TEST_FID,
    });
    const first = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'one',
      timestamp: 12_000_001,
    });
    const second = await seedCast({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'two',
      timestamp: 12_000_002,
    });

    const resolver = new CastClientResolver({
      node: client,
      thisAppFid: TEST_FID,
    });
    await resolver.resolveAll([first, second, first]);
    expect(node.requestsFor('/v1/signer')).toHaveLength(1);

    await resolver.resolve(second);
    expect(node.requestsFor('/v1/signer')).toHaveLength(1);

    resolver.clear();
    await resolver.resolve(second);
    expect(node.requestsFor('/v1/signer')).toHaveLength(2);
  });

  it('does not fail the feed when a signer cannot be resolved', async () => {
    const unknown = messageFor(`0x${'aa'.repeat(32)}`);
    const resolver = new CastClientResolver({
      node: client,
      thisAppFid: TEST_FID,
    });
    const identity = await resolver.resolve(unknown);
    // No signer record: no client, so the cast is drawn without a label. The
    // page is not lost over it.
    expect(identity).toBeUndefined();
    const resolved = await resolver.resolveAll([unknown, unknown]);
    expect(resolved.size).toBe(0);
  });
});

describe('filterCastsByClient (pure view layer)', () => {
  const mine = messageFor('0xself');
  const theirs = messageFor('0xother', 42);
  const unknown = messageFor('0xunknown', 43);
  const mineIdentity = clientIdentityFor({
    signerHex: '0xself',
    signer: {
      source: 'SIGNER_SOURCE_OFFCHAIN',
      key: '0xself',
      keyType: 1,
      fid: TEST_FID,
      requestFid: TEST_FID,
    },
    thisAppFid: TEST_FID,
  })!;
  const theirsIdentity = clientIdentityFor({
    signerHex: '0xother',
    signer: {
      source: 'SIGNER_SOURCE_OFFCHAIN',
      key: '0xother',
      keyType: 1,
      fid: 42,
      requestFid: 7,
    },
    thisAppFid: TEST_FID,
  })!;
  const clients = new Map([
    ['0xself', mineIdentity],
    ['0xother', theirsIdentity],
  ]);

  it('shows everything by default', () => {
    expect(
      filterCastsByClient({
        messages: [mine, theirs, unknown],
        clients,
        policy: defaultClientFilterPolicy,
      }),
    ).toHaveLength(3);
  });

  it('excludes the clients you named', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'exclude', clientIds: ['app:7'] },
    });
    expect(kept.map((message) => message.signer)).toEqual([
      '0xself',
      '0xunknown',
    ]);
  });

  it('shows only the clients you named', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'only', clientIds: ['self'] },
    });
    expect(kept.map((message) => message.signer)).toEqual(['0xself']);
  });

  it('hides unresolved clients only when asked, since hiding is destructive', () => {
    const kept = filterCastsByClient({
      messages: [mine, theirs, unknown],
      clients,
      policy: { mode: 'exclude', clientIds: ['app:7'] },
      unknownClientBehavior: 'hide',
    });
    expect(kept.map((message) => message.signer)).toEqual(['0xself']);
  });

  it('treats an empty client list as "no filtering", never as "hide everything"', () => {
    expect(
      filterCastsByClient({
        messages: [mine, theirs],
        clients,
        policy: { mode: 'only', clientIds: [] },
      }),
    ).toHaveLength(2);
  });
});
