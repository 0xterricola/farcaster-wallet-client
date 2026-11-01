import { ApiCast, ApiQuoteCastEmbed } from 'farcaster-client-data';
import { FC, memo } from 'react';

import { LinkProps } from '~/components/links/Link';
import { LinkToConversationWithoutUsername } from '~/components/links/LinkToConversationWithoutUsername';

export type LinkToConversationProps = Omit<
  LinkProps<'conversationWithoutUsername'>,
  'to' | 'params' | 'searchParams'
> & {
  cast: ApiCast | ApiQuoteCastEmbed;
};

/**
 * The link to a cast's own page *in this client* — always the full-hash route.
 *
 * It used to be `/<handle>/<0x prefix>` (the pretty route upstream paints), and
 * on the node-backed client that is a page this app cannot open: the prefix
 * route is read through `/v2/user-thread-casts`, and a Snapchain node shards by
 * FID, so it cannot answer a hash prefix at all. Measured on the live build
 * (2026-10-22, card t_5068bb26): the timestamp inside every cast in the feed
 * led to "This page isn't on your node — No node-backed reader has been written
 * for this endpoint yet".
 *
 * `/~/conversations/<full hash>` is the route this client *can* read
 * (`/v2/thread-casts`, which a node answers from the cast's own hash), it is
 * reachable from the feed's in-memory index, and it is the same page a share
 * copies (`getFiddyCastUrl`) — so the link inside the app and the link somebody
 * else opens are now one page instead of two, one of which 501s. The handle is
 * not lost: it is on the page, and on the card the page unfurls as.
 */
const LinkToConversation: FC<LinkToConversationProps> = memo(
  ({ cast, ...props }) => (
    <LinkToConversationWithoutUsername
      params={{ castHash: cast.hash }}
      {...props}
    />
  ),
);

LinkToConversation.displayName = 'LinkToConversation';

export { LinkToConversation };
