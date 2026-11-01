// @vitest-environment jsdom

/**
 * The fold, and the one "Show more" that goes with it.
 *
 * A jsdom box has no layout at all — every element reports 0 for both heights —
 * so this file states the model the component is measured against: a line holds
 * 40 characters, a line is 20px tall, and the fold is 10 lines (the same 10 the
 * `line-clamp-feed` class clamps at). That is enough to pin the four things the
 * change is about:
 *
 *   - a short cast shows NO button (it used to be able to, from a length guess
 *     that knew nothing about the width it was drawn at);
 *   - a cast just over ten lines shows one;
 *   - the answer is re-taken when the text changes (a translation swapped in, an
 *     edit, content that arrived late) and when the box it sits in resizes;
 *   - a scroll height one sub-pixel over the client height is not something a
 *     reader can see, and is not a button.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ClampedCastBody } from '~/components/casts/ClampedCastBody';

const LINE_HEIGHT_PX = 20;
/** `line-clamp-feed` in index.css folds at 10 lines. */
const FOLDED_LINES = 10;
/** How much of the cast body one drawn line holds. */
const COLUMNS_PER_LINE = 40;

type Box = { clientHeight: number; scrollHeight: number };

let boxOf: (element: HTMLElement) => Box;

/** Text that wraps at COLUMNS_PER_LINE characters, clamped at FOLDED_LINES. */
const wrappedBox = (element: HTMLElement): Box => {
  const characters = (element.textContent ?? '').trim().length;
  const lines = Math.max(1, Math.ceil(characters / COLUMNS_PER_LINE));
  return {
    clientHeight: Math.min(lines, FOLDED_LINES) * LINE_HEIGHT_PX,
    scrollHeight: lines * LINE_HEIGHT_PX,
  };
};

const originalClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientHeight',
);
const originalScrollHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
);

beforeAll(() => {
  boxOf = wrappedBox;
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return boxOf(this as HTMLElement).clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return boxOf(this as HTMLElement).scrollHeight;
    },
  });
});

afterAll(() => {
  const restore = (
    name: 'clientHeight' | 'scrollHeight',
    original: PropertyDescriptor | undefined,
  ) => {
    if (original === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        name
      ];
      return;
    }
    Object.defineProperty(HTMLElement.prototype, name, original);
  };
  restore('clientHeight', originalClientHeight);
  restore('scrollHeight', originalScrollHeight);
});

afterEach(() => {
  cleanup();
  boxOf = wrappedBox;
});

/** A cast body of `lines` full lines. */
const castBodyOfLines = (lines: number): string =>
  `${'x'.repeat(lines * COLUMNS_PER_LINE)}`;

const showMoreButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Show more',
  );

const clampedBody = (container: HTMLElement) =>
  container.querySelector('.line-clamp-feed');

const renderBody = ({
  text,
  fold = true,
  onExpand = () => {},
}: {
  text: string;
  fold?: boolean;
  onExpand?: () => void;
}) =>
  render(
    <ClampedCastBody fold={fold} text={text} onExpand={onExpand}>
      {text}
    </ClampedCastBody>,
  );

describe('the fold decides, and only the fold decides', () => {
  it('shows no button for a cast that fits', () => {
    const { container } = renderBody({ text: 'a short one' });

    expect(showMoreButton(container)).toBeUndefined();
    expect(clampedBody(container)).not.toBeNull();
  });

  it('shows a button for a cast just over ten lines', () => {
    const { container } = renderBody({ text: castBodyOfLines(11) });

    expect(showMoreButton(container)?.textContent).toBe('Show more');
  });

  it('shows no button for a cast that fills exactly ten lines', () => {
    const { container } = renderBody({ text: castBodyOfLines(10) });

    expect(showMoreButton(container)).toBeUndefined();
  });

  it('is not fooled by a sub-pixel overflow', () => {
    boxOf = () => ({ clientHeight: 200, scrollHeight: 201 });

    const { container } = renderBody({ text: 'a short one' });

    expect(showMoreButton(container)).toBeUndefined();
  });

  it('folds nothing and offers nothing when the surface does not fold', () => {
    const { container } = renderBody({
      text: castBodyOfLines(20),
      fold: false,
    });

    expect(showMoreButton(container)).toBeUndefined();
    expect(clampedBody(container)).toBeNull();
  });
});

describe('the measurement is re-taken', () => {
  it('follows the text: longer gets the button, shorter loses it', () => {
    const { container, rerender } = renderBody({ text: 'a short one' });

    expect(showMoreButton(container)).toBeUndefined();

    // A translation swapped in, an edit, content that arrived late.
    rerender(
      <ClampedCastBody
        fold={true}
        text={castBodyOfLines(11)}
        onExpand={() => {}}
      >
        {castBodyOfLines(11)}
      </ClampedCastBody>,
    );
    expect(showMoreButton(container)?.textContent).toBe('Show more');

    rerender(
      <ClampedCastBody fold={true} text="a short one" onExpand={() => {}}>
        a short one
      </ClampedCastBody>,
    );
    expect(showMoreButton(container)).toBeUndefined();
  });

  it('follows the box it sits in, when the box resizes', () => {
    const { container } = renderBody({ text: castBodyOfLines(11) });

    expect(showMoreButton(container)?.textContent).toBe('Show more');

    // The same text in a wider box: nothing is cut any more.
    boxOf = () => ({ clientHeight: 400, scrollHeight: 400 });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(showMoreButton(container)).toBeUndefined();
  });
});

describe('the button', () => {
  it('asks the surface to expand, once', () => {
    const onExpand = vi.fn();
    const { container } = renderBody({
      text: castBodyOfLines(11),
      onExpand,
    });

    fireEvent.click(showMoreButton(container) as HTMLButtonElement);

    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
