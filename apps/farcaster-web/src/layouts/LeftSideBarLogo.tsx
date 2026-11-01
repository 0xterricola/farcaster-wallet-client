/**
 * The left nav's home link, and the last Farcaster logo that was still in the
 * shell: the fork's purple mark sat here while the top bar had already become
 * the baby Fiddy mark.
 *
 * It is the same character as the top bar's, as the same still the top bar
 * paints first (`~/components/fiddy/fiddyMark`) — deliberately not a second
 * `FiddyMark3D`. The nav mark is not the hero: one animated mark in a shell is
 * the brand, two WebGL contexts drawing the same 148 KB model below the fold is
 * cost with no one watching, and on a phone this nav is hidden while its canvas
 * would keep running anyway.
 */

import { FC, memo } from 'react';

import { FIDDY_MARK_POSTER } from '~/components/fiddy/fiddyMark';
import { LinkToHomeFeed } from '~/components/links/LinkToHomeFeed';
import { LogoBrandContextMenu } from '~/components/LogoBrandContextMenu';
import { useScrollToTopOfRoot } from '~/hooks/useScrollToTopOfRoot';

/** The slot the nav logo has always had (`FilledLogo size="xs"` was 24px). */
const NAV_MARK_SIZE = 24;

type LeftSideBarLogoProps = {
  title: string;
};

const LeftSideBarLogo: FC<LeftSideBarLogoProps> = memo(({ title }) => {
  const scrollToTopOfRoot = useScrollToTopOfRoot();

  return (
    <LogoBrandContextMenu>
      <LinkToHomeFeed
        title={title}
        className="mx-1 flex items-center "
        onClick={() => {
          scrollToTopOfRoot();
        }}
      >
        <div className="flex h-14 flex-col items-center justify-center md:items-start">
          <img
            className="fiddy-nav-mark"
            src={FIDDY_MARK_POSTER}
            alt=""
            width={NAV_MARK_SIZE}
            height={NAV_MARK_SIZE}
            decoding="async"
          />
        </div>
      </LinkToHomeFeed>
    </LogoBrandContextMenu>
  );
});

LeftSideBarLogo.displayName = 'LeftSideBarLogo';

export { LeftSideBarLogo };
