/**
 * The emoji picker itself: `emoji-mart`, its React wrapper, and the data set
 * that makes them worth anything (`@emoji-mart/data` is one JSON of every emoji
 * in the set).
 *
 * WHY THIS IS A MODULE OF ITS OWN (MEASURED, 2026-10-22, card t_648a3e4c)
 *
 * These three imports used to sit in `EmojiPickerPopover`, which is on the
 * feed's own path (`EmojiComposerPicker` -> `Composer` -> `ComposeCastModal` ->
 * `CastComposerSessionProvider` -> `AuthedLayout`). That made the emoji chunk —
 * 504,800 bytes, the largest single `modulepreload` in `index.html` — a chunk
 * the browser had to download before the entry chunk finished evaluating, on
 * every cold load, twice (the sign-in reboot loads the document a second time).
 * Nothing about drawing a cast needs an emoji picker.
 *
 * So the picker's *shell* (the popover, its trigger, its placement) stays in
 * `EmojiPickerPopover`, and the bytes live here, behind the `import()` that
 * component makes when someone opens the picker. The `skipEmojis` lookup that
 * needs `getEmojiDataFromNative` came along with them — it is part of the same
 * data set.
 */
import data from '@emoji-mart/data';
import EmojiPicker from '@emoji-mart/react';
import { getEmojiDataFromNative } from 'emoji-mart';
import React, { useEffect, useState } from 'react';

import { CUSTOM_EMOJIS } from '~/constants/customEmojis';

type EmojiSelectPayload = {
  native?: string;
  shortcodes?: string[];
};

type EmojiPickerSurfaceProps = {
  /** Include app-specific custom emojis (e.g. warplet). */
  includeCustomEmojis?: boolean;
  /** Emojis this picker may not offer, by their native character. */
  skipEmojis?: string[];
  onEmojiPick: ({ emoji }: { emoji: string }) => void;
};

/** The picker, ready to be dropped into a popover. */
const EmojiPickerSurface: React.FC<EmojiPickerSurfaceProps> = ({
  includeCustomEmojis = false,
  skipEmojis,
  onEmojiPick,
}) => {
  const [exceptEmojis, setExceptEmojis] = useState<string[]>([]);

  useEffect(() => {
    skipEmojis?.map(async (emoji) => {
      const emojiData = await getEmojiDataFromNative(emoji);
      setExceptEmojis((prev) => [...prev, emojiData?.id]);
    });
  }, [skipEmojis]);

  const handleEmojiSelect = React.useCallback(
    (emoji: EmojiSelectPayload) => {
      // Native emojis have `native`; custom emojis use `shortcodes` (e.g. [':warplet:'])
      const selected = emoji.native ?? emoji.shortcodes?.[0];
      if (typeof selected === 'string') {
        onEmojiPick({ emoji: selected });
      }
    },
    [onEmojiPick],
  );

  return (
    <EmojiPicker
      data={data}
      custom={includeCustomEmojis ? CUSTOM_EMOJIS : undefined}
      onEmojiSelect={handleEmojiSelect}
      exceptEmojis={exceptEmojis}
      perLine={8}
      rows={4}
      maxFrequentRows={1}
      previewPosition="none"
      color="#8a63d2"
      skinTonePosition={'none'}
      noResultsEmoji="shrug"
    />
  );
};

export { EmojiPickerSurface };
