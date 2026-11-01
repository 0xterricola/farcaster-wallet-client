import { ApiCast } from 'farcaster-client-data';
import { FC, memo } from 'react';

import { LinkProps } from '~/components/links/Link';
import { LinkToConversationQuotesWithoutUsername } from '~/components/links/LinkToConversationQuotesWithoutUsername';

export type LinkToConversationQuotesProps = Omit<
  LinkProps<'conversationQuotesWithoutUsername'>,
  'to' | 'params' | 'searchParams'
> & {
  cast: ApiCast;
};

/**
 * The link to a cast's quotes *in this client* — always the full-hash route,
 * for the same measured reason as `LinkToConversationRecasts`: the prefix
 * route resolves through `/v2/user-cast`, which no Snapchain node answers.
 *
 * The page it names still cannot be read from a node — quotes of a cast are an
 * indexer's reverse index and no node keeps one (`hostedRoutes.ts` says so in
 * words) — but the node-backed client does not paint this link at all (its
 * casts carry no quote count to paint one from), so the full-hash shape keeps
 * the family of URLs one family for whichever provider CAN serve the read.
 */
const LinkToConversationQuotes: FC<LinkToConversationQuotesProps> = memo(
  ({ cast, ...props }) => (
    <LinkToConversationQuotesWithoutUsername
      params={{ castHash: cast.hash }}
      {...props}
    />
  ),
);

LinkToConversationQuotes.displayName = 'LinkToConversationQuotes';

export { LinkToConversationQuotes };
