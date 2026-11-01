import { ApiCast, ApiUser } from 'farcaster-client-data';
import { FC, useMemo } from 'react';

import { Cast } from '~/components/casts/Cast';
import { ProfileHeader } from '~/components/profiles/ProfileHeader';
import { getConversationUrl } from '~/utils/conversationUtils';

import { ProfileCastsHead } from './ProfileCastsHead';

type ProfileCastItemProps = {
  cast: ApiCast;
  host: string | undefined;
};

export const ProfileCastItem: FC<ProfileCastItemProps> = ({ cast, host }) => {
  const castText = useMemo(() => {
    if (cast.text.length !== 0) {
      return cast.text;
    }
    // If cast doesn't have a length, it must have an embed.
    // We will default to rendering the first OG preview URL.
    if (cast.embeds && cast.embeds.urls.length !== 0) {
      return cast.embeds.urls[0].openGraph.url;
    }
    // Fallback to empty string.
    return '';
  }, [cast.embeds, cast.text]);

  const castUrl = useMemo(() => {
    return getConversationUrl({ cast, host });
  }, [cast, host]);

  const isoTimestamp = useMemo(() => {
    return new Date(cast.timestamp).toISOString();
  }, [cast.timestamp]);

  const formattedTimestamp = useMemo(() => {
    return new Date(cast.timestamp).toLocaleString();
  }, [cast.timestamp]);

  return (
    <article style={{ marginBottom: '1.5em' }}>
      <p style={{ marginBottom: '0.25em' }}>{castText}</p>
      <a href={castUrl} rel="bookmark" className="u-url">
        <time dateTime={isoTimestamp}>{formattedTimestamp}</time>
      </a>
      <ul className="cast-stats">
        <li>
          {cast.replies.count} {cast.replies.count === 1 ? 'reply' : 'replies'}
        </li>
        {/* Counts are optional in `ApiCast` (the node-backed client paints a
            feed before its counts are read); this app reads the hosted API,
            whose casts always carry them, so absent degrades to 0. */}
        <li>
          {cast.recasts?.count ?? 0}{' '}
          {(cast.recasts?.count ?? 0) === 1 ? 'recast' : 'recasts'}
        </li>
        <li>
          {cast.reactions?.count ?? 0}{' '}
          {(cast.reactions?.count ?? 0) === 1 ? 'reaction' : 'reactions'}
        </li>
      </ul>
    </article>
  );
};

ProfileCastItem.displayName = 'ProfileCastItem';

type ProfileCastsProps = {
  casts: ApiCast[];
  user: ApiUser;
};

const ProfileCasts: FC<ProfileCastsProps> = ({ casts, user }) => {
  return (
    <>
      <ProfileCastsHead user={user} casts={casts} />
      <ProfileHeader user={user} />
      <div>
        {casts.map((cast) => (
          <Cast key={cast.hash} cast={cast} />
        ))}
      </div>
    </>
  );
};

ProfileCasts.displayName = 'ProfileCasts';

export { ProfileCasts };
