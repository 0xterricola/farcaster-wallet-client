// @vitest-environment jsdom

/**
 * A count that has not been read is NOT drawn — and when it arrives it is.
 *
 * `ApiCast`'s `reactions` / `recasts` are optional because a node-backed feed
 * paints before its counts are read (a cold first cast used to wait ~5.5 s for
 * the slowest count on the page; see `~/snapchain/nodeApi/reads`
 * `readCastCounts`). Two consequences this file pins, on the component that
 * actually draws them:
 *
 *   - an unread count renders NOTHING. Not "0": a zero nobody counted is a
 *     claim the reader would believe.
 *   - the count appearing later re-renders the same cast — a new prop, not a
 *     new mount — so the number lands under a page that is already on screen.
 *
 * The `data-fiddy-count` markers the counts carry are also the hook the live
 * probe uses to ask "is the like count on screen yet?"
 * (`scripts/measure-first-cast.mjs`), so they are asserted here too.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { ApiCast } from 'farcaster-client-data';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { CastDetails } from '~/components/casts/CastDetails';

const cast = (overrides: Partial<ApiCast> = {}): ApiCast =>
  ({
    hash: '0x8ae98f90bfb0daa36f4364f3e2c2fee0dc8c2225',
    threadHash: '0x8ae98f90bfb0daa36f4364f3e2c2fee0dc8c2225',
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'dwr',
      followerCount: 0,
      followingCount: 0,
    },
    text: 'a cast',
    timestamp: 1_700_000_000_000,
    replies: { count: 0 },
    watches: { count: 0 },
    ...overrides,
  }) as ApiCast;

const draw = ({
  cast: drawn,
  isFocused,
}: {
  cast: ApiCast;
  isFocused: boolean;
}) =>
  render(
    <MemoryRouter>
      <CastDetails cast={drawn} isFocused={isFocused} />
    </MemoryRouter>,
  );

const markerValues = (kind: string) =>
  Array.from(document.querySelectorAll(`[data-fiddy-count="${kind}"]`)).map(
    (node) => node.textContent,
  );

afterEach(cleanup);

describe('an unread count is not drawn', () => {
  it('draws nothing at all for counts that have not been read', () => {
    draw({ cast: cast(), isFocused: false });

    expect(markerValues('likes')).toEqual([]);
    expect(markerValues('recasts')).toEqual([]);
    expect(screen.queryByText('likes')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('draws the recast count as unread too (it is rendered, not dropped)', () => {
    draw({ cast: cast(), isFocused: true });

    expect(markerValues('recasts')).toEqual([]);
    expect(screen.queryByText('recasts')).toBeNull();
  });
});

describe('a count that arrives behind the paint appears', () => {
  it('draws likes and recasts once they are read', () => {
    draw({
      cast: cast({ reactions: { count: 186 }, recasts: { count: 12 } }),
      isFocused: false,
    });

    expect(markerValues('likes')).toEqual(['186']);
    expect(screen.getByText('likes')).toBeTruthy();
  });

  it('re-renders the same cast when the count lands, without a remount', () => {
    const unread = cast();
    const { rerender } = draw({ cast: unread, isFocused: false });
    expect(markerValues('likes')).toEqual([]);

    // The counts pass hands the same cast back with its counts filled — this is
    // what the merge into the global cast cache produces.
    rerender(
      <MemoryRouter>
        <CastDetails
          cast={{
            ...unread,
            reactions: { count: 186 },
            recasts: { count: 12 },
          }}
          isFocused={false}
        />
      </MemoryRouter>,
    );

    expect(markerValues('likes')).toEqual(['186']);
    expect(screen.getByText('likes')).toBeTruthy();
  });

  it('draws a read zero as nothing, exactly as before this change', () => {
    // `0` and "not read" look the same on screen — which is why the number may
    // never be invented, and why no surface could tell them apart anyway.
    draw({
      cast: cast({ reactions: { count: 0 }, recasts: { count: 0 } }),
      isFocused: false,
    });

    expect(markerValues('likes')).toEqual([]);
    expect(screen.queryByText('0')).toBeNull();
  });
});
