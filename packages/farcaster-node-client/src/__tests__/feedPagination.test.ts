/**
 * The paging loop that a live node makes dangerous.
 *
 * MEASURED (2026-10-20, a public read node): the last page of a paged read
 * comes back with `nextPageToken = "W251bGwsbnVsbF0="` — base64 of
 * `[null,null]` — and asking *with* that token returns the FIRST page again
 * rather than an empty one. Any loop that pages "while a token is present"
 * therefore never ends; on a follow graph the collected list grows until the
 * tab runs out of memory. This test drives exactly that behaviour, so the guard
 * cannot be removed without failing here.
 */

import { describe, expect, it } from 'vitest';

import { fetchFollowing } from '../feed';
import type { SnapchainNodeClient } from '../http';
import type { NodeMessagesPage } from '../types';
import { isTerminalPageToken } from '../wire';

const TERMINAL_TOKEN = 'W251bGwsbnVsbF0=';

const followPage = (targetFids: number[], nextPageToken?: string): NodeMessagesPage => ({
  messages: targetFids.map((targetFid, index) => ({
    hash: `0x${String(index).padStart(40, '0')}`,
    signer: '0x0',
    signature: '',
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    fid: 3,
    timestamp: 1,
    timestampMs: 1609459201000,
    network: 'FARCASTER_NETWORK_MAINNET',
    type: 'MESSAGE_TYPE_LINK_ADD',
    link: { linkType: 'follow', targetFid },
  })),
  ...(nextPageToken ? { nextPageToken } : {}),
});

describe('fetchFollowing paging', () => {
  it('treats the node’s [null,null] token as the end of the results', () => {
    expect(isTerminalPageToken(TERMINAL_TOKEN)).toBe(true);
    expect(isTerminalPageToken(undefined)).toBe(true);
    // A real cursor is base64 of a nested array of numbers.
    expect(isTerminalPageToken('AwAAAAMCCYZEP3Rt32ZT')).toBe(false);
  });

  it('terminates and de-duplicates when the node repeats a page for that token', async () => {
    let calls = 0;
    const node = {
      linksByFid: async ({ pageToken }: { pageToken?: string }) => {
        calls += 1;
        // The measured behaviour: a first page with a cursor, then — for the
        // terminal token — the very same first page again.
        if (calls > 40) {
          throw new Error('fetchFollowing did not stop: the paging loop is unbounded');
        }
        return pageToken === TERMINAL_TOKEN
          ? followPage([3, 4], TERMINAL_TOKEN)
          : followPage([3, 4], 'AAAA');
      },
    } as unknown as SnapchainNodeClient;

    const following = await fetchFollowing({ node, fid: 3, limit: 10 });

    expect(following).toEqual([3, 4]);
    expect(calls).toBeLessThan(5);
  });

  it('stops at the requested limit rather than walking the whole graph', async () => {
    let calls = 0;
    const node = {
      linksByFid: async () => {
        calls += 1;
        return followPage([100 + calls], 'AAAA');
      },
    } as unknown as SnapchainNodeClient;

    const following = await fetchFollowing({ node, fid: 3, limit: 2 });

    expect(following).toHaveLength(2);
    expect(calls).toBe(2);
  });
});