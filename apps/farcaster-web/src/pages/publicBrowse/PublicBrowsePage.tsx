/**
 * The public browse surface: `/feed` and `/explore`.
 *
 * WHAT IT IS FOR
 *
 * A signed-out visitor had no way to read anything on fiddy.fun. The front door
 * asks for a name and a brain before it shows a single cast, and the only two
 * URLs that looked like a feed (`/feed`, `/explore`) resolved as usernames and
 * drew a stranger's months-old profile. So this is the other half of that fix:
 * real routes, real content, read with no account at all, reachable in one
 * press from the landing (`FiddyOnboardingPage`'s "Look around first").
 *
 * WHAT IT READS, AND FROM WHERE
 *
 * `usePublicWindow` posts the client's own feed request with the public feed
 * key; the node adapter answers it from real protocol messages through
 * whichever server the provider chain has live (`publicFeedWindow.ts` says
 * exactly which reads, and why). Nothing on this surface needs a session, a
 * cookie or a key.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No composer, no reaction, no follow: every one of those needs an account, so
 * a cast here draws its counts as plain text and Share (`Cast readOnly`), and
 * the surface says once, at the top, what signing in would add. There is no
 * auth wall - the casts are the page - and nothing here can render a private
 * cast: a node serves public protocol messages, which is all this reads.
 */

import { EventingProvider } from 'farcaster-client-hooks';
import { FC, memo, useCallback, useState } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Cast } from '~/components/casts/Cast';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { FlatList } from '~/components/lists/FlatList';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import {
  type PublicBrowseVariant,
  type PublicWindow,
  usePublicWindow,
} from '~/hooks/data/usePublicWindow';
import { type ApiCastWithContext } from '~/types';
import { castWithContextKeyExtractor } from '~/utils/keyExtractorUtils';

/** How many cast-shaped placeholders a first read paints. */
const SKELETON_ROWS = 4;

const PublicCastSkeleton: FC = memo(() => (
  <div className="fiddy-public-skeleton" aria-hidden="true">
    <div className="fiddy-public-skeleton-avatar" />
    <div className="fiddy-public-skeleton-body">
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-short" />
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-full" />
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-mid" />
    </div>
  </div>
));

PublicCastSkeleton.displayName = 'PublicCastSkeleton';

const PublicWindowSkeletons: FC = memo(() => (
  <div
    className="fiddy-public-skeletons"
    data-fiddy="public-loading"
    role="status"
    aria-live="polite"
  >
    <span className="fiddy-public-loading-copy">
      Fiddy is looking for fresh casts…
    </span>
    {Array.from({ length: SKELETON_ROWS }, (_, index) => (
      <PublicCastSkeleton key={index} />
    ))}
  </div>
));

PublicWindowSkeletons.displayName = 'PublicWindowSkeletons';

/**
 * What a visitor with no account is told, once, at the top of the column.
 *
 * It says what reading costs (nothing) and what signing in buys (posting), and
 * it is a note rather than a wall: the casts are on the page below it.
 */
const PublicReadingNote: FC<{
  onSignIn: () => void;
  variant: PublicBrowseVariant;
}> = memo(({ onSignIn, variant }) => (
  <div className="fiddy-public-note" data-fiddy="public-sign-in-prompt">
    <span>
      <b>Take a look around. No account needed.</b> These are{' '}
      {variant === 'explore'
        ? 'the casts getting attention on Farcaster right now'
        : 'the newest casts from people on Farcaster'}
      . When you want to reply, like or post, signing in is the next step.
    </span>
    <DefaultButton className="fiddy-public-note-btn" onClick={onSignIn}>
      Sign in to join in
    </DefaultButton>
  </div>
));

PublicReadingNote.displayName = 'PublicReadingNote';

/**
 * The two shapes of the same window, on `/feed`.
 *
 * `recent` is what is new, `trending` is what is getting attention. Both are
 * one read with a different feed type, so this is a switch and not a page.
 */
const PublicWindowTabs: FC<{ window: PublicWindow }> = memo(({ window }) => (
  <div className="fiddy-public-tabs" data-fiddy="public-tabs">
    <button
      type="button"
      className="fiddy-public-tab"
      data-fiddy="public-tab-recent"
      aria-current={window.kind === 'recent' ? 'page' : undefined}
      onClick={() => window.selectKind('recent')}
    >
      Newest
    </button>
    <button
      type="button"
      className="fiddy-public-tab"
      data-fiddy="public-tab-trending"
      aria-current={window.kind === 'trending' ? 'page' : undefined}
      onClick={() => window.selectKind('trending')}
    >
      Getting attention
    </button>
  </div>
));

PublicWindowTabs.displayName = 'PublicWindowTabs';

/**
 * The topic row, on `/explore`.
 *
 * The chips are the channels the window itself came from, with how many of its
 * casts are in each. Selecting one narrows the read to that channel's casts;
 * `← All of it` comes back. No channel directory is involved, because a page
 * cannot read one.
 */
const PublicTopicRow: FC<{ window: PublicWindow }> = memo(({ window }) => (
  <div className="fiddy-public-topics" data-fiddy="public-topics">
    {window.topic !== null && (
      <button
        type="button"
        className="fiddy-public-chip"
        data-fiddy="public-topic-all"
        onClick={() => window.selectTopic(null)}
      >
        &#8592; All of it
      </button>
    )}
    {window.topics.slice(0, 8).map((topic) => (
      <button
        key={topic.key}
        type="button"
        className="fiddy-public-chip"
        data-fiddy="public-topic"
        data-topic={topic.key}
        aria-pressed={window.topic === topic.key}
        onClick={() =>
          window.selectTopic(window.topic === topic.key ? null : topic.key)
        }
      >
        #{topic.key} <span className="opacity-60">{topic.count}</span>
      </button>
    ))}
  </div>
));

PublicTopicRow.displayName = 'PublicTopicRow';

const PublicBrowseColumn: FC<{
  variant: PublicBrowseVariant;
  onSignIn: () => void;
}> = memo(({ variant, onSignIn }) => {
  const isSignedIn = useIsSignedIn();
  const window = usePublicWindow(variant);

  const renderItem = useCallback(
    ({ item }: { item: ApiCastWithContext }) => (
      // readOnly: the counts and Share, and no button that needs an account.
      <Cast castWithContext={item} readOnly={!isSignedIn} />
    ),
    [isSignedIn],
  );

  return (
    <div
      className="fiddy-public"
      data-fiddy="public-browse"
      data-variant={variant}
    >
      {!isSignedIn && (
        <PublicReadingNote onSignIn={onSignIn} variant={variant} />
      )}

      {variant === 'feed' ? (
        <PublicWindowTabs window={window} />
      ) : (
        <PublicTopicRow window={window} />
      )}

      {window.isLoading ? (
        <PublicWindowSkeletons />
      ) : window.isError ? (
        <div className="fiddy-public-state" data-fiddy="public-error">
          <h2 className="fiddy-public-state-title">
            This could not be read just now.
          </h2>
          <p className="fiddy-public-state-body">{window.errorMessage}</p>
          <div className="fiddy-public-state-actions">
            <button
              type="button"
              className="fiddy-public-state-btn"
              data-fiddy="public-retry"
              onClick={window.retry}
            >
              Try again
            </button>
            {!isSignedIn && (
              <button
                type="button"
                className="fiddy-public-state-btn fiddy-public-state-btn-quiet"
                onClick={onSignIn}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      ) : window.isEmpty ? (
        <div className="fiddy-public-state" data-fiddy="public-empty">
          <h2 className="fiddy-public-state-title">
            No fresh casts in this corner yet.
          </h2>
          <p className="fiddy-public-state-body">
            {window.topic !== null
              ? `Fiddy looked in #${window.topic}, but nothing came back this time. See everything, or look again in a minute.`
              : 'Fiddy looked, but the server had nothing to share this time. The network is not empty, so it is worth another look.'}
          </p>
          <div className="fiddy-public-state-actions">
            <button
              type="button"
              className="fiddy-public-state-btn"
              data-fiddy="public-retry"
              onClick={window.retry}
            >
              Look again
            </button>
            {window.topic !== null && (
              <button
                type="button"
                className="fiddy-public-state-btn fiddy-public-state-btn-quiet"
                onClick={() => window.selectTopic(null)}
              >
                See everything
              </button>
            )}
          </div>
        </div>
      ) : (
        <FlatList
          data={window.castsWithContext}
          emptyView={<PublicWindowSkeletons />}
          renderItem={renderItem}
          keyExtractor={castWithContextKeyExtractor}
          onEndReached={window.onEndReached}
          isFetchingNextPage={window.isFetchingNextPage}
        />
      )}

      <p className="fiddy-public-source" data-fiddy="public-source">
        This window is assembled from the network itself: the newest casts from
        the accounts a few long-standing public Farcaster accounts follow, read
        from the server this app is pointed at.
        {window.kind === 'trending'
          ? ' It is ordered by the likes and recasts the network really holds for those casts, not by a recommendation service.'
          : ''}{' '}
        No account of yours is involved, and signing in changes nothing about
        what is shown here.
      </p>
    </div>
  );
});

PublicBrowseColumn.displayName = 'PublicBrowseColumn';

const PublicBrowsePage: FC<{ variant: PublicBrowseVariant }> = memo(
  ({ variant }) => {
    const [isSigningIn, setIsSigningIn] = useState(false);

    const onSignIn = useCallback(() => {
      setIsSigningIn(true);
    }, []);

    return (
      <Page
        meta={{
          title: variant === 'explore' ? 'Fiddy / Explore' : 'Fiddy / Feed',
          description:
            'Read what Farcaster is saying right now, with no account needed.',
        }}
      >
        <BorderedMainContent>
          <PageHeader footer={undefined}>
            <PageTitle>{variant === 'explore' ? 'Explore' : 'Feed'}</PageTitle>
          </PageHeader>
          {/* The column's own reads report through the eventing provider, the
              same way the home feed's do. */}
          <EventingProvider on="explore" feed={variant}>
            <PublicBrowseColumn variant={variant} onSignIn={onSignIn} />
          </EventingProvider>
        </BorderedMainContent>
        {isSigningIn && <LoginModal onClose={() => setIsSigningIn(false)} />}
      </Page>
    );
  },
);

PublicBrowsePage.displayName = 'PublicBrowsePage';

/** `/feed`: the public window, newest first, with the ranked view beside it. */
const PublicFeedPage: FC = memo(() => <PublicBrowsePage variant="feed" />);
PublicFeedPage.displayName = 'PublicFeedPage';

/** `/explore`: the same window by topic, ranked by real engagement. */
const PublicExplorePage: FC = memo(() => (
  <PublicBrowsePage variant="explore" />
));
PublicExplorePage.displayName = 'PublicExplorePage';

export { PublicExplorePage, PublicFeedPage };
