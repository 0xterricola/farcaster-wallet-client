import { memo } from 'react';

import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { PageNotFound } from '~/components/page/PageNotFound';
import { ProfileAssets } from '~/components/profiles/ProfileAssets';
import { ProfileUserNotLoaded } from '~/components/profiles/ProfileUserNotLoaded';
import { PROFILE_LOOKUP_COPY } from '~/constants/profileLookup';
import { useUserByUsernameProfile } from '~/hooks/data/useUserByUsernameProfile';
import { useParams } from '~/hooks/navigation/useParams';

const ProfileAssetsWithUsernamePage = memo(() => {
  const { username } = useParams('profileAssetsWithUsername');

  // A node that is down must not render "not found": the lookup distinguishes
  // a 404 (nobody goes by that name) from an outage (honest copy + retry, or
  // the locally-known profile when the handle is the signed-in reader's own).
  const lookup = useUserByUsernameProfile({ username });

  if (lookup.status === 'loading') {
    return <FullScreenLoadingIndicator />;
  }
  if (lookup.status === 'notFound') {
    return (
      <PageNotFound
        title={PROFILE_LOOKUP_COPY.notFoundTitle(username)}
        message={PROFILE_LOOKUP_COPY.notFound}
      />
    );
  }
  if (lookup.status === 'error') {
    return (
      <ProfileUserNotLoaded
        username={username}
        error={lookup.error}
        onRetry={lookup.retry}
      />
    );
  }

  return <ProfileAssets userProfile={lookup.userProfile} />;
});

ProfileAssetsWithUsernamePage.displayName = 'ProfileAssetsWithUsernamePage';

export { ProfileAssetsWithUsernamePage };
