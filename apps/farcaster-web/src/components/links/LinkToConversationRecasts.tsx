import { ApiCast } from 'farcaster-client-data';
import { FC, memo } from 'react';

import { LinkProps } from '~/components/links/Link';
import { LinkToConversationRecastsWithoutUsername } from '~/components/links/LinkToConversationRecastsWithoutUsername';

export type LinkToConversationRecastsProps = Omit<
  LinkProps<'conversationRecastsWithoutUsername'>,
  'to' | 'params' | 'searchParams'
> & {
  cast: ApiCast;
};

/**
 * The link to a cast's recasters *in this client* — always the full-hash route.
 *
 * It used to be `/<handle>/<0x prefix>/recasts` whenever the author held a
 * handle, and on the node-backed client that is a page this app cannot open:
 * the prefix route resolves its cast through `/v2/user-cast`, and a Snapchain
 * node shards by FID, so it cannot answer a hash prefix at all. Measured on the
 * live build (2026-10-22, cards t_5068bb26 + t_fb198c05): the "N recasts" tab
 * of a focused cast led to "This page isn't on your node — No node-backed
 * reader has been written for this endpoint yet".
 *
 * `/~/conversations/<full hash>/recasts` is the route this client *can* read:
 * the recasters of a cast are its reaction messages, and a node answers them by
 * the cast's own (author, hash) — `reactionsByCast (recast)`, measured live.
 * Same shape and reason as `LinkToConversation`'s full-hash decision, so an
 * in-app link and the cast page behind it stay one family of URLs.
 */
const LinkToConversationRecasts: FC<LinkToConversationRecastsProps> = memo(
  ({ cast, ...props }) => (
    <LinkToConversationRecastsWithoutUsername
      params={{ castHash: cast.hash }}
      {...props}
    />
  ),
);

LinkToConversationRecasts.displayName = 'LinkToConversationRecasts';

export { LinkToConversationRecasts };
