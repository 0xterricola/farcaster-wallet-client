import * as Popover from '@radix-ui/react-popover';
import classNames from 'classnames';
import React from 'react';

import { AnchoredPopover } from '~/components/popovers/AnchoredPopover';
import { popoverRootId } from '~/constants/popovers';

type EmojiPickerPopoverProps = Pick<Popover.PopoverProps, 'onOpenChange'> & {
  renderInAnchoredPopover?: boolean;
  trigger: React.ReactElement;
  skipEmojis?: string[];
  onEmojiPick: ({ emoji }: { emoji: string }) => void;
  contentClassName?: string;
  /**
   * If true, include app-specific custom emojis (e.g. warplet).
   * Defaults to false so we don't accidentally insert shortcodes into text composers.
   */
  includeCustomEmojis?: boolean;
};

/**
 * The emoji picker is `emoji-mart` plus a 400 KB data set — 504,800 bytes as
 * one chunk, and `EmojiPickerSurface` is that chunk.
 *
 * It is an `import()` here rather than a top-level import because this
 * component's callers are on the feed's own path (`EmojiComposerPicker` ->
 * `Composer` -> `ComposeCastModal` -> `CastComposerSessionProvider` ->
 * `AuthedLayout`), so a static import put the whole picker in `index.html`'s
 * eager `modulepreload` list: downloaded before the entry chunk had finished
 * evaluating, on the load that is trying to draw a feed, and again on the
 * sign-in reboot's second document load. MEASURED (2026-10-22, card
 * t_648a3e4c): nothing about drawing a cast needs an emoji picker.
 *
 * `warmEmojiPicker` runs from the trigger's own pointer/focus events, so the
 * chunk is already on its way by the time the popover opens: the fetch is paid
 * by the gesture that asks for a picker, never by the feed.
 */
const loadEmojiPicker = () =>
  import('~/components/popovers/EmojiPickerSurface').then((module) => ({
    default: module.EmojiPickerSurface,
  }));

const LazyEmojiPickerSurface = React.lazy(loadEmojiPicker);

const warmEmojiPicker = () => {
  // The promise IS the load; React.lazy remembers it, so there is nothing to
  // await here and no state to keep.
  void loadEmojiPicker();
};

/**
 * The picker's own footprint while its chunk arrives, so the popover does not
 * jump when it lands. A first open on a cold cache is the only time this is on
 * screen at all.
 */
const EmojiPickerSurfaceFallback: React.FC = () => (
  <div
    aria-busy="true"
    className="flex h-[420px] w-[352px] items-center justify-center rounded-md text-sm text-muted"
    data-fiddy="emoji-picker-loading"
  >
    Loading emoji…
  </div>
);

/** Adds the fetch-on-intent handlers to whatever element the caller passes as
 * the trigger, keeping whatever handlers the caller already set on it. */
const warmableTrigger = (trigger: React.ReactElement): React.ReactElement => {
  const element = trigger as React.ReactElement<
    React.HTMLAttributes<HTMLElement>
  >;
  const existing = element.props;

  return React.cloneElement(element, {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      warmEmojiPicker();
      existing.onPointerEnter?.(event);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      warmEmojiPicker();
      existing.onFocus?.(event);
    },
  });
};

const EmojiPickerPopover: React.FC<EmojiPickerPopoverProps> = ({
  onOpenChange,
  onEmojiPick,
  trigger,
  skipEmojis,
  contentClassName,
  includeCustomEmojis = false,
  renderInAnchoredPopover = false,
}) => {
  const stopPropagation = React.useCallback((e: React.SyntheticEvent) => {
    // We need this otherwise it inteferes with the `EmojiPicker` wheel events internally.
    // We can remove this if/when we implement our own emoji selector internally.
    // See: https://github.com/radix-ui/primitives/issues/1159
    e.stopPropagation();
  }, []);

  const popoverPortalContainer =
    document.getElementById(popoverRootId) ?? undefined;

  const emojiPicker = (
    <React.Suspense fallback={<EmojiPickerSurfaceFallback />}>
      <LazyEmojiPickerSurface
        includeCustomEmojis={includeCustomEmojis}
        onEmojiPick={onEmojiPick}
        skipEmojis={skipEmojis}
      />
    </React.Suspense>
  );

  const warmTrigger = warmableTrigger(trigger);

  if (renderInAnchoredPopover) {
    return (
      <AnchoredPopover
        contentClassName={classNames('outline-hidden z-20', contentClassName)}
        onOpenChange={onOpenChange}
        sideOffset={4}
        trigger={warmTrigger}
      >
        <div onScroll={stopPropagation} onWheel={stopPropagation}>
          {emojiPicker}
        </div>
      </AnchoredPopover>
    );
  }

  return (
    <Popover.Root modal={true} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{warmTrigger}</Popover.Trigger>
      <Popover.Portal container={popoverPortalContainer}>
        <Popover.Content
          className={classNames('outline-hidden z-20', contentClassName)}
          side="bottom"
          sideOffset={4}
          align="start"
          onScroll={stopPropagation}
          onWheel={stopPropagation}
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
        >
          {emojiPicker}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

export { EmojiPickerPopover };
