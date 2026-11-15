import {
  DetailedHTMLProps,
  FC,
  ImgHTMLAttributes,
  memo,
  useCallback,
  useState,
} from 'react';

import { proxiedExternalMediaUrl } from '~/utils/externalMediaUrl';

export type ImageProps = DetailedHTMLProps<
  ImgHTMLAttributes<{}>,
  HTMLImageElement
> & {
  alt: string;
  fallback?: string;
  /**
   * Called once with the `src` that failed when there is nothing left to
   * try — no `fallback`, or the `fallback` itself failed too. Lets callers
   * swap the dead picture for a link out instead of a broken frame.
   */
  onFail?: (failedSrc: string) => void;
  src: string;
  /**
   * When true, sets fetchpriority="high" and loading="eager"
   * for LCP-critical images. Use sparingly on above-the-fold images only.
   */
  priority?: boolean;
};

const Image: FC<ImageProps> = memo(
  ({
    fallback,
    src,
    loading = 'lazy',
    priority,
    onFail,
    onError,
    ...props
  }) => {
    const [didFailToLoadMap, setDidFailToLoadMap] = useState<
      Record<string, boolean | undefined>
    >({});

    const requestedSrc = didFailToLoadMap[src] && fallback ? fallback : src;
    const resolvedSrc = proxiedExternalMediaUrl(requestedSrc);

    const wrappedOnError = useCallback<
      React.ReactEventHandler<HTMLImageElement>
    >(
      (event) => {
        const hadAlreadyFailed = didFailToLoadMap[src] === true;
        setDidFailToLoadMap((prevMap) => ({ ...prevMap, [src]: true }));

        // Terminal failure: nothing left to try (no fallback, or the
        // fallback itself just failed too) — report the URL so callers can
        // offer a link out instead of a broken frame.
        if (!fallback || hadAlreadyFailed) {
          onFail?.(src);
        }

        onError?.(event);
      },
      [didFailToLoadMap, fallback, onFail, onError, src],
    );

    const imageLoading = priority ? 'eager' : loading;
    const imageFetchPriority = priority ? 'high' : undefined;

    return (
      <img
        loading={imageLoading}
        fetchPriority={imageFetchPriority}
        src={resolvedSrc}
        onError={wrappedOnError}
        {...props}
      />
    );
  },
);

Image.displayName = 'Image';

export { Image };
