import { ApiOpenGraphMetadata } from 'farcaster-client-data';
import { FC, memo } from 'react';

import { Image } from '~/components/images/Image';
import { ExternalLink } from '~/components/links/ExternalLink';
import { getOpenGraphFallbackImageUrl } from '~/utils/openGraphUtils';

interface FauxQuoteCastProps {
  og: ApiOpenGraphMetadata;
}

/**
 * A quoted cast this client only knows as a LINK: the embed was a
 * `warpcast.com/<handle>/<0x prefix>` URL, and all the client holds is the
 * page's own metadata — a title, a description, and the URL itself.
 *
 * The overlay used to point at this app's own `/<handle>/<0x prefix>` route,
 * and it still does the work of looking like it: a card you can tap that names
 * a cast. But that route resolves its cast through `/v2/user-cast`, and a
 * Snapchain node shards by FID — it cannot answer a hash prefix at all, and
 * neither can this client resolve the prefix to a full hash from the
 * metadata it holds (measured on the live build, cards t_5068bb26 +
 * t_fb198c05: the tap landed on "This page isn't on your node"). The hover
 * prefetch of that read 501'd the same way, for nothing.
 *
 * So the card's tap goes to the one URL that CAN open the quoted cast: the
 * `og.url` the embed itself carries, in a new tab. That is not a degradation
 * of something that worked — it is the first honest destination this card has
 * had. (A cast this client CAN read arrives as a real quote embed instead and
 * never renders this component; see `QuoteCast.tsx`.)
 */
const FauxQuoteCast: FC<FauxQuoteCastProps> = memo(({ og }) => (
  <div className="flex w-full flex-col rounded-lg border p-3 pt-2 border-faint">
    <ExternalLink
      className="absolute inset-0"
      href={og.url}
      title={og.title ?? og.url}
    />
    <div className="flex flex-row items-center">
      <Image
        alt="og"
        className="mr-1 size-5 rounded-md"
        src={getOpenGraphFallbackImageUrl({
          assetName: 'Farcaster',
          assetExtension: 'webp',
        })}
      />
      <div className="max-w-sm truncate text-sm">
        {og.title?.indexOf('Farcaster') !== -1
          ? og.title?.split('on Farcaster')[0]
          : og.title?.split('on Warpcast')[0]}
      </div>
    </div>
    <div className="mt-1 text-sm break-gracefully text-faint">
      {og.description}
    </div>
  </div>
));

FauxQuoteCast.displayName = 'FauxQuoteCast';

export { FauxQuoteCast };
