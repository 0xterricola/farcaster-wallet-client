/**
 * The node side of creating an account, using the client that already talks to
 * a Snapchain node.
 *
 * Three things happen here, and each is confirmed by reading the node back
 * rather than by trusting a 200:
 *
 *   1. `readUser`      — has the node seen this FID at all? MEASURED on the node
 *                        this build reads from (2026-10-21): a registered FID
 *                        answers `/v1/onChainSignersByFid` with its on-chain
 *                        signer events (fid 3 and fid 4242 both do), while an
 *                        unregistered one answers `events: []` — so an empty
 *                        list is the honest "not yet".
 *   2. `installSigner` — a gasless KEY_ADD, signed with the account's own
 *                        custody key. Nothing is bought and no transaction is
 *                        sent; this is the same path the Advanced screen uses.
 *                        It reads the key back out of `/v1/signersByFid` before
 *                        it resolves, and hands the caller the nonce the next
 *                        message for this FID must exceed — the device stores
 *                        both, which is what makes the account writable after a
 *                        reload rather than only until the tab closes.
 *   3. `setProfile`    — @name and display name, written with the key from
 *                        step 2 and then read back out of `/v1/userDataByFid`.
 *
 * A KEY_ADD for an FID the node has not indexed is the classic silent failure
 * (the node can answer `valid: true` and still refuse it at merge), which is why
 * `installSigner` refuses to run before `readUser` says the FID is there.
 */

import {
  appKeyFromPrivateKeyHex,
  buildUserDataAddMessage,
  fetchSignerState,
  hexToBytes,
  issueAppKey,
  type IssueAppKeyStep,
  type SnapchainNodeClient,
} from 'farcaster-node-client';

import type { AccountNodePort } from './createAccount';

/** The user-data field numbers, as the node reports them. */
const USER_DATA_TYPE_USERNAME = 6;
const USER_DATA_TYPE_DISPLAY = 2;

/** The FID, plus whatever the node knows about it. */
export interface NodeAccountIdentity {
  fid: number;
  username?: string;
  displayName?: string;
}

export class NodeAccountOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeAccountOpsError';
  }
}

export const createNodeAccountOps = ({
  node,
  onStep,
}: {
  node: SnapchainNodeClient;
  onStep?: (step: IssueAppKeyStep) => void;
}): AccountNodePort => ({
  readUser: async (fid: number) => {
    const [onChain, userData] = await Promise.all([
      node.onChainSignersByFid({ fid, pageSize: 1 }),
      node
        .userDataByFid({ fid, pageSize: 100 })
        .catch(() => ({ messages: [] })),
    ]);

    if (onChain.events.length === 0) {
      return undefined;
    }

    let username: string | undefined;
    let displayName: string | undefined;

    for (const message of userData.messages as {
      data?: { userDataBody?: { type?: number | string; value?: string } };
    }[]) {
      const body = message.data?.userDataBody;

      if (body?.value === undefined) {
        continue;
      }

      const type =
        typeof body.type === 'number'
          ? body.type
          : Number(String(body.type).replace(/\D+/g, ''));

      if (type === USER_DATA_TYPE_USERNAME) {
        username = body.value;
      }

      if (type === USER_DATA_TYPE_DISPLAY) {
        displayName = body.value;
      }
    }

    return { fid, username, displayName };
  },

  installSigner: async ({ fid, signingKeyHex, custody }) => {
    const appKey = await appKeyFromHex(signingKeyHex);
    const state = await fetchSignerState({ node, fid });

    if (state.quotaExhausted) {
      throw new NodeAccountOpsError(
        'this account already holds as many signing keys as it can - revoke one on the Advanced screen first',
      );
    }

    const issued = await issueAppKey({
      node,
      fid,
      appKey,
      custodyAccount: custody as never,
      nonce: state.currentUserNonce + 1,
      ...(onStep ? { onStep } : {}),
    });

    // `issueAppKey` waits for the key to appear, so this read is confirmation of
    // a fact rather than a second wait — but it is what the doc claims, so it
    // happens here as well as inside the client: the step is only "done" once
    // the node itself lists this key on this FID.
    const confirmed = await fetchSignerState({
      node,
      fid,
      publicKeyHex: appKey.publicKeyHex,
    });

    if (!confirmed.signer) {
      throw new NodeAccountOpsError(
        'the server Fiddy reads from accepted the posting key but is not showing it yet - try the last step again in a minute',
      );
    }

    // The next message for this FID must carry a nonce strictly greater than the
    // one the node reports, so take the higher of "what we used" and "what the
    // node now says" — a stale read must not hand back a nonce that was spent.
    return {
      nextNonce: Math.max(issued.userId.nonce, confirmed.currentUserNonce) + 1,
    };
  },

  setProfile: async ({ fid, signingKeyHex, username, displayName }) => {
    const signerPrivateKey = hexToBytes(signingKeyHex);

    const wanted: { userDataType: 'username' | 'display'; value: string }[] =
      [];

    if (username) {
      wanted.push({ userDataType: 'username', value: username });
    }

    if (displayName) {
      wanted.push({ userDataType: 'display', value: displayName });
    }

    for (const field of wanted) {
      const built = await buildUserDataAddMessage({
        fid,
        signerPrivateKey,
        userDataType: field.userDataType,
        value: field.value,
      });

      try {
        await node.submitMessage(built.bytes);
      } catch (error) {
        throw new NodeAccountOpsError(
          error instanceof Error && error.message
            ? error.message
            : 'the server Fiddy reads from refused the profile update',
        );
      }
    }

    if (wanted.length === 0) {
      return;
    }

    // Read it back: the profile field is only "written" once the node shows it.
    const readBack = await node
      .userDataByFid({ fid, pageSize: 100 })
      .catch(() => ({ messages: [] }));

    const values = new Set(
      (
        readBack.messages as {
          data?: { userDataBody?: { value?: string } };
        }[]
      ).map((message) => message.data?.userDataBody?.value),
    );

    const missing = wanted.filter((field) => !values.has(field.value));

    if (missing.length > 0) {
      throw new NodeAccountOpsError(
        'the server Fiddy reads from accepted the profile update but is not showing it yet',
      );
    }
  },
});

/** A 32-byte app key from its stored hex, or a sentence explaining why not. */
const appKeyFromHex = async (signingKeyHex: string) => {
  try {
    return await appKeyFromPrivateKeyHex(signingKeyHex);
  } catch {
    throw new NodeAccountOpsError(
      "this device's signing key is stored in a shape that cannot be read - issue a new one on the Advanced screen",
    );
  }
};

export type { IssueAppKeyStep };
