/**
 * Profile edit component that allows users to enable Fiddy 3D on their
 * own profile. Storage is local-only and keyed to the signed-in FID.
 */

import { FC, memo, useCallback, useEffect, useState } from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';

import {
  clearStoredFiddy3DFid,
  FIDDY_3D_CREATE_URL,
  fiddy3DAssetUrl,
  getStoredFiddy3DFid,
  setStoredFiddy3DFid,
} from './fiddy3DProfile';

interface ProfileFiddy3DSettingsProps {
  /** The signed-in user's FID. */
  signedInFid: number;
  /** Whether this is the signed-in user's own profile. */
  isOwnProfile: boolean;
}

const ProfileFiddy3DSettings: FC<ProfileFiddy3DSettingsProps> = memo(
  ({ signedInFid, isOwnProfile }) => {
    const [enabled, setEnabled] = useState(false);
    const [hasAssets, setHasAssets] = useState<boolean | null>(null);

    useEffect(() => {
      setEnabled(isOwnProfile && getStoredFiddy3DFid() === signedInFid);
    }, [isOwnProfile, signedInFid]);

    useEffect(() => {
      if (!enabled || !signedInFid) {
        setHasAssets(null);
        return;
      }

      const controller = new AbortController();
      let disposed = false;

      const checkAssets = async () => {
        try {
          const thumbnailUrl = fiddy3DAssetUrl(signedInFid, 'thumbnail.png');
          const response = await fetch(thumbnailUrl, {
            method: 'HEAD',
            signal: controller.signal,
          });
          if (!disposed) {
            setHasAssets(response.ok);
          }
        } catch {
          if (!disposed) {
            setHasAssets(false);
          }
        }
      };
      void checkAssets();

      return () => {
        disposed = true;
        controller.abort();
      };
    }, [enabled, signedInFid]);

    const handleToggle = useCallback(() => {
      if (
        !isOwnProfile ||
        !Number.isSafeInteger(signedInFid) ||
        signedInFid <= 0
      ) {
        return;
      }

      if (enabled) {
        setEnabled(false);
        clearStoredFiddy3DFid();
        setHasAssets(null);
      } else {
        setStoredFiddy3DFid(signedInFid);
        setEnabled(true);
      }
    }, [enabled, isOwnProfile, signedInFid]);

    if (!isOwnProfile) {
      return null;
    }

    return (
      <div className="mt-4 rounded-lg border bg-card p-4 border-default">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-default">
              Fiddy 3D (beta)
            </h3>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                role="switch"
                aria-label="Use Fiddy 3D on your profile"
                checked={enabled}
                onChange={handleToggle}
                className="peer sr-only"
              />
              <div className="peer h-5 w-9 rounded-full bg-gray-300 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white dark:bg-gray-600 dark:after:bg-white" />
            </label>
          </div>

          {enabled && (
            <div className="text-xs">
              {hasAssets === null && (
                <span className="text-gray-500">Checking for your 3D...</span>
              )}
              {hasAssets === true && (
                <span className="text-green-600">✓ 3D avatar found</span>
              )}
              {hasAssets === false && (
                <span className="text-yellow-600">
                  No 3D figure found.{' '}
                  <ExternalLink
                    href={FIDDY_3D_CREATE_URL}
                    title="Get your chibi figure"
                    className="text-purple-600 hover:underline"
                  >
                    Get your chibi figure →
                  </ExternalLink>
                </span>
              )}
            </div>
          )}

          {!enabled && (
            <ExternalLink
              href={FIDDY_3D_CREATE_URL}
              title="Get your chibi figure"
              className="text-xs text-purple-600 hover:underline"
            >
              Get your chibi figure →
            </ExternalLink>
          )}
        </div>
      </div>
    );
  },
);

ProfileFiddy3DSettings.displayName = 'ProfileFiddy3DSettings';

export { ProfileFiddy3DSettings };
export type { ProfileFiddy3DSettingsProps };
