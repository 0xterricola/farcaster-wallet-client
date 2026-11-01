/**
 * A shared look inside a cast.
 *
 * When a cast embeds one of our own look links, the generic link card is the
 * wrong answer: it draws somebody else's page as a picture, while the thing in
 * the link is a palette this client can wear. So this draws the look itself, in
 * its own colours, with the name of whoever cast it and one button that puts it
 * on.
 *
 * WHERE IT SITS. `useCastBody`'s URL-embed branch, next to the Space renderer,
 * which is the same shape of decision: the embed is OURS, so we draw it rather
 * than asking the provider's OG card for it. That branch is reached for a real
 * `og` embed, so this card supersedes the link card rather than replacing it.
 *
 * NOTHING IS INVENTED. The look comes from the link (checked again on the way in
 * — `useSharedLook`), and the maker's name comes from the cast that carried it.
 * A dead link says so in one sentence; it never draws an empty card.
 */

import React from 'react';

import { SharedLookCard } from '~/components/looks/SharedLookCard';
import { matchLookUrl } from '~/utils/lookTheme';

const LookEmbedAttachment: React.FC<{
  url: string;
  /** The handle of whoever cast the link, when this client knows it. */
  by?: string;
  width?: number;
  height?: number;
}> = React.memo(({ url, by, width, height }) => {
  const match = matchLookUrl(url);

  // A cast can carry a look link this build cannot read (an older shape, or a
  // host that is not us): then the generic card is right, and this returns
  // nothing so the caller can fall through to it.
  if (!match) {
    return null;
  }

  const reservedSizeStyle: React.CSSProperties = {
    ...(typeof height === 'number' ? { height } : {}),
    ...(typeof width === 'number' ? { minWidth: width, width } : {}),
  };

  return (
    <div
      style={reservedSizeStyle}
      className="w-full shrink-0"
      data-fiddy="look-embed"
      onClick={(event) => {
        // The card has its own button; a tap on the card around it belongs to
        // the cast, which is what opens the conversation.
        event.stopPropagation();
      }}
    >
      <SharedLookCard
        id={match.id}
        by={by}
        variant="embed"
        className="bg-overlay-faint border-faint"
      />
    </div>
  );
});

LookEmbedAttachment.displayName = 'LookEmbedAttachment';

export { LookEmbedAttachment };
