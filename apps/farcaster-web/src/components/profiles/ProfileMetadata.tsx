import {
  ApiCastFeedIncludeReason,
  ApiUserProfile,
} from 'farcaster-client-data';
import { useGloballyCachedUser } from 'farcaster-client-hooks';
import React, { useState } from 'react';

import { Avatar } from '~/components/avatar/Avatar';
import { FarcasterProBadge } from '~/components/badges/FarcasterProBadge';
import { Fiddy3DAvatar } from '~/components/fiddy/Fiddy3DAvatar';
import { getStoredFiddy3DFid } from '~/components/fiddy/fiddy3DProfile';
import { Fiddy3DShareLink } from '~/components/fiddy/Fiddy3DShareLink';
import { ImageLightboxModal } from '~/components/modals/ImageLightboxModal';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useUserLevel } from '~/hooks/data/useUserLevel';

import { AuthedProfileHeader } from './AuthedProfileHeader';
import { FarcasterProBadgeDetailsModal } from './FarcasterProBadgeDetailsModal';
import { UnauthedProfileHeader } from './UnauthedProfileHeader';

type ProfileMetadataProps = {
  userProfile: ApiUserProfile;
  profileOpenIncludeReason?: ApiCastFeedIncludeReason['type'];
  profileOpenCastHash?: string;
};

const ProfileMetadata: React.FC<ProfileMetadataProps> = ({
  userProfile,
  profileOpenIncludeReason,
  profileOpenCastHash,
}) => {
  const isSignedIn = useIsSignedIn();
  const { fid: currentUserFid } = useCurrentUser() ?? { fid: 0 };

  const user = useGloballyCachedUser({ fallback: userProfile.user });
  const profileUserFid = user.fid;

  // Check if logged-in user has opted in to Fiddy 3D AND viewing their own profile
  const isOwnProfile = currentUserFid === profileUserFid;
  const storedFiddy3DFid = getStoredFiddy3DFid();
  const hasFiddy3D = isOwnProfile && storedFiddy3DFid === currentUserFid;

  const [showPfpExpanded, setShowPfpExpanded] = useState<boolean>(false);

  return (
    <>
      <div className="relative flex w-full flex-col">
        <div className={'z-[1] flex w-full flex-col'}>
          <div className="mt-[-48px] flex flex-row items-end justify-between px-4 pr-1">
            <span className="relative rounded-full border-[3px] border-app">
              <div
                className="cursor-pointer rounded-full"
                onClick={() => {
                  setShowPfpExpanded(true);
                }}
              >
                {hasFiddy3D ? (
                  <Fiddy3DAvatar
                    fid={profileUserFid}
                    displayName={user.displayName}
                    fallbackPfpUrl={user.pfp?.url}
                    size="xl2"
                  />
                ) : (
                  <Avatar user={user} size="xl2" disabled priority />
                )}
              </div>
              <FarcasterProBadgeOnProfile userProfile={userProfile} />
            </span>
            {hasFiddy3D && <Fiddy3DShareLink fid={profileUserFid} />}
          </div>
          {isSignedIn ? (
            <AuthedProfileHeader
              userProfile={userProfile}
              profileOpenIncludeReason={profileOpenIncludeReason}
              profileOpenCastHash={profileOpenCastHash}
            />
          ) : (
            <UnauthedProfileHeader userProfile={userProfile} />
          )}
        </div>
      </div>
      {showPfpExpanded && typeof user.pfp !== 'undefined' && !hasFiddy3D && (
        <ImageLightboxModal
          imageUrls={[user.pfp.url]}
          initialIndex={0}
          onClose={() => {
            setShowPfpExpanded(false);
          }}
          title="User profile picture"
        />
      )}
    </>
  );
};

function FarcasterProBadgeOnProfile({
  userProfile,
}: {
  userProfile: ApiUserProfile;
}) {
  const user = useGloballyCachedUser({ fallback: userProfile.user });

  const isProUser = useUserLevel(user) === 'pro';

  const [showBadgeDetails, setShowBadgeDetails] = useState<boolean>(false);

  if (!isProUser) {
    return null;
  }

  return (
    <div
      className="absolute bottom-0 right-0 flex size-[28px] cursor-pointer items-center justify-center rounded-full text-inverted"
      title={'Farcaster Pro'}
      onClick={(e) => {
        e.stopPropagation();
        setShowBadgeDetails(true);
      }}
    >
      <FarcasterProBadge size={28} showBorder={true} />
      {showBadgeDetails && (
        <FarcasterProBadgeDetailsModal
          fid={user.fid}
          onClose={() => setShowBadgeDetails(false)}
        />
      )}
    </div>
  );
}

export { ProfileMetadata };
