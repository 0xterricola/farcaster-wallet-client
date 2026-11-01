/**
 * Live **write-path** smoke test against a real Snapchain read node.
 *
 * Skipped unless `SNAPCHAIN_LIVE_WRITE_URL` is set, so the suite stays hermetic
 * by default and a read-only run (`SNAPCHAIN_LIVE_URL`) never submits:
 *
 *   SNAPCHAIN_LIVE_WRITE_URL=https://your-read-node.example \
 *     pnpm --filter farcaster-node-client test
 *
 * Every message this file sends is *designed to be rejected*: a cast, reaction,
 * follow and profile edit signed by a key the FID never added. A rejected
 * message is never gossiped, so the test cannot put anything on mainnet — but
 * it does prove the client's write path reaches the node's **real validation**
 * (content type, protobuf decode, blake3 hash over `dataBytes`, Ed25519 envelope
 * signature) instead of failing at the wire.
 *
 * The one message a real read node does *accept* — a gasless `KEY_ADD` whose
 * custody signature is wrong — is measured separately in
 * `live.keyadd.node.test.ts`, because it is an acceptance probe, not a
 * rejection test.
 *
 * That distinction is the whole point: a wire mistake produces a *different*
 * error than an authorization mistake. The last test submits a JSON body to
 * show what a wire mistake looks like, so the earlier assertions cannot pass
 * vacuously.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import { NodeApiError } from '../errors';
import { SnapchainNodeClient } from '../http';
import {
  buildCastAddMessage,
  buildLinkAddMessage,
  buildReactionAddMessage,
  buildUserDataAddMessage,
} from '../messages';

const liveWriteUrl = process.env.SNAPCHAIN_LIVE_WRITE_URL;

/** FID 2 is a long-lived account with public activity; we can never write to it. */
const FOREIGN_FID = 2;

/** Errors that mean "the node understood the message and refused it". */
const AUTHORIZATION_FAILURE =
  /signer|signature|custody|unauthorized|not\s+found|invalid/i;

/** Errors that mean "the node could not even read what we sent". */
const WIRE_FAILURE =
  /content[- ]?type|unsupported media|decod|protobuf|malformed|invalid json|expected value|parse/i;

describe.skipIf(!liveWriteUrl)(
  'live node (write path, rejections only)',
  () => {
    const client = new SnapchainNodeClient({
      baseUrl: liveWriteUrl ?? 'http://127.0.0.1:3381',
      timeoutMs: 30000,
    });

    /** Capture the node's rejection of a single message. */
    const rejection = async (bytes: Uint8Array) => {
      try {
        await client.submitMessage(bytes);
      } catch (error) {
        return error;
      }
      throw new Error('The node accepted a message it should have refused');
    };

    /**
     * The node's own words for each rejection, printed at the end of a live run so
     * a session leaves pasteable evidence instead of just a green tick.
     */
    const observed: Array<Record<string, unknown>> = [];
    const record = (what: string, error: unknown) => {
      const apiError = error as NodeApiError;
      observed.push({
        what,
        status: apiError.status,
        nodeError: apiError.nodeError,
        nodeErrorDetail: apiError.nodeErrorDetail,
      });
    };
    afterAll(() => {
      console.log(
        `observedNodeRejections=${JSON.stringify(observed, null, 2)}`,
      );
    });

    it('refuses a cast signed by a key the FID never added', async () => {
      const stranger = await generateAppKey();
      const cast = await buildCastAddMessage({
        fid: FOREIGN_FID,
        signerPrivateKey: stranger.privateKey,
        text: 'fiddy live write probe — this must be rejected',
      });

      const error = await rejection(cast.bytes);
      expect(error).toBeInstanceOf(NodeApiError);
      const message = (error as Error).message;
      record('MESSAGE_TYPE_CAST_ADD (unknown signer)', error);
      expect(message).not.toMatch(WIRE_FAILURE);
      expect(message).toMatch(AUTHORIZATION_FAILURE);
    });

    it('parses and refuses reactions, follows and profile edits the same way', async () => {
      const stranger = await generateAppKey();
      const messages = await Promise.all([
        buildReactionAddMessage({
          fid: FOREIGN_FID,
          signerPrivateKey: stranger.privateKey,
          reactionType: 'like',
          targetCastId: {
            fid: FOREIGN_FID,
            hash: '0x0000000000000000000000000000000000000001',
          },
        }),
        buildLinkAddMessage({
          fid: FOREIGN_FID,
          signerPrivateKey: stranger.privateKey,
          targetFid: 3,
        }),
        buildUserDataAddMessage({
          fid: FOREIGN_FID,
          signerPrivateKey: stranger.privateKey,
          userDataType: 'bio',
          value: 'fiddy live write probe',
        }),
      ]);

      const kinds = [
        'MESSAGE_TYPE_REACTION_ADD (unknown signer)',
        'MESSAGE_TYPE_LINK_ADD / follow (unknown signer)',
        'MESSAGE_TYPE_USER_DATA_ADD (unknown signer)',
      ];
      for (const [index, message] of messages.entries()) {
        const error = await rejection(message.bytes);
        const text = (error as Error).message;
        record(kinds[index] ?? `message ${index}`, error);
        expect(text).not.toMatch(WIRE_FAILURE);
        expect(text).toMatch(AUTHORIZATION_FAILURE);
      }
    });

    it('a JSON body fails differently, so the assertions above are not vacuous', async () => {
      // Deliberately wrong wire format: the node rejects the *request* before it
      // ever looks at a signature. This is why the client speaks protobuf
      // (`docs/NODE-CLIENT.md` §1), and it is the contrast that gives the three
      // tests above their meaning.
      const response = await fetch(new URL('/v1/submitMessage', liveWriteUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'not protobuf' }),
      });
      expect(response.ok).toBe(false);
      const body = await response.text();
      expect(body).toMatch(WIRE_FAILURE);
    });
  },
);
