import cn from 'classnames';
import { CastClickType, useTrackCastClick } from 'farcaster-client-hooks';
import React from 'react';

import { ImageLinkCard } from '~/components/attachments/ImageLinkCard';
import { Image } from '~/components/images/Image';

type ImageAttachmentProps = {
  imageUrl: string;
  title: string;
  width: number;
  noBorderOnImage?: boolean;
  quotedCastImageMode?: boolean;
  onClick?: () => void;
};

const ImageAttachment: React.FC<ImageAttachmentProps> = React.memo(
  ({
    imageUrl,
    title,
    noBorderOnImage = false,
    quotedCastImageMode = false,
    width,
    onClick,
  }) => {
    const trackCastClick = useTrackCastClick();

    // Adapted from quilcast `Media` (MIT, backmeupplz/quilcast): a picture
    // that won't load becomes a link card to it instead of a broken frame.
    const [failedImageUrl, setFailedImageUrl] = React.useState<string | null>(
      null,
    );

    // The component is memoized without a key, so a recycled instance can be
    // handed a different image: clear the failure when the URL changes.
    React.useEffect(() => {
      setFailedImageUrl(null);
    }, [imageUrl]);

    if (failedImageUrl !== null) {
      return <ImageLinkCard url={imageUrl} />;
    }

    return (
      <>
        <div
          className="flex w-full flex-row justify-center"
          onClick={(e) => {
            trackCastClick({ type: CastClickType.Image });

            e.stopPropagation();

            if (typeof onClick === 'function') {
              onClick();
            }
          }}
        >
          <Image
            className={cn(
              // min-w-0: flex children default to min-width:auto, which prevents
              // shrinking below intrinsic image size. This must stay here.
              'relative max-h-[318px] min-w-0 max-w-full cursor-pointer object-contain',
              !noBorderOnImage &&
                !quotedCastImageMode &&
                'rounded-lg border border-default',
              quotedCastImageMode && 'rounded-bl-lg rounded-br-lg',
            )}
            width={width}
            src={imageUrl}
            alt={title}
            loading="lazy"
            onFail={setFailedImageUrl}
          />
        </div>
      </>
    );
  },
);

ImageAttachment.displayName = 'ImageAttachment';

export { ImageAttachment };
