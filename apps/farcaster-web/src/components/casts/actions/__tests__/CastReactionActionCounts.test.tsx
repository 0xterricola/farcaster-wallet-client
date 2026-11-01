// @vitest-environment jsdom

/**
 * An unread engagement count draws NO number on the action bar.
 *
 * The action bar is the other half of the counts-behind-the-paint change (card
 * t_0d0e9330): a node-backed feed paints before its per-cast counts are read, so
 * for a moment every cast on screen has no count. The bar used to be handed
 * `cast.reactions?.count ?? 0` and drew a literal "0" — a number nobody read,
 * on every cast, which is exactly what the card forbids. `count` is now
 * `number | undefined`, and `undefined` means "not read yet".
 *
 * On a live release (measured 2026-10-23, cold sign-in, 390px) the feed painted
 * at 11.2 s and showed `0 0 0` on every cast's action row, and the same at 30 s:
 * those zeros were this. `CastDetails` had already been made honest for its own
 * counts; the chain that renders the action bar had not.
 */

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { CastReactionAction } from '~/components/casts/actions/CastReactionAction';

const draw = ({
  count,
  countMarker,
}: {
  count?: number;
  countMarker?: 'likes';
}) =>
  render(
    <CastReactionAction
      icon={<svg data-testid="icon" />}
      count={count}
      countMarker={countMarker}
      isFocused={false}
    />,
  );

afterEach(() => cleanup());

describe('the action bar and a count that has not been read', () => {
  it('draws no number at all when the count is absent', () => {
    const { container } = draw({ count: undefined });

    expect(container.textContent?.trim()).toBe('');
    expect(container.querySelector('span')).toBeNull();
  });

  it('draws the number once the count is read', () => {
    const { container } = draw({ count: 5 });

    expect(container.textContent?.trim()).toBe('5');
  });

  it('draws the shorthand form of a large number', () => {
    const { container } = draw({ count: 1664 });

    expect(container.textContent?.trim()).toBe('1.7K');
  });

  it('keeps the icon while the count is absent, so the action stays usable', () => {
    const { container } = draw({ count: undefined });

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('marks the count with its kind, so a probe can ask whether it arrived', () => {
    const { container } = draw({ count: 1664, countMarker: 'likes' });

    const marked = container.querySelector('[data-fiddy-count="likes"]');
    expect(marked).not.toBeNull();
    expect(marked?.getAttribute('title')).toBe('1,664');
    expect(marked?.textContent?.trim()).toBe('1.7K');
  });

  it('draws no marker at all while the count is absent', () => {
    const { container } = draw({ count: undefined, countMarker: 'likes' });

    // A marker with no number behind it would read as "this cast has a like
    // count and it is nothing", which is the claim this card forbids.
    expect(container.querySelector('[data-fiddy-count]')).toBeNull();
  });
});
