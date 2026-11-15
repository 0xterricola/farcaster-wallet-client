// Adapted from quilcast `src/ui.tsx` `ImgLink` / `Media` (MIT,
// backmeupplz/quilcast): a picture that couldn't be shown becomes a link to
// it — its host and file name — instead of leaving a broken frame with
// nothing to tap.
//
// Fiddy twist: we link out only over plain https (upstream additionally
// suppresses navigation for look-alike Unicode hosts via `lookalike(u)`; we
// don't ship that warning yet — wire the confirmation here once the
// look-alike host card lands).

import { FC, memo } from 'react';

import { FrameImageIcon } from '~/components/icons/FrameImageIcon';

const IMAGE_LINK_CARD_LABEL = "Image couldn't load";
const MAX_PATH_SEGMENT_LENGTH = 40;

type ImageLinkCardProps = {
  /** Raw (non-proxied) media URL to link out to. */
  url: string;
};

const truncateMiddle = (value: string): string => {
  if (value.length <= MAX_PATH_SEGMENT_LENGTH) {
    return value;
  }
  const keep = MAX_PATH_SEGMENT_LENGTH - 1;
  const head = value.slice(0, Math.ceil(keep / 2));
  const tail = value.slice(-Math.floor(keep / 2));
  return `${head}…${tail}`;
};

const lastPathSegment = (pathname: string): string => {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  if (!last) {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

type DescribedUrl = {
  hostname: string;
  pathSegment: string;
};

const describeUrl = (url: string): DescribedUrl | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return {
      hostname: parsed.hostname.replace(/^www\./, ''),
      pathSegment: lastPathSegment(parsed.pathname),
    };
  } catch {
    return null;
  }
};

const ImageLinkCard: FC<ImageLinkCardProps> = memo(({ url }) => {
  const described = describeUrl(url);

  // A URL we can't safely link out to still shows as a card (never a blank
  // frame), just without navigation.
  if (!described) {
    return (
      <div
        aria-label={IMAGE_LINK_CARD_LABEL}
        className="flex w-full max-w-full select-none items-center gap-2 rounded-[12px] border px-3 py-2 text-sm text-secondary bg-elevated border-default"
        onClick={(e) => e.stopPropagation()}
      >
        <FrameImageIcon size={16} />
        <span className="min-w-0 truncate">
          {IMAGE_LINK_CARD_LABEL} · {truncateMiddle(url)}
        </span>
      </div>
    );
  }

  const { hostname, pathSegment } = described;

  return (
    <a
      aria-label={`${IMAGE_LINK_CARD_LABEL} — ${hostname}`}
      className="flex w-full max-w-full select-none items-center gap-2 rounded-[12px] border px-3 py-2 text-sm no-underline bg-elevated border-default"
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => {
        // Tapping the card must not open the cast around it.
        e.stopPropagation();
      }}
    >
      <FrameImageIcon size={16} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{hostname}</span>
        {pathSegment && (
          <span className="text-secondary">
            {' '}
            · {truncateMiddle(pathSegment)}
          </span>
        )}
      </span>
    </a>
  );
});

ImageLinkCard.displayName = 'ImageLinkCard';

export { IMAGE_LINK_CARD_LABEL, ImageLinkCard };
