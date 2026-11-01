/**
 * The window's pure parts: what a browse page's sorting, ranking and topics
 * mean, with no node and no React.
 *
 * These are the rules the surface's promises rest on: newest really is newest,
 * "getting attention" is measured from counts the network holds (and a count
 * that was never read is not treated as zero), and a topic is a channel a cast
 * was really posted to.
 */

import { type ApiCast } from 'farcaster-client-data';
import { type NodeMessage } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import {
  castsInTopic,
  channelKeyFromParentUrl,
  engagementOfCast,
  feedTypeForWindow,
  isPublicFeedKey,
  mergeWindowMessages,
  PUBLIC_FEED_KEY,
  rankWindowByEngagement,
  topicsFromCasts,
  windowFromFeedType,
} from '~/snapchain/nodeApi/publicFeedWindow';

const message = ({
  fid,
  hash,
  seconds,
  parentUrl = null,
}: {
  fid: number;
  hash: string;
  seconds: number;
  parentUrl?: string | null;
}): NodeMessage =>
  ({
    hash,
    fid,
    timestamp: seconds,
    timestampMs: seconds * 1000,
    castAdd: { parentUrl, text: 'hi', embeds: [], mentions: [] },
  }) as unknown as NodeMessage;

const cast = ({
  hash,
  timestamp,
  parentUrl = null,
  likes,
  recasts,
}: {
  hash: string;
  timestamp: number;
  parentUrl?: string | null;
  likes?: number;
  recasts?: number;
}): ApiCast =>
  ({
    hash,
    timestamp,
    parentUrl,
    ...(likes === undefined ? {} : { reactions: { count: likes } }),
    ...(recasts === undefined ? {} : { recasts: { count: recasts } }),
  }) as unknown as ApiCast;

describe('the window is newest first, with no duplicates', () => {
  it('sorts by the protocol timestamp, descending', () => {
    const merged = mergeWindowMessages({
      messages: [
        message({ fid: 1, hash: '0xaa', seconds: 100 }),
        message({ fid: 2, hash: '0xbb', seconds: 300 }),
        message({ fid: 3, hash: '0xcc', seconds: 200 }),
      ],
    });

    expect(merged.map((entry) => entry.hash)).toEqual(['0xbb', '0xcc', '0xaa']);
  });

  it('takes one copy of a cast that arrives from two authors', () => {
    const merged = mergeWindowMessages({
      messages: [
        message({ fid: 1, hash: '0xaa', seconds: 100 }),
        message({ fid: 1, hash: '0xaa', seconds: 100 }),
      ],
    });

    expect(merged).toHaveLength(1);
  });

  it('honours olderThan, which is how "show more" walks back', () => {
    const merged = mergeWindowMessages({
      messages: [
        message({ fid: 1, hash: '0xaa', seconds: 100 }),
        message({ fid: 2, hash: '0xbb', seconds: 300 }),
      ],
      olderThan: 200_000,
    });

    expect(merged.map((entry) => entry.hash)).toEqual(['0xaa']);
  });
});

describe('getting attention means counts that were really read', () => {
  it('counts likes and recasts together', () => {
    expect(
      engagementOfCast(
        cast({ hash: '0xa', timestamp: 1, likes: 4, recasts: 3 }),
      ),
    ).toBe(7);
  });

  it('ranks by engagement and breaks ties with the newer cast', () => {
    const ranked = rankWindowByEngagement([
      cast({ hash: '0xlow', timestamp: 500, likes: 0, recasts: 1 }),
      cast({ hash: '0xhigh', timestamp: 100, likes: 9, recasts: 2 }),
      cast({ hash: '0xnewerTie', timestamp: 900, likes: 0, recasts: 1 }),
    ]);

    expect(ranked.map((entry) => entry.hash)).toEqual([
      '0xhigh',
      '0xnewerTie',
      '0xlow',
    ]);
  });

  it('never ranks an unread count as if it were zero', () => {
    const measured = cast({ hash: '0xmeasured', timestamp: 100, likes: 1 });
    const unread = cast({ hash: '0xunread', timestamp: 200 });

    const ranked = rankWindowByEngagement([unread, measured]);

    // The cast whose counts were not read sorts below the one that was
    // measured, even though it is newer: absent is not none.
    expect(ranked.map((entry) => entry.hash)).toEqual([
      '0xmeasured',
      '0xunread',
    ]);
  });
});

describe('a topic is a channel a cast was really posted to', () => {
  it('reads the channel key out of a channel parent URL', () => {
    expect(
      channelKeyFromParentUrl('https://warpcast.com/~/channel/basefriend'),
    ).toBe('basefriend');
    expect(channelKeyFromParentUrl('https://farcaster.xyz/~/channel/dev')).toBe(
      'dev',
    );
  });

  it('says nothing for a reply, or for a parent that is not a channel', () => {
    expect(channelKeyFromParentUrl(null)).toBeNull();
    expect(channelKeyFromParentUrl('')).toBeNull();
    expect(
      channelKeyFromParentUrl('chain://eip155:7777777/erc721:0xabc'),
    ).toBeNull();
  });

  it('offers the channels the window holds, most-used first', () => {
    const topics = topicsFromCasts([
      cast({
        hash: '0xa',
        timestamp: 1,
        parentUrl: 'https://warpcast.com/~/channel/dev',
      }),
      cast({
        hash: '0xb',
        timestamp: 2,
        parentUrl: 'https://warpcast.com/~/channel/dev',
      }),
      cast({
        hash: '0xc',
        timestamp: 3,
        parentUrl: 'https://warpcast.com/~/channel/base',
      }),
      cast({ hash: '0xd', timestamp: 4 }),
    ]);

    expect(topics).toEqual([
      { key: 'dev', count: 2 },
      { key: 'base', count: 1 },
    ]);
  });

  it('narrows a window to one channel', () => {
    const window = [
      cast({
        hash: '0xa',
        timestamp: 1,
        parentUrl: 'https://warpcast.com/~/channel/dev',
      }),
      cast({
        hash: '0xb',
        timestamp: 2,
        parentUrl: 'https://warpcast.com/~/channel/base',
      }),
    ];

    expect(castsInTopic(window, 'dev').map((entry) => entry.hash)).toEqual([
      '0xa',
    ]);
    expect(castsInTopic(window, null)).toHaveLength(2);
  });
});

describe('the feed type the surface asks with', () => {
  it('is the browse key, so one seam answers both routes', () => {
    expect(isPublicFeedKey(PUBLIC_FEED_KEY)).toBe(true);
    expect(isPublicFeedKey('home')).toBe(false);
    expect(isPublicFeedKey(undefined)).toBe(false);
  });

  it('round-trips a window through the one string the feed layer takes', () => {
    expect(feedTypeForWindow({ kind: 'recent' })).toBe('recent');
    expect(feedTypeForWindow({ kind: 'trending' })).toBe('trending');
    expect(feedTypeForWindow({ kind: 'recent', topic: 'dev' })).toBe(
      'topic:dev',
    );

    expect(windowFromFeedType('recent')).toEqual({
      kind: 'recent',
      topic: null,
      limit: 0,
    });
    expect(windowFromFeedType('trending')).toEqual({
      kind: 'trending',
      topic: null,
      limit: 0,
    });
    expect(windowFromFeedType('topic:dev')).toEqual({
      kind: 'recent',
      topic: 'dev',
      limit: 0,
    });
  });

  it('treats an unknown feed type as the newest window rather than failing', () => {
    expect(windowFromFeedType(undefined).kind).toBe('recent');
    expect(windowFromFeedType('default').kind).toBe('recent');
  });
});
