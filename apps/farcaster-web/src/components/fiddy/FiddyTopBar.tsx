/**
 * The shell's top chrome: the fiddy mark on the left, and on the right the two
 * things this client refuses to hide — whose node answered (the pill) and who
 * you are (the avatar). Desktop only: phones keep MobileHeader's compact bar.
 *
 * The avatar is a MENU, not a link to the profile. It is where "Sign out" lives
 * now (one press from anywhere in the shell): the card that asked for this is
 * "sign out is unfindable", and the fix is a door every surface carries rather
 * than one page nobody opens. The profile itself is the first item inside that
 * menu, so the old destination is still one press away.
 *
 * The mark is the 3D baby (`FiddyMark3D`): it paints as a still of its own
 * first frame and animates once the model is fetched and drawn, which is why the
 * brand here is a component and not an <img>.
 *
 * The Fiddy balance sits next to that mark, because it is the one number the
 * whole client runs on and the chrome is where somebody looks for it. It is a
 * link to the balance home, and it appears only when there is a balance to
 * show — see `FiddyBalanceChip`.
 */

import { FC, memo, useState } from 'react';

import { AvatarImage } from '~/components/avatar/AvatarImage';
import { FiddyAccountMenu } from '~/components/fiddy/FiddyAccountMenu';
import { FiddyBalanceChipConnected } from '~/components/fiddy/FiddyFunding';
import { FiddyMark3D } from '~/components/fiddy/FiddyMark3D';
import { Link } from '~/components/links/Link';
import { NodeStatusPill } from '~/components/snapchain/NodeStatusPill';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';

const FiddyTopBar: FC = memo(() => {
  const currentUser = useCurrentUser();
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);

  const closeAccountMenu = () => {
    setIsAccountMenuOpen(false);
  };

  return (
    <header className="fiddy-topbar hidden sm:flex" data-fiddy="topbar">
      <Link
        to="homeFeed"
        params={{}}
        searchParams={{}}
        title="fiddy — home feed"
        className="fiddy-brand"
      >
        <FiddyMark3D />
        fiddy
      </Link>
      <div className="fiddy-grow" />
      {/* The balance, beside the mark it belongs to. Renders nothing until
          there is a number, so the chrome never carries a placeholder. */}
      <FiddyBalanceChipConnected />
      <NodeStatusPill
        className="fiddy-node-pill"
        labelClassName="hidden md:inline"
      />
      <button
        type="button"
        className="fiddy-avatar-button"
        data-fiddy="account-menu-button"
        aria-haspopup="menu"
        aria-expanded={isAccountMenuOpen}
        aria-label="Your account"
        title="Your account"
        onClick={() => {
          setIsAccountMenuOpen((prev) => !prev);
        }}
      >
        <AvatarImage
          imgUrl={currentUser.pfp?.url}
          imgAlt={currentUser.displayName || currentUser.username || ''}
          size="sm1"
        />
      </button>
      <FiddyAccountMenu
        className="fiddy-account-menu-topbar"
        isOpen={isAccountMenuOpen}
        onClose={closeAccountMenu}
      />
    </header>
  );
});

FiddyTopBar.displayName = 'FiddyTopBar';

export { FiddyTopBar };
