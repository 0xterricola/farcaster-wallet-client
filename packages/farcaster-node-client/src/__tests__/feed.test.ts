/**
 * Feeds assembled locally from node reads: the follow graph, each followee's
 * casts, and the merge. These tests check the merge order, de-duplication, the
 * cap, and that one failing author cannot blank the whole feed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import {
  fetchCastsByFid,
  fetchFollowing,
  fetchFollowingFeed,
  fetchReplies,
  mapWithConcurrency,
} from '../feed';
import { SnapchainNodeClient } from '../http';
import { buildCastAddMessage, buildLinkAddMessage } from '../messages';
import {
  fixedRandomBytes,
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

const seedFollow = async (
  viewerFid: number,
  targetFid: number,
  timestamp: number,
) => {
  const appKey = await generateAppKey(fixedRandomBytes(viewerFid % 250));
  node.store(
    (
      await buildLinkAddMessage({
        fid: viewerFid,
        signerPrivateKey: appKey.privateKey,
        targetFid,
        timestamp,
      })
    ).message,
  );
};

const seedCast = async (options: {
  fid: number;
  text: string;
  timestamp: number;
  parentCastId?: { fid: number; hash: string };
}) => {
  const appKey = await generateAppKey(fixedRandomBytes(options.fid % 250));
  node.store(
    (
      await buildCastAddMessage({
        fid: options.fid,
        signerPrivateKey: appKey.privateKey,
        text: options.text,
        timestamp: options.timestamp,
        ...(options.parentCastId ? { parentCastId: options.parentCastId } : {}),
      })
    ).message,
  );
};

describe('the follow graph', () => {
  it('reads who a FID follows, straight from the node', async () => {
    await seedFollow(TEST_FID, 3, 12_000_001);
    await seedFollow(TEST_FID, 4, 12_000_002);
    await seedFollow(TEST_FID, 5, 12_000_003);
    // A block link must not be mistaken for a follow.
    const appKey = await generateAppKey(fixedRandomBytes(30));
    node.store(
      (
        await buildLinkAddMessage({
          fid: TEST_FID,
          signerPrivateKey: appKey.privateKey,
          targetFid: 99,
          linkType: 'block',
          timestamp: 12_000_004,
        })
      ).message,
    );

    const following = await fetchFollowing({ node: client, fid: TEST_FID });
    expect(following.sort()).toEqual([3, 4, 5]);
  });

  it('de-duplicates and caps the follow list', async () => {
    await seedFollow(TEST_FID, 3, 12_000_001);
    await seedFollow(TEST_FID, 3, 12_000_002);
    await seedFollow(TEST_FID, 4, 12_000_003);

    const following = await fetchFollowing({ node: client, fid: TEST_FID });
    expect(following).toHaveLength(2);

    const capped = await fetchFollowing({
      node: client,
      fid: TEST_FID,
      limit: 1,
    });
    expect(capped).toHaveLength(1);
  });
});

describe('the home feed', () => {
  it('merges followees\u2019 casts newest first, de-duplicated', async () => {
    await seedFollow(TEST_FID, 3, 12_000_001);
    await seedFollow(TEST_FID, 4, 12_000_002);
    await seedCast({ fid: 3, text: 'three oldest', timestamp: 12_000_010 });
    await seedCast({ fid: 4, text: 'four middle', timestamp: 12_000_020 });
    await seedCast({ fid: TEST_FID, text: 'me newest', timestamp: 12_000_030 });

    const feed = await fetchFollowingFeed({ node: client, fid: TEST_FID });
    expect(feed.map((message) => message.castAdd?.text)).toEqual([
      'me newest',
      'four middle',
      'three oldest',
    ]);
    // Nothing is duplicated even though the follow page can repeat fids.
    const keys = feed.map((message) => `${message.fid}:${message.hash}`);
    expect(new Set(keys).size).toBe(feed.length);
  });

  it('can exclude your own casts', async () => {
    await seedFollow(TEST_FID, 3, 12_000_001);
    await seedCast({ fid: 3, text: 'theirs', timestamp: 12_000_010 });
    await seedCast({ fid: TEST_FID, text: 'mine', timestamp: 12_000_020 });

    const feed = await fetchFollowingFeed({
      node: client,
      fid: TEST_FID,
      includeSelf: false,
    });
    expect(feed.map((message) => message.castAdd?.text)).toEqual(['theirs']);
  });

  it('respects the cap and reports the follow graph it read', async () => {
    for (const fid of [3, 4, 5]) {
      await seedFollow(TEST_FID, fid, 12_000_000 + fid);
      await seedCast({
        fid,
        text: `cast from ${fid}`,
        timestamp: 12_000_000 + fid * 10,
      });
    }

    const seen: number[][] = [];
    const feed = await fetchFollowingFeed({
      node: client,
      fid: TEST_FID,
      limit: 2,
      onFollowing: (following) => seen.push(following),
    });
    expect(feed).toHaveLength(2);
    expect(seen[0]?.sort()).toEqual([3, 4, 5]);
  });

  it('does not blank the feed when one author has nothing (or errors)', async () => {
    await seedFollow(TEST_FID, 3, 12_000_001);
    await seedFollow(TEST_FID, 999_999, 12_000_002); // no casts, unknown fid
    await seedCast({ fid: 3, text: 'still here', timestamp: 12_000_010 });

    const feed = await fetchFollowingFeed({ node: client, fid: TEST_FID });
    expect(feed.map((message) => message.castAdd?.text)).toEqual([
      'still here',
    ]);
  });

  it('reads one FID\u2019s casts on their own, newest first', async () => {
    await seedCast({ fid: 7, text: 'older', timestamp: 12_000_001 });
    await seedCast({ fid: 7, text: 'newer', timestamp: 12_000_002 });

    const casts = await fetchCastsByFid({ node: client, fid: 7 });
    expect(casts.map((message) => message.castAdd?.text)).toEqual([
      'newer',
      'older',
    ]);
  });
});

describe('threads', () => {
  it('reads replies to a cast in chronological order', async () => {
    const parent = { fid: 2, hash: `0x${'aa'.repeat(20)}` };
    await seedCast({
      fid: 3,
      text: 'first reply',
      timestamp: 12_000_010,
      parentCastId: parent,
    });
    await seedCast({
      fid: 4,
      text: 'second reply',
      timestamp: 12_000_020,
      parentCastId: parent,
    });
    await seedCast({ fid: 5, text: 'unrelated', timestamp: 12_000_030 });

    const replies = await fetchReplies({ node: client, parentCastId: parent });
    expect(replies.map((message) => message.castAdd?.text)).toEqual([
      'first reply',
      'second reply',
    ]);
  });

  it('reads a channel by url', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(31));
    node.store(
      (
        await buildCastAddMessage({
          fid: 6,
          signerPrivateKey: appKey.privateKey,
          text: 'channel post',
          timestamp: 12_000_040,
          parentUrl: 'https://farcaster.xyz/~/channel/fiddy',
        })
      ).message,
    );
    const casts = await fetchReplies({
      node: client,
      parentUrl: 'https://farcaster.xyz/~/channel/fiddy',
    });
    expect(casts.map((message) => message.castAdd?.text)).toEqual([
      'channel post',
    ]);
  });
});

describe('bounded fan-out', () => {
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (value) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return value * 2;
      },
    );
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps result order aligned with input order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value / 5));
      return value;
    });
    expect(results).toEqual([30, 10, 20]);
  });
});
