import classNames from 'classnames';
import {
  ApiCast,
  ApiCastFeedIncludeReason,
  ApiQuoteCastEmbed,
} from 'farcaster-client-data';
import {
  CastClickType,
  formatTimeAgo,
  resolveUsername,
  useTrackCastClick,
} from 'farcaster-client-hooks';
import React from 'react';

import { FarcasterProBadge } from '~/components/badges/FarcasterProBadge';
import { ChannelTag, TokenTag } from '~/components/channelsV3/ChannelTag';
import { ChannelBadge } from '~/components/channelUsers/ChannelBadge';
import { TwoPeopleIcon } from '~/components/icons/TwoPeopleIcon';
import { LinkToConversation } from '~/components/links/LinkToConversation';
import { LinkToProfileWithSummaryTooltip } from '~/components/links/LinkToProfileWithSummaryTooltip';
import { Tooltip } from '~/components/Tooltip';
import { useUserLevel } from '~/hooks/data/useUserLevel';

export function CastAuthorLine({
  cast,
  showChannel = false,
  showMemberBadge = false,
  variant = 'default',
  profileOpenIncludeReason,
}: {
  cast: ApiCast | ApiQuoteCastEmbed;
  showChannel?: boolean;
  showMemberBadge?: boolean;
  variant?: 'default' | 'direct-cast';
  profileOpenIncludeReason?: ApiCastFeedIncludeReason['type'];
}) {
  const trackCastClick = useTrackCastClick();
  const isProUser = useUserLevel(cast.author) === 'pro';
  // A quote embed carries no attribution (only a real cast read does), so the
  // label is drawn from a read cast's own client and nothing else.
  const client = 'client' in cast ? cast.client : undefined;

  return (
    <div
      className={classNames('flex w-full min-w-0 flex-row items-center gap-1')}
    >
      <LinkToProfileWithSummaryTooltip
        title={cast.author.displayName}
        user={cast.author}
        includeReason={profileOpenIncludeReason}
        className={classNames(
          'relative font-semibold !text-inherit hover:underline',
          variant === 'direct-cast' && '!text-default',
        )}
        onClick={() => {
          trackCastClick({ type: CastClickType.Author });
        }}
      >
        {resolveUsername({
          username: cast.author.username,
          fid: cast.author.fid,
        }).replace('@', '')}
      </LinkToProfileWithSummaryTooltip>
      {isProUser && <FarcasterProBadge size={20} className="mb-px" />}
      {showChannel && (cast.channel || cast.token) && (
        <div className="text-muted">in</div>
      )}
      {showChannel && cast.channel && (
        <ChannelTag
          channel={cast.channel}
          shouldLinkToChannel={true}
          size="feed"
          variant={variant}
        />
      )}
      {showChannel && cast.token && (
        <TokenTag
          token={cast.token}
          shouldLinkToToken={true}
          size="feed"
          variant={variant}
        />
      )}
      {showMemberBadge && (
        <ChannelBadge color="secondary" Icon={TwoPeopleIcon} />
      )}
      <LinkToConversation
        cast={cast}
        title=""
        onClick={() => {
          trackCastClick({ type: CastClickType.Cast });
        }}
      >
        <Tooltip
          trigger={
            <div
              className={classNames(
                'cursor-pointer text-base text-faint hover:underline',
              )}
            >
              {formatTimeAgo(cast.timestamp, 'floor')}
            </div>
          }
          content={
            <div className="px-1 text-sm text-light">
              {new Date(cast.timestamp).toLocaleTimeString()} ·{' '}
              {new Date(cast.timestamp).toLocaleDateString()}
            </div>
          }
        />
      </LinkToConversation>
      {client && (
        <Tooltip
          trigger={
            <span
              className={classNames(
                'truncate text-base text-faint',
                variant === 'direct-cast' && '!text-default',
              )}
              data-fiddy="cast-client-label"
            >
              via {client.displayName}
            </span>
          }
          content={
            <div className="px-1 text-sm text-light">
              {clientTooltip(client)}
            </div>
          }
        />
      )}
    </div>
  );
}

/**
 * What the label means, in one line.
 *
 * A named app is the app account's own name (or the reader's own label for it);
 * `own` and `onchain` are descriptions, because for those there is no app to
 * name and inventing one would be a lie. Every string here is about the app, not
 * about the account: the account is already on the line above.
 */
const clientTooltip = (client: NonNullable<ApiCast['client']>): string => {
  switch (client.kind) {
    case 'self':
      return 'Posted through this app';
    case 'own':
      return 'Posted with a key this account set up itself';
    case 'onchain':
      return 'Posted with an on-chain key that names no app';
    case 'unknown':
      return `Posted by an app whose account names itself nowhere (app fid ${client.fid})`;
    default:
      return 'The app this cast was posted from, per its own profile';
  }
};
