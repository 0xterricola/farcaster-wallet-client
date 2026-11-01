/**
 * The matrix itself, as tests — including the rule the home feed hangs on.
 *
 * `POST /v2/feed-items` is the fork's feed, and the hosted API spells it as a
 * write while the routing table classifies it `node` (it is assembled from the
 * follow graph). Judging it by its HTTP method is what put Farcaster's own
 * public server's write refusal where the home column should be (MEASURED on the
 * live site, task t_f7c34463; reproduced at this seam while landing the fix),
 * and what would have sent it to Neynar's index, which keeps no follow graph.
 *
 * So the matrix is asked here, directly, for both spellings of the same read and
 * for a genuine write — three routes, three servers, and the answer that keeps
 * the routing in `providerFetch.ts` honest.
 */

import { describe, expect, it } from 'vitest';

import {
  capabilitiesOf,
  NEYNAR_READ_PATHS,
  providerCanServe,
  providerPlainName,
} from '~/snapchain/providers/capabilities';
import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
} from '~/snapchain/providers/catalog';

const snapchain = ownNodeProvider('https://mine.example');
const neynar = neynarProvider();
const farcasterPublic = farcasterPublicProvider();

const can = (
  provider: Parameters<typeof providerCanServe>[0]['provider'],
  kind: Parameters<typeof providerCanServe>[0]['kind'],
  path: string,
) => providerCanServe({ provider, kind, path });

describe('providerCanServe: a route the table classifies `node`', () => {
  // The one that spells a read as a write. Its method is POST; its kind is
  // `node`. The kind is what decides.
  const FEED = '/v2/feed-items';
  // A node read the fork spells as a GET, to be sure the rule is about the
  // classification and not about the method in either direction.
  const UNSEEN = '/v2/unseen';
  // A genuine write: the heart.
  const LIKE = '/v2/cast-likes';

  it('is served by a node, whatever HTTP method it is spelled with', () => {
    expect(can(snapchain, 'node', FEED)).toEqual({ can: true });
    expect(can(snapchain, 'node', UNSEEN)).toEqual({ can: true });
  });

  it('is not served by Farcaster’s own public server — it assembles no protocol messages', () => {
    for (const path of [FEED, UNSEEN, '/v2/thread-casts', '/v2/channel']) {
      const decision = can(farcasterPublic, 'node', path);
      expect(decision.can).toBe(false);
      expect(decision.why).toContain(path);
      expect(decision.why).toContain('read from a node');
    }
  });

  it('is served by Neynar only where its index really has the read', () => {
    // The index keeps no follow graph, and answers no feed.
    expect(can(neynar, 'node', FEED).can).toBe(false);
    expect(can(neynar, 'node', FEED).why).toContain(
      'Neynar’s index does not serve',
    );
    expect(can(neynar, 'node', UNSEEN).can).toBe(false);
    // …and it does have these, which is why the default can be Neynar at all.
    for (const path of NEYNAR_READ_PATHS) {
      expect(can(neynar, 'node', path)).toEqual({ can: true });
    }
  });

  it('still judges a real write by what the server can carry, not by its route kind', () => {
    expect(can(snapchain, 'write', LIKE)).toEqual({ can: true });
    expect(can(neynar, 'write', LIKE)).toEqual({ can: true });
    const refusal = can(farcasterPublic, 'write', LIKE);
    expect(refusal.can).toBe(false);
    expect(refusal.why).toContain('read-only');
  });
});

describe('capabilitiesOf: what a picker row says', () => {
  it('separates "answers the reads it documents" from "assembles what only a node has"', () => {
    expect(capabilitiesOf(snapchain).nodeReads).toBe(true);
    expect(capabilitiesOf(neynar).nodeReads).toBe(true);
    // The gap that produced the home column's refusal: reads yes, node reads no.
    expect(capabilitiesOf(farcasterPublic).reads).toBe(true);
    expect(capabilitiesOf(farcasterPublic).nodeReads).toBe(false);
  });

  it('names each server in plain words', () => {
    expect(providerPlainName(farcasterPublic)).toBe(
      "Farcaster's own public server",
    );
    expect(providerPlainName(neynar)).toBe('Neynar');
    expect(providerPlainName(snapchain)).toBe('Your node');
  });
});
