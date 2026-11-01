/**
 * Live **KEY_ADD acceptance** probe against a real Snapchain read node.
 *
 * Skipped unless `SNAPCHAIN_LIVE_WRITE_KEYADD=1`. Unlike the rest of the live
 * write suite, this one sends a message a real read node *accepts* on the wire:
 * a gasless `KEY_ADD` for a foreign FID signed by a custody key that is not that
 * FID's. Validators drop it (the custody signature cannot verify), so nothing
 * merges — but it does put one unusable message into relay once per run, which
 * is why it is off by default and gated separately from the rejection-only
 * suite.
 *
 * What it measures, and why the client is built the way it is:
 *
 *   1. whether the read node validates the custody signature *before* it
 *      answers `200` (it did not, on 2026-10-18), and
 *   2. whether the key ever becomes usable, i.e. whether the node's `200` can be
 *      treated as success (it cannot — the signer record is the confirmation,
 *      which is exactly what `issueAppKey` polls for).
 *
 *   SNAPCHAIN_LIVE_WRITE_KEYADD=1 SNAPCHAIN_LIVE_WRITE_URL=https://your-node \
 *     pnpm --filter farcaster-node-client test src/__tests__/live.keyadd.node.test.ts
 */

import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  buildKeyAddMessage,
  fetchSignerState,
  generateAppKey,
} from '../appKey';
import { SnapchainNodeClient } from '../http';

const liveWriteUrl = process.env.SNAPCHAIN_LIVE_WRITE_URL;
const enabled =
  process.env.SNAPCHAIN_LIVE_WRITE_KEYADD === '1' && !!liveWriteUrl;

/** A FID the probe can never be authorized for. */
const FOREIGN_FID = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)('live node (KEY_ADD acceptance probe)', () => {
  const client = new SnapchainNodeClient({
    baseUrl: liveWriteUrl ?? 'http://127.0.0.1:3381',
    timeoutMs: 30000,
  });

  it('reports whether a 200 on submit means the key is live (it does not)', async () => {
    const stranger = mnemonicToAccount(generateMnemonic(english));
    const appKey = await generateAppKey();
    const before = await fetchSignerState({ node: client, fid: FOREIGN_FID });

    const keyAdd = await buildKeyAddMessage({
      fid: FOREIGN_FID,
      appKey,
      custodyAccount: stranger,
      nonce: before.currentUserNonce + 1,
    });

    // The probe's whole point is to observe the response, so a rejection is a
    // result too — capture it instead of failing.
    let accepted = false;
    let detail = '';
    try {
      const submitted = await client.submitMessage(keyAdd.bytes);
      accepted = true;
      detail = `HTTP 200, hash ${submitted.hash}`;
    } catch (error) {
      detail = `rejected: ${(error as Error).message}`;
    }

    // Give the key every chance to merge: the client's own confirmation budget
    // is ~30s, so poll for double that.
    let live = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(5000);
      const after = await fetchSignerState({
        node: client,
        fid: FOREIGN_FID,
        publicKeyHex: appKey.publicKeyHex,
      });
      if (after.signer) {
        live = true;
        break;
      }
    }

    console.log(
      JSON.stringify(
        {
          fid: FOREIGN_FID,
          appKeyPublicKeyHex: appKey.publicKeyHex,
          readNodeAccepted: accepted,
          detail,
          becameASignerWithin60s: live,
          gaslessSignerCountBefore: before.gaslessSignerCount,
        },
        null,
        2,
      ),
    );

    // The invariant the client depends on: a submit that "succeeds" is not
    // proof the key works — only the signer record is. If a future node starts
    // rejecting this, `accepted` flips to false and the probe still passes;
    // what must never happen is the node accepting it *and* the key going live.
    expect(live).toBe(false);
  }, 120_000);
});
