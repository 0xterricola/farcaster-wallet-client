/**
 * The Fiddy 3D avatar for profile display: an animated GIF when motion is
 * allowed, a static thumbnail under reduced motion, and the normal PFP when
 * assets are missing or cannot be loaded.
 */

import { FC, memo, useEffect, useState } from 'react';

import { fiddy3DAssetUrl, fiddy3DMotionAllowed } from './fiddy3DProfile';

export type Fiddy3DAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xl2';

const SIZE_PIXELS: Record<Fiddy3DAvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 80,
  xl: 120,
  xl2: 160,
};

interface Fiddy3DAvatarProps {
  /** The FID to show 3D assets for. */
  fid: number;
  /** Display name for alt text. */
  displayName: string;
  /** Normal PFP URL to fall back to. */
  fallbackPfpUrl?: string;
  /** Size preset matching Avatar component. */
  size?: Fiddy3DAvatarSize;
  /** Additional CSS classes. */
  className?: string;
  /** Callback when 3D assets fail to load. */
  onError?: () => void;
  /** Callback when 3D assets successfully load. */
  onLoad?: () => void;
}

/** Check that a URL answers with an image rather than an HTML error page. */
const probeImage = async (
  url: string,
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
};

const Fiddy3DAvatar: FC<Fiddy3DAvatarProps> = memo(
  ({
    fid,
    displayName,
    fallbackPfpUrl,
    size = 'xl2',
    className = '',
    onError,
    onLoad,
  }) => {
    const [has3D, setHas3D] = useState(false);
    const [motionAllowed] = useState(() => fiddy3DMotionAllowed());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const targetSize = SIZE_PIXELS[size];
    const gifUrl = fiddy3DAssetUrl(fid, 'turntable.gif');
    const thumbnailUrl = fiddy3DAssetUrl(fid, 'thumbnail.png');

    useEffect(() => {
      const controller = new AbortController();
      let disposed = false;

      setHas3D(false);
      setLoading(true);
      setError(false);

      const checkAssets = async () => {
        const thumbnailExists = await probeImage(
          thumbnailUrl,
          controller.signal,
        );
        if (disposed) {
          return;
        }

        if (!thumbnailExists) {
          setLoading(false);
          return;
        }

        // Reduced motion is decided before this effect starts, so this path
        // never probes or downloads the GIF.
        if (!motionAllowed) {
          setHas3D(true);
          setLoading(false);
          return;
        }

        const gifExists = await probeImage(gifUrl, controller.signal);
        if (disposed) {
          return;
        }
        setHas3D(gifExists);
        setLoading(false);
      };

      void checkAssets();

      return () => {
        disposed = true;
        controller.abort();
      };
    }, [gifUrl, thumbnailUrl, motionAllowed]);

    const handleError = () => {
      setError(true);
      onError?.();
    };

    const show3D = has3D && !loading && !error && motionAllowed;
    const showThumbnail = has3D && !loading && !error && !motionAllowed;
    const showFallback = !show3D && !showThumbnail;
    const showing3D = show3D || showThumbnail;

    return (
      <div
        className={`relative overflow-hidden rounded-full ${className}`}
        style={{ width: targetSize, height: targetSize }}
        role="img"
        aria-label={
          showing3D
            ? `${displayName}'s Fiddy 3D avatar`
            : `${displayName} avatar`
        }
      >
        {show3D && (
          <img
            src={gifUrl}
            alt=""
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
            onError={handleError}
            onLoad={onLoad}
          />
        )}

        {showThumbnail && (
          <img
            src={thumbnailUrl}
            alt=""
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
            onError={handleError}
            onLoad={onLoad}
          />
        )}

        {showFallback && fallbackPfpUrl && (
          <img
            src={fallbackPfpUrl}
            alt={`${displayName} avatar`}
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )}

        {loading && !fallbackPfpUrl && (
          <div
            className="size-full animate-pulse bg-light-purple"
            style={{ width: targetSize, height: targetSize }}
          />
        )}
      </div>
    );
  },
);

Fiddy3DAvatar.displayName = 'Fiddy3DAvatar';

export { Fiddy3DAvatar };
export type { Fiddy3DAvatarProps };
