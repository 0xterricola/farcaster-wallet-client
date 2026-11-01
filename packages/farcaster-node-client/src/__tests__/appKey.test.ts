/**
 * Gasless app keys, end to end against a node that verifies signatures for real.
 *
 * The point of these tests is that KEY_ADD is *not* taken on trust: the fake
 * node recovers the custody address from the EIP-712 `KeyAdd` signature with
 * viem (a different library from the one that produced it), verifies the
 * `SignedKeyRequest` metadata with `@farcaster/core`'s own verifier, enforces
 * the nonce/scope/TTL rules, and only then lets the key author messages.
 */

import {
  GASLESS_KEY_ADD_EIP_712_TYPES,
  MAX_GASLESS_KEYS_PER_FID,
  MAX_KEY_TTL_SECONDS,
} from '@farcaster/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEY_ADD_EIP712 } from '../../test/fakeSnapchainNode';
import {
  appKeyFromPrivateKeyHex,
  buildKeyAddMessage,
  fetchSignerState,
  generateAppKey,
  issueAppKey,
  revokeAppKey,
} from '../appKey';
import { MessageBuildError, NodeApiError } from '../errors';
import { SnapchainNodeClient } from '../http';
import { buildCastAddMessage, DEFAULT_APP_KEY_SCOPES } from '../messages';
import { bytesToHex } from '../wire';
import {
  fixedRandomBytes,
  otherCustodyAccount,
  startTestNode,
  TEST_FID,
  type TestNode,
} from './fixtures';

let node: TestNode;
let client: SnapchainNodeClient;

beforeEach(async () => {
  node = await startTestNode();
  client = new SnapchainNodeClient({ baseUrl: node.url });
});

afterEach(async () => {
  await node.close();
});

describe('the EIP-712 payload the gasless authorization signs', () => {
  it('matches the domain and type table @farcaster/core exports', () => {
    expect(KEY_ADD_EIP712.domain).toEqual(GASLESS_KEY_ADD_EIP_712_TYPES.domain);
    expect(KEY_ADD_EIP712.types.KeyAdd).toEqual(
      GASLESS_KEY_ADD_EIP_712_TYPES.types
        .KeyAdd as typeof KEY_ADD_EIP712.types.KeyAdd,
    );
  });
});

describe('app key material', () => {
  it('derives a 32-byte public key from 32 bytes of secret', async () => {
    const key = await generateAppKey(fixedRandomBytes(1));
    expect(key.privateKey).toHaveLength(32);
    expect(key.publicKey).toHaveLength(32);
    expect(key.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('round-trips a stored private key to the same public key', async () => {
    const first = await generateAppKey(fixedRandomBytes(2));
    const second = await appKeyFromPrivateKeyHex(bytesToHex(first.privateKey));
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
  });

  it('refuses a private key that is not 32 bytes', async () => {
    await expect(appKeyFromPrivateKeyHex('0x1234')).rejects.toThrow(
      MessageBuildError,
    );
  });
});

describe('gasless KEY_ADD', () => {
  it('issues a key the node accepts, then posts a cast with it', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(3));
    const steps: string[] = [];

    const result = await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual([
      'reading-nonce',
      'building',
      'submitting',
      'confirming',
      'done',
    ]);
    expect(result.signer.key).toBe(appKey.publicKeyHex);
    expect(result.signer.source).toBe('SIGNER_SOURCE_OFFCHAIN');
    expect(result.signer.requestFid).toBe(TEST_FID);
    expect(result.signer.ttl).toBe(MAX_KEY_TTL_SECONDS);
    expect(result.signer.scopes).toEqual([
      'MESSAGE_TYPE_CAST_ADD',
      'MESSAGE_TYPE_CAST_REMOVE',
      'MESSAGE_TYPE_REACTION_ADD',
      'MESSAGE_TYPE_REACTION_REMOVE',
      'MESSAGE_TYPE_LINK_ADD',
      'MESSAGE_TYPE_LINK_REMOVE',
      'MESSAGE_TYPE_USER_DATA_ADD',
    ]);
    expect(result.userId.nonce).toBe(1);
    expect(DEFAULT_APP_KEY_SCOPES).toHaveLength(7);

    // The KEY_ADD went over the wire as protobuf.
    expect(node.requestsFor('/v1/submitMessage')[0]?.contentType).toBe(
      'application/octet-stream',
    );

    // The whole point: the key now writes through the same node.
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'gasless key works',
    });
    const accepted = await client.submitMessage(built.bytes);
    expect(accepted.hash).toBe(built.hash);
    expect(
      (await client.castsByFid({ fid: TEST_FID })).messages[0]!.castAdd?.text,
    ).toBe('gasless key works');
  });

  it('never uses the custody address to sign client messages', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(4));
    await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
    });

    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'app key only',
    });
    const signer = bytesToHex(built.message.signer);
    expect(signer).toBe(appKey.publicKeyHex);
    expect(signer).not.toBe(node.account.address.toLowerCase());
  });

  it('advances the FID user nonce, and takes the next nonce for the next key', async () => {
    const first = await generateAppKey(fixedRandomBytes(5));
    const second = await generateAppKey(fixedRandomBytes(6));

    const firstResult = await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey: first,
      custodyAccount: node.account,
    });
    expect(firstResult.userId.nonce).toBe(1);

    const state = await fetchSignerState({ node: client, fid: TEST_FID });
    expect(state.currentUserNonce).toBe(1);
    expect(state.gaslessSignerCount).toBe(1);

    const secondResult = await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey: second,
      custodyAccount: node.account,
    });
    expect(secondResult.userId.nonce).toBe(2);

    const both = await fetchSignerState({ node: client, fid: TEST_FID });
    expect(both.signers.map((signer) => signer.key)).toEqual([
      first.publicKeyHex,
      second.publicKeyHex,
    ]);
  });

  it('starts from the nonce the node already reports (existing gasless activity)', async () => {
    const prior = await generateAppKey(fixedRandomBytes(7));
    node.setUserNonce(TEST_FID, 12);
    node.addSigner({
      key: prior.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_OFFCHAIN',
      requestFid: TEST_FID,
      nonce: 12,
    });

    const appKey = await generateAppKey(fixedRandomBytes(8));
    const result = await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
    });
    expect(result.userId.nonce).toBe(13);
  });

  it('rejects a replayed nonce, with the node\u2019s own reason', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(9));
    node.setUserNonce(TEST_FID, 7);

    const built = await buildKeyAddMessage({
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
      nonce: 7, // must be strictly greater than 7
    });

    await expect(client.submitMessage(built.bytes)).rejects.toMatchObject({
      name: 'NodeApiError',
      status: 400,
      nodeError: 'Invalid nonce',
    });
    expect(node.signerRecords(TEST_FID)).toHaveLength(0);
  });

  it('rejects an authorization signed by an address that is not the custody address', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(10));
    const built = await buildKeyAddMessage({
      fid: TEST_FID,
      appKey,
      custodyAccount: otherCustodyAccount(),
      nonce: 1,
    });

    await expect(client.submitMessage(built.bytes)).rejects.toThrowError(
      NodeApiError,
    );
    try {
      await client.submitMessage(built.bytes);
    } catch (error) {
      expect((error as NodeApiError).nodeError).toBe(
        'Invalid custody signature',
      );
    }
    expect(node.signerRecords(TEST_FID)).toHaveLength(0);
  });

  it('refuses to build a TTL beyond the protocol maximum, or an inadmissible scope', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(11));

    await expect(
      buildKeyAddMessage({
        fid: TEST_FID,
        appKey,
        custodyAccount: node.account,
        nonce: 1,
        ttlSeconds: MAX_KEY_TTL_SECONDS + 1,
      }),
    ).rejects.toThrow(new RegExp(`capped at ${MAX_KEY_TTL_SECONDS} seconds`));

    await expect(
      buildKeyAddMessage({
        fid: TEST_FID,
        appKey,
        custodyAccount: node.account,
        nonce: 1,
        scopes: [99 as never],
      }),
    ).rejects.toThrow(/not admissible/);

    await expect(
      buildKeyAddMessage({
        fid: TEST_FID,
        appKey,
        custodyAccount: node.account,
        nonce: 1,
        scopes: [],
      }),
    ).rejects.toThrow(/at least one scope/);
  });

  it('stops when the FID has run out of gasless key slots', async () => {
    for (let i = 0; i < MAX_GASLESS_KEYS_PER_FID; i += 1) {
      node.addSigner({
        key: `0x${i.toString(16).padStart(64, '0')}`,
        fid: TEST_FID,
        source: 'SIGNER_SOURCE_OFFCHAIN',
        requestFid: TEST_FID,
      });
    }

    const appKey = await generateAppKey(fixedRandomBytes(12));
    await expect(
      issueAppKey({
        node: client,
        fid: TEST_FID,
        appKey,
        custodyAccount: node.account,
      }),
    ).rejects.toThrow(/1000\/1000 gasless keys/);
  });

  it('reports an unmerged KEY_ADD instead of claiming success', async () => {
    // A node that accepts the message (200) but never merges the key: exactly
    // the state the tutorial warns about, since a read node only relays.
    const relayOnlyNode = await startTestNode({ dropKeyAdds: true });
    try {
      const relayClient = new SnapchainNodeClient({
        baseUrl: relayOnlyNode.url,
      });
      const appKey = await generateAppKey(fixedRandomBytes(13));
      await expect(
        issueAppKey({
          node: relayClient,
          fid: TEST_FID,
          appKey,
          custodyAccount: relayOnlyNode.account,
          confirmAttempts: 2,
          confirmIntervalMs: 1,
        }),
      ).rejects.toThrow(/has not merged it/);
    } finally {
      await relayOnlyNode.close();
    }
  });
});

describe('revoking the app key', () => {
  it('self-revokes: the key removes itself and stops working', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(14));
    await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
    });

    const before = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'before revoke',
    });
    await expect(client.submitMessage(before.bytes)).resolves.toBeTruthy();

    const removal = await revokeAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      nonce: 1,
    });
    expect(removal.keyRemove?.signatureType).toBe(2);
    expect(removal.keyRemove?.key).toBe(appKey.publicKeyHex.toLowerCase());
    expect(node.signerRecords(TEST_FID)).toHaveLength(0);

    const after = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'after revoke',
    });
    await expect(client.submitMessage(after.bytes)).rejects.toMatchObject({
      nodeError: 'Invalid signer',
    });
  });

  it('does not need the custody key to revoke', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(15));
    await issueAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      custodyAccount: node.account,
    });
    // No custodyAccount passed here at all.
    const removal = await revokeAppKey({
      node: client,
      fid: TEST_FID,
      appKey,
      nonce: 1,
    });
    expect(removal.hash).toBeTruthy();
  });
});
