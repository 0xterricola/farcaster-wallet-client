import classNames from 'classnames';
import {
  ApiCastImageEmbed,
  ApiCastVideoEmbed,
  ApiMediaV2,
  ApiQuoteCastEmbed,
} from 'farcaster-client-data';
import {
  CastClickType,
  ClientProcessedMedia,
  getCastSnap,
  processMediasForRendering,
  useHydratedQuoteCast,
  usePrefetchThread,
  useTrackCastClick,
} from 'farcaster-client-hooks';
import { PlayIcon } from 'lucide-react';
import { FC, memo, useCallback, useMemo } from 'react';

import {
  matchSpaceUrl,
  SpaceEmbedAttachment,
} from '~/components/attachments/SpaceEmbedAttachment';
import { Avatar } from '~/components/avatar/Avatar';
import { CastAuthorLine } from '~/components/casts/CastAuthorLine';
import { Image } from '~/components/images/Image';
import { LinkToConversationWithoutUsername } from '~/components/links/LinkToConversationWithoutUsername';
import { useUserAppContext } from '~/contexts/UserAppContextProvider';
import { mutedAuthorInUse, mutedWordInUse } from '~/snapchain/mutePreferences';
import { useActiveMutes } from '~/snapchain/useMutePreferences';

import { SnapEmbedAttachment } from './SnapEmbedAttachment';

interface QuoteCastProps {
  cast: ApiQuoteCastEmbed;
  disabled?: boolean;
  skipBorderStyles?: boolean;
  variant?: 'direct-cast' | 'default';
}

const QuoteCast: FC<QuoteCastProps> = memo(
  ({
    cast,
    disabled = false,
    skipBorderStyles = false,
    variant = 'default',
  }) => {
    const trackCastClick = useTrackCastClick();
    const prefetchThread = usePrefetchThread();
    const hydratedCast = useHydratedQuoteCast({ cast });

    const { regularCastByteLimit } = useUserAppContext();

    /**
     * Where this card's overlay goes: the quoted cast's own page, by full hash.
     * A quote of a cast this app holds carries the whole hash, so it does not
     * need — and must not use — the `/<handle>/<0x prefix>` route, which the
     * node-backed client cannot read (card t_5068bb26).
     */
    const params = useMemo(() => ({ castHash: cast.hash }), [cast.hash]);

    const quotedCastImageEmbeds = useMemo(() => {
      return hydratedCast.embeds?.images || [];
    }, [hydratedCast.embeds?.images]);

    const quotedCastVideoEmbeds = useMemo(() => {
      return hydratedCast.embeds?.videos || [];
    }, [hydratedCast.embeds?.videos]);

    const quotedCastFrameEmbeds = useMemo(() => {
      return (hydratedCast.embeds?.urls || []).filter(
        (url) => url.openGraph.frame !== undefined,
      );
    }, [hydratedCast.embeds?.urls]);

    const quotedCastSpaceEmbedUrls = useMemo(() => {
      return (hydratedCast.embeds?.urls || [])
        .map((urlEmbed) => urlEmbed.openGraph.url)
        .filter((url) => !!matchSpaceUrl(url));
    }, [hydratedCast.embeds?.urls]);

    // Prefers the new `embeds.snap` bucket (NEYN-10425), falls back to
    // walking `embeds.urls` for responses still on the legacy shape.
    const quotedCastSnap = useMemo(
      () => getCastSnap(hydratedCast.embeds),
      [hydratedCast.embeds],
    );

    const quotedCastGroupInviteEmbeds = useMemo(() => {
      return hydratedCast.embeds?.groupInvites || [];
    }, [hydratedCast.embeds?.groupInvites]);

    const quotedCastText = useMemo(() => {
      const urls = hydratedCast.embeds?.urls || [];

      const urlEmbeds = urls.map((url) => url.openGraph.url) || [];

      let castText = hydratedCast.text;

      for (const url of urlEmbeds) {
        if (castText.endsWith(url)) {
          castText = castText.replace(url, '').trimEnd();
        }
      }

      const urlEmbedsWithoutInlineEmbeds = urlEmbeds.filter(
        (url) =>
          !quotedCastFrameEmbeds.some((f) => f.openGraph.url === url) &&
          !quotedCastSpaceEmbedUrls.includes(url) &&
          // Strip the snap's source URL from the text so we don't render
          // both the snap card and a stray link to the same page.
          quotedCastSnap?.sourceUrl !== url,
      );

      const formattedUrlEmbeds = urlEmbedsWithoutInlineEmbeds.map((url) =>
        url.length > 30 ? `${url.substring(0, 27)}...` : url,
      );

      castText = [castText, ...formattedUrlEmbeds]
        .filter(
          (castText) => typeof castText !== 'undefined' && castText !== '',
        )
        .join(' ');

      return castText;
    }, [
      hydratedCast.embeds?.urls,
      hydratedCast.text,
      quotedCastFrameEmbeds,
      quotedCastSnap,
      quotedCastSpaceEmbedUrls,
    ]);

    const truncatedQuotedCastText = useMemo(() => {
      if (quotedCastText.length <= regularCastByteLimit) {
        return quotedCastText;
      }

      return quotedCastText.slice(0, regularCastByteLimit);
    }, [quotedCastText, regularCastByteLimit]);

    const shouldShowShowMoreIndicator = useMemo(() => {
      return (
        quotedCastImageEmbeds.length === 0 &&
        quotedCastVideoEmbeds.length === 0 &&
        quotedCastFrameEmbeds.length === 0 &&
        quotedCastGroupInviteEmbeds.length === 0 &&
        quotedCastSpaceEmbedUrls.length === 0 &&
        !quotedCastSnap &&
        truncatedQuotedCastText === ''
      );
    }, [
      quotedCastImageEmbeds.length,
      quotedCastVideoEmbeds.length,
      quotedCastFrameEmbeds.length,
      quotedCastSnap,
      truncatedQuotedCastText,
      quotedCastGroupInviteEmbeds.length,
      quotedCastSpaceEmbedUrls.length,
    ]);

    const optimisticallyPrefetchQuoteCast = useCallback(() => {
      prefetchThread({
        castHash: cast.hash,
        shouldAvoidUpdatingGlobalCache: true,
      });
    }, [cast.hash, prefetchThread]);

    /**
     * A quote of somebody this reader hides is REPLACED, not left blank: a hole
     * where a card should be reads as a bug, while the sentence names the
     * reader's own decision. `mutes` is the subscription, so a mute saved a
     * moment ago redraws this card.
     *
     * This is the only place a mute is honoured inside a conversation, and
     * deliberately so: the quote is part of THIS cast's own body, not a second
     * item in the view. A conversation itself stays whole (see `reads.ts`).
     */
    const mutes = useActiveMutes();
    // Recomputed on every render on purpose: it is two small array scans and one
    // regex test, and `mutes` is the subscription that redraws this card when
    // the reader hides somebody — a memo would only fight the hook.
    const hiddenByMutes =
      mutes !== null &&
      (mutedAuthorInUse(cast.author?.fid) || mutedWordInUse(cast.text));

    if (hiddenByMutes) {
      return (
        <div
          className={classNames(
            'relative flex w-full flex-col pt-2',
            disabled && 'mt-2',
          )}
        >
          <div
            className={classNames(
              'px-3 py-2 text-faint',
              !skipBorderStyles &&
                'rounded-[12px] border bg-[#00000005] border-default dark:bg-[#ffffff05]',
            )}
            data-fiddy="quote-hidden-by-mutes"
          >
            Hidden by your mutes.
          </div>
        </div>
      );
    }

    return (
      <div
        className={classNames(
          'relative flex w-full flex-col pt-2',
          disabled && 'mt-2',
          !skipBorderStyles &&
            'rounded-[12px] border border-default hover:bg-[#0000000d] dark:hover:bg-[#ffffff0d]',
        )}
        onMouseOver={optimisticallyPrefetchQuoteCast}
      >
        <div className="flex flex-row items-center space-x-1 px-3">
          <Avatar
            user={cast.author}
            size="xs"
            className="relative h-[24px] shrink-0"
            withDetailsPopover={true}
          />
          <div className="flex min-w-0 flex-1 shrink">
            <CastAuthorLine cast={cast} showChannel variant={variant} />
          </div>
        </div>
        <div
          className={classNames(
            'mt-2 line-clamp-5 px-3 text-base leading-5 tracking-normal break-gracefully',
            shouldShowShowMoreIndicator ? 'text-faint' : 'text-default',
            quotedCastImageEmbeds.length === 0 &&
              quotedCastVideoEmbeds.filter((ve) => ve.height && ve.width)
                .length === 0 &&
              quotedCastSpaceEmbedUrls.length === 0 &&
              'pb-3',
          )}
        >
          <div className="line-clamp-5">
            {shouldShowShowMoreIndicator
              ? 'Show more...'
              : truncatedQuotedCastText}
          </div>
        </div>
        {(quotedCastImageEmbeds.length !== 0 ||
          quotedCastVideoEmbeds.length !== 0) && (
          <div className="scrollbar-hide m-3 flex flex-row gap-2 overflow-x-auto">
            {quotedCastVideoEmbeds.map((video, index) => (
              <QuoteCastVideoEmbed key={index} video={video} />
            ))}
            <QuoteCastImageEmbeds images={quotedCastImageEmbeds} />
          </div>
        )}
        {!disabled && (
          <LinkToConversationWithoutUsername
            className="absolute inset-0"
            params={params}
            title={''}
            onClick={() => {
              trackCastClick({ type: CastClickType.QuotedCast });
            }}
          />
        )}
        {quotedCastSnap && (
          // Rendered after the navigation overlay so source-order stacks
          // the snap above it; stopPropagation blocks clicks from bubbling
          // to the overlay's click handler.
          <div className="relative px-3 pb-3">
            <SnapEmbedAttachment
              snap={quotedCastSnap}
              cast={cast}
              enableLiftOnInteraction={true}
            />
          </div>
        )}
        {quotedCastSpaceEmbedUrls.length > 0 && (
          <div className="relative flex w-full flex-col gap-2 px-3 pb-3">
            {quotedCastSpaceEmbedUrls.map((spaceUrl) => (
              <SpaceEmbedAttachment key={spaceUrl} url={spaceUrl} />
            ))}
          </div>
        )}
      </div>
    );
  },
);

function QuoteCastVideoEmbed({ video }: { video: ApiCastVideoEmbed }) {
  return (
    <div className="relative size-32">
      <Image
        src={video.thumbnailUrl || ''}
        alt={'quote video'}
        width={128}
        height={128}
        className="aspect-square content-center rounded-[12px] border object-cover border-default"
      />
      <div className="absolute inset-0 flex size-full flex-col items-center justify-center">
        <div
          className={
            'flex size-12 flex-row items-center justify-center rounded-full bg-black/75'
          }
        >
          <PlayIcon className="text-light" />
        </div>
      </div>
    </div>
  );
}

function QuoteCastImageEmbeds({ images }: { images: ApiCastImageEmbed[] }) {
  const mediaImageEmbeds = images.map((image) => {
    if (typeof image.media !== 'undefined') {
      return image.media as ApiMediaV2;
    }

    return {
      version: '2',
      staticRaster: image.url,
      height: 1000,
      width: 1000,
    } satisfies ApiMediaV2;
  });

  const imagesToRender = processMediasForRendering({
    medias: mediaImageEmbeds,
    pixelDensity: 3,
    blockAnimated: false,
    useLowQualityImages: false,
  });

  return imagesToRender.map((image, index) => (
    <QuoteCastImageEmbed key={index} image={image} />
  ));
}

function QuoteCastImageEmbed({ image }: { image: ClientProcessedMedia }) {
  return (
    <div className="relative size-32">
      <Image
        src={image.thumbnail}
        alt={'quote image'}
        width={128}
        height={128}
        className="aspect-square content-center rounded-[12px] border object-cover border-default"
      />
    </div>
  );
}

QuoteCast.displayName = 'QuoteCast';

export { QuoteCast };
