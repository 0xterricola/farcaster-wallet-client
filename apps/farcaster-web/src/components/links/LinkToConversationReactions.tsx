import { ApiCast } from 'farcaster-client-data';
import { FC, memo } from 'react';

import { LinkProps } from '~/components/links/Link';
import { LinkToConversationReactionsWithoutUsername } from '~/components/links/LinkToConversationReactionsWithoutUsername';

export type LinkToConversationReactionsProps = Omit<
  LinkProps<'conversationReactionsWithoutUsername'>,
  'to' | 'params' | 'searchParams'
> & {
  cast: ApiCast;
};

/**
 * The link to a cast's likes *in this client* — always the full-hash route,
 * for the same measured reason as `LinkToConversationRecasts`: the prefix
 * route resolves through `/v2/user-cast`, which no Snapchain node answers,
 * while the likes of a cast are its reaction messages and a node serves them
 * by (author, hash) — `reactionsByCast (like)`, measured live (t_fb198c05).
 */
const LinkToConversationReactions: FC<LinkToConversationReactionsProps> = memo(
  ({ cast, ...props }) => (
    <LinkToConversationReactionsWithoutUsername
      params={{ castHash: cast.hash }}
      {...props}
    />
  ),
);

LinkToConversationReactions.displayName = 'LinkToConversationReactions';

export { LinkToConversationReactions };
