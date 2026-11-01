/**
 * The node side of creating an account, against a fake node client.
 *
 * Three things matter here, and each is about not claiming more than the node
 * actually said:
 *
 *   1. `readUser` answers "not yet" for a FID with no on-chain signer events,
 *      which is the state a node is in for the first seconds after a
 *      registration;
 *   2. `installSigner` submits the KEY_ADD once, reads the key back out of the
 *      node, and hands the caller the nonce the NEXT message must exceed — the
 *      nonce the device stores so a write after a reload is not signed with a
 *      nonce the node has already seen;
 *   3. a FID whose gasless key bucket is full is refused before anything is
 *      signed, with the sentence the screen shows.
 */

import { appKeyFromPrivateKeyHex } from 'farcaster-node-client';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAccountOps,
  NodeAccountOpsError,
} from '~/snapchain/accounts/nodeAccountOps';
import type { CustodyAccount } from '~/snapchain/accounts/phrase';

const FID = 4242;
const DEVICE_KEY = `0x${'11'.repeat(32)}`;

/** A custody account that really can sign EIP-712 (a throwaway key). */
const custody = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
) as unknown as CustodyAccount;

/** The node, remembering what it was told and reporting it back. */
const fakeNode = ({
  seesFid = true,
  userData = [],
  currentUserNonce = 7,
  gaslessSignerCount = 1,
  gaslessSignerLimit = 1000,
  mergesKeyAdd = true,
  profileValues,
}: {
  seesFid?: boolean;
  userData?: unknown[];
  currentUserNonce?: number;
  gaslessSignerCount?: number;
  gaslessSignerLimit?: number;
  mergesKeyAdd?: boolean;
  /** What the node starts reporting back once a profile write lands. */
  profileValues?: { type: number; value: string }[];
} = {}) => {
  const state = {
    signers: [] as { key: string }[],
    userData: [...userData],
    currentUserNonce,
    order: [] as string[],
    profileWritten: false,
  };

  const signersByFid = vi.fn(async () => {
    state.order.push('signersByFid');
    return {
      signers: state.signers,
      gaslessSignerCount: gaslessSignerCount + state.signers.length,
      gaslessSignerLimit,
      currentUserNonce: state.currentUserNonce,
    };
  });

  const submitMessage = vi.fn(async () => {
    state.order.push('submitMessage');
    state.currentUserNonce += 1;

    if (mergesKeyAdd) {
      state.signers = [
        ...state.signers,
        { key: (await appKeyFromPrivateKeyHex(DEVICE_KEY)).publicKeyHex },
      ];
    }

    // A profile write only shows up in the node's own read once it merged.
    if (profileValues && !state.profileWritten) {
      state.profileWritten = true;
      state.userData = [
        ...state.userData,
        ...profileValues.map((entry) =>
          userDataMessage(entry.type, entry.value),
        ),
      ];
    }

    return { hash: `0x${'ab'.repeat(20)}` };
  });

  const userDataByFid = vi.fn(async () => {
    state.order.push('userDataByFid');
    return { messages: state.userData };
  });

  const onChainSignersByFid = vi.fn(async () => {
    state.order.push('onChainSignersByFid');
    return { events: seesFid ? [{ signerEventBody: {} }] : [] };
  });

  return {
    client: {
      signersByFid,
      submitMessage,
      userDataByFid,
      onChainSignersByFid,
    } as never,
    signersByFid,
    submitMessage,
    userDataByFid,
    onChainSignersByFid,
    state,
  };
};

const userDataMessage = (type: number, value: string) => ({
  data: { userDataBody: { type, value } },
});

describe('what the node knows about a brand-new account', () => {
  it('says "not yet" for a FID the node has no on-chain signer events for', async () => {
    const node = fakeNode({ seesFid: false });
    const ops = createNodeAccountOps({ node: node.client });

    await expect(ops.readUser(FID)).resolves.toBeUndefined();
  });

  it('reports the handle and display name the node is actually showing', async () => {
    const node = fakeNode({
      userData: [
        userDataMessage(6, 'fiddy'),
        userDataMessage(2, 'Fiddy'),
        userDataMessage(3, 'ignore me'),
      ],
    });
    const ops = createNodeAccountOps({ node: node.client });

    await expect(ops.readUser(FID)).resolves.toEqual({
      fid: FID,
      username: 'fiddy',
      displayName: 'Fiddy',
    });
  });

  it('survives a node that refuses to answer about profile fields at all', async () => {
    const node = fakeNode();
    node.userDataByFid.mockRejectedValueOnce(new Error('not a route'));
    const ops = createNodeAccountOps({ node: node.client });

    await expect(ops.readUser(FID)).resolves.toEqual({
      fid: FID,
      username: undefined,
      displayName: undefined,
    });
  });
});

describe('adding this device as a signer', () => {
  it('submits the KEY_ADD once and reads the key back out of the node', async () => {
    const node = fakeNode({ currentUserNonce: 7 });
    const ops = createNodeAccountOps({ node: node.client });

    const installed = await ops.installSigner({
      fid: FID,
      signingKeyHex: DEVICE_KEY,
      custody,
    });

    expect(node.submitMessage).toHaveBeenCalledTimes(1);

    // The key was confirmed from the node, after the message was submitted —
    // never assumed from a 200.
    expect(node.state.order.indexOf('submitMessage')).toBeLessThan(
      node.state.order.lastIndexOf('signersByFid'),
    );

    // The KEY_ADD spent nonce 8; the next message must be greater than it.
    expect(installed.nextNonce).toBe(9);
  });

  it('reports the step rather than the build, so the screen can show progress', async () => {
    const node = fakeNode();
    const steps: string[] = [];
    const ops = createNodeAccountOps({
      node: node.client,
      onStep: (step) => steps.push(step),
    });

    await ops.installSigner({
      fid: FID,
      signingKeyHex: DEVICE_KEY,
      custody,
    });

    expect(steps).toContain('done');
  });

  it('refuses before signing anything when the account holds all the keys it can', async () => {
    const node = fakeNode({
      gaslessSignerCount: 1000,
      gaslessSignerLimit: 1000,
    });
    const ops = createNodeAccountOps({ node: node.client });

    await expect(
      ops.installSigner({ fid: FID, signingKeyHex: DEVICE_KEY, custody }),
    ).rejects.toThrow(/holds as many signing keys as it can/);

    expect(node.submitMessage).not.toHaveBeenCalled();
  });

  it('refuses a key it cannot read rather than signing with something else', async () => {
    const node = fakeNode();
    const ops = createNodeAccountOps({ node: node.client });

    await expect(
      ops.installSigner({ fid: FID, signingKeyHex: 'not-a-key', custody }),
    ).rejects.toBeInstanceOf(NodeAccountOpsError);

    expect(node.submitMessage).not.toHaveBeenCalled();
  });
});

describe('writing the profile', () => {
  it('writes the handle and display name, and reads them back', async () => {
    const node = fakeNode({
      profileValues: [
        { type: 6, value: 'fiddy' },
        { type: 2, value: 'Fiddy' },
      ],
    });
    const ops = createNodeAccountOps({ node: node.client });

    await ops.setProfile({
      fid: FID,
      signingKeyHex: DEVICE_KEY,
      username: 'fiddy',
      displayName: 'Fiddy',
    });

    expect(node.submitMessage).toHaveBeenCalledTimes(2);
    expect(node.userDataByFid).toHaveBeenCalled();
  });

  it('says the profile is not showing rather than pretending it landed', async () => {
    const node = fakeNode();
    const ops = createNodeAccountOps({ node: node.client });

    // The node accepts the message but its user-data read never lists the value.
    await expect(
      ops.setProfile({
        fid: FID,
        signingKeyHex: DEVICE_KEY,
        username: 'fiddy',
      }),
    ).rejects.toThrow(/not showing it yet/);
  });

  it('does nothing at all when there is nothing to write', async () => {
    const node = fakeNode();
    const ops = createNodeAccountOps({ node: node.client });

    await ops.setProfile({ fid: FID, signingKeyHex: DEVICE_KEY });

    expect(node.submitMessage).not.toHaveBeenCalled();
    expect(node.userDataByFid).not.toHaveBeenCalled();
  });
});
