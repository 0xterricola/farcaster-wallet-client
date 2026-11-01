/**
 * The picture links a direct message carried, drawn as pictures.
 *
 * WHERE THESE COME FROM
 *
 * `useDirectCastText` splits a message's whitespace-delimited tokens and asks
 * each one what it is (see `~/utils/directCastImageTokens`, and the upstream
 * pattern it follows: quilcast `c7867637607c`). This component draws the result
 * — every picture the message held, in the order it held them — inside the
 * message bubble, above whatever text was left.
 *
 * HONEST WHEN A PICTURE WILL NOT OPEN
 *
 * The classifier answered "this is an image", which is a statement about the
 * bytes behind the URL, not a promise that this browser may load them (a host
 * can refuse a hotlink, or be gone). When the picture does not arrive, the URL
 * is shown as the plain link it is, with a sentence saying so — a frame that
 * never loads is exactly the thing the classifier was brought in to avoid.
 */

import cn from 'classnames';
import React from 'react';

import { Image as ImageRenderer } from '~/components/images/Image';
import { ImageLightboxModal } from '~/components/modals/ImageLightboxModal';

type DirectCastMessageImagesProps = {
  /** Picture links found in the message, in the order they were posted. */
  imageUrls: string[];
  /**
   * Whether one of them is open full screen — the message row uses this to hold
   * its context menu while a picture is being looked at.
   */
  onExpandedStateChange?: (expanded: boolean) => void;
};

const DirectCastMessageImages: React.FC<DirectCastMessageImagesProps> =
  React.memo(({ imageUrls, onExpandedStateChange }) => {
    const [expandedIndex, setExpandedIndex] = React.useState<
      number | undefined
    >(undefined);

    /**
     * URLs that did not load here, named rather than numbered: the same link
     * can appear twice in a message, and one failing says nothing about the
     * other.
     */
    const [failedUrls, setFailedUrls] = React.useState<
      Record<string, true | undefined>
    >({});

    React.useEffect(() => {
      onExpandedStateChange?.(typeof expandedIndex !== 'undefined');
    }, [expandedIndex, onExpandedStateChange]);

    return (
      <div className="flex flex-col gap-1 p-2 pb-0">
        {imageUrls.map((url, index) => {
          if (failedUrls[url] === true) {
            return (
              <span
                key={url}
                className={cn('text-[.85rem] leading-snug text-muted')}
              >
                This picture could not be shown —{' '}
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={cn('break-all underline text-direct-casts-link')}
                >
                  {url}
                </a>
              </span>
            );
          }

          return (
            <button
              key={url}
              type="button"
              className={cn(
                'cursor-zoom-in self-start border-0 bg-transparent p-0',
              )}
              onClick={() => {
                setExpandedIndex(index);
              }}
            >
              <ImageRenderer
                src={url}
                alt="Picture shared in this message"
                className={cn(
                  'max-h-[320px] w-auto max-w-full rounded-lg border object-contain border-default active:opacity-90',
                )}
                onError={() => {
                  setFailedUrls((previous) => ({ ...previous, [url]: true }));
                }}
              />
            </button>
          );
        })}
        {typeof expandedIndex !== 'undefined' && (
          <ImageLightboxModal
            title={'Picture shared in a direct message'}
            imageUrls={imageUrls}
            initialIndex={expandedIndex}
            onClose={() => {
              setExpandedIndex(undefined);
            }}
          />
        )}
      </div>
    );
  });

DirectCastMessageImages.displayName = 'DirectCastMessageImages';

export { DirectCastMessageImages };
