import { CouldNotSignOutError } from 'farcaster-client-hooks';
import { FC, memo, useCallback, useState } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';
import { useAuth } from '~/contexts/AuthProvider';
import { useWalletLocked } from '~/contexts/WalletLockedProvider';
import { trackError } from '~/utils/errorUtils';

/**
 * The one place that actually signs somebody out: a confirmation, then
 * `signOut()`. Several surfaces open it (Settings, and the account menu the
 * avatar opens on every piece of chrome), so it says the same plain thing
 * wherever it came from — "Sign out", not "Log out".
 */

type LogoutModalProps = {
  onClose: () => void;
};

const LogoutModal: FC<LogoutModalProps> = memo(({ onClose }) => {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const { signOut } = useAuth();
  const { lockWallet } = useWalletLocked();

  const handleLogout = useCallback(async () => {
    setIsSigningOut(true);
    try {
      lockWallet();

      await signOut();
    } catch (error) {
      trackError(new CouldNotSignOutError({ error }));
      alert('We could not sign you out.');
      setIsSigningOut(false);
    }
  }, [signOut, lockWallet]);

  return (
    <Modal>
      <DefaultModalContainer onClose={onClose}>
        <div className="flex size-full flex-col items-center justify-center p-4">
          <div
            className="flex w-full max-w-96 flex-col items-start justify-center rounded-lg border p-4 bg-app border-default"
            data-fiddy="sign-out-modal"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <h3 className="mb-2 text-left text-lg font-semibold">Sign out?</h3>
            <p>You’ll need a mobile device with Farcaster to sign back in.</p>
            <div className="mt-4 flex w-full flex-row space-x-2">
              <DefaultButton
                variant="muted"
                className="grow"
                data-fiddy="sign-out-cancel"
                onClick={() => {
                  onClose();
                }}
              >
                Cancel
              </DefaultButton>
              <DefaultButton
                variant="danger"
                className="grow"
                data-fiddy="sign-out-confirm"
                isLoading={isSigningOut}
                onClick={handleLogout}
              >
                Sign out
              </DefaultButton>
            </div>
          </div>
        </div>
      </DefaultModalContainer>
    </Modal>
  );
});

LogoutModal.displayName = 'LogoutModal';

export { LogoutModal };
