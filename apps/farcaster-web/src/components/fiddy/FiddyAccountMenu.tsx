/**
 * The account menu: who you are, and the way out of the account.
 *
 * Sign out used to live in exactly one place — inside Settings — and the person
 * who reported it could not find it even there. So the avatar itself is the
 * door, in every piece of chrome that carries one: the desktop top bar, the
 * phone's header, and the phone's "You" tab. This panel is what it opens.
 *
 * The rule the card asks for is why the ORDER is what it is: "Sign out" is the
 * last thing in a panel short enough to be on screen without scrolling, in
 * plain words, in the danger colour, one press from anywhere in the shell. A
 * mis-tap does not sign anybody out — the press opens the same confirm dialog
 * Settings has always used (`LogoutModal`), and that dialog is the only thing
 * that calls `signOut()`.
 *
 * WHY IT IS ALWAYS MOUNTED, AND WHY PRESSING "SIGN OUT" CLOSES THE PANEL: the
 * confirmation takes over the screen, so the panel and the click-catching
 * backdrop that belongs to it must be gone by the time the dialog is up — a
 * backdrop left behind would sit over the dialog and eat the taps meant for it.
 * That is why the panel is driven by `isOpen` from the chrome while the dialog
 * is this component's own state: if the whole component unmounted with the
 * panel, it would take the dialog down with it.
 *
 * Placement is the opener's business, not this component's: each mount point
 * passes the class that anchors the panel to its own chrome (see the
 * `fiddy-account-menu-*` rules in `~/styles/fiddy-shell.css`).
 */

import classNames from 'classnames';
import {
  LogOut,
  Settings as SettingsIcon,
  User as UserIcon,
} from 'lucide-react';
import { FC, memo, useCallback, useState } from 'react';

import { AvatarImage } from '~/components/avatar/AvatarImage';
import { Link } from '~/components/links/Link';
import { LogoutModal } from '~/components/modals/LogoutModal';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useCurrentUserProfileCastsLinkProps } from '~/hooks/navigation/useCurrentUserProfileCastsLinkProps';

type FiddyAccountMenuProps = {
  /** The class that anchors this panel to the chrome that opens it. */
  className?: string;
  isOpen: boolean;
  onClose: () => void;
};

const FiddyAccountMenu: FC<FiddyAccountMenuProps> = memo(
  ({ className, isOpen, onClose }) => {
    const currentUser = useCurrentUser();
    const profileLinkProps = useCurrentUserProfileCastsLinkProps({
      title: 'Profile',
    });
    const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false);

    const name = currentUser.displayName || currentUser.username || 'You';

    // One press on "Sign out" is a request, not the act: the panel gives way to
    // the confirmation, which is the only thing that can sign anybody out.
    const requestSignOut = useCallback(() => {
      setIsSignOutConfirmOpen(true);
      onClose();
    }, [onClose]);

    const cancelSignOut = useCallback(() => {
      setIsSignOutConfirmOpen(false);
    }, []);

    return (
      <>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div
              className={classNames('fiddy-account-menu', className)}
              data-fiddy="account-menu"
              role="menu"
              aria-label="Your account"
            >
              <div
                className="fiddy-account-menu-identity"
                data-fiddy="account-menu-identity"
              >
                <AvatarImage
                  imgUrl={currentUser.pfp?.url}
                  imgAlt={name}
                  size="sm1"
                />
                <span className="fiddy-account-menu-who">
                  <span className="fiddy-account-menu-name">{name}</span>
                  {currentUser.username && (
                    <span className="fiddy-account-menu-handle">
                      @{currentUser.username}
                    </span>
                  )}
                </span>
              </div>

              <Link
                {...profileLinkProps}
                className="fiddy-account-menu-item"
                onClick={onClose}
              >
                <UserIcon size={16} aria-hidden="true" />
                <span>Profile</span>
              </Link>

              <Link
                to="settings"
                params={{}}
                searchParams={{}}
                title="Settings"
                className="fiddy-account-menu-item"
                onClick={onClose}
              >
                <SettingsIcon size={16} aria-hidden="true" />
                <span>Settings</span>
              </Link>

              <div className="fiddy-account-menu-sep" aria-hidden="true" />

              {/* Plain words, and the one destructive thing in here. */}
              <button
                type="button"
                className="fiddy-account-menu-item fiddy-account-menu-signout"
                data-fiddy="account-menu-sign-out"
                onClick={requestSignOut}
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          </>
        )}

        {isSignOutConfirmOpen && <LogoutModal onClose={cancelSignOut} />}
      </>
    );
  },
);

FiddyAccountMenu.displayName = 'FiddyAccountMenu';

export { FiddyAccountMenu };
