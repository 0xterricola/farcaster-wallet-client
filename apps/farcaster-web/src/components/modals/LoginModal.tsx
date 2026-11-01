import { FC, lazy, memo, Suspense, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { Divider2 } from '~/components/Divider';
import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { Link } from '~/components/links/Link';
import { LoginWithMobile } from '~/components/login/LoginWithMobile';
import { SocialSignUpOptions } from '~/components/login/SocialSignUpOptions';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';
import { areSocialSignUpsAvailable } from '~/lib/socialSignUp';

/**
 * The only module that imports Privy, in its own chunk, fetched the first time
 * this modal opens — so the front door never waits for a third-party script a
 * build without an app id will never use (see ~/providers/PrivyRoot).
 */
const SocialSignUpPrivy = lazy(() =>
  import('~/components/login/SocialSignUpPrivy').then((module) => ({
    default: module.SocialSignUpPrivy,
  })),
);

type LoginModalProps = {
  onClose: () => void;
};

/**
 * The way in, with every door in one column.
 *
 * Sign in with Farcaster is the QR handshake: it proves who you are and lets
 * Fiddy *read*. Under it sit the two ways to end up with an account Fiddy can
 * also *post* from, each its own block so neither becomes the only door:
 *
 *   - connecting an account you already have (`routes.fiddyConnect`): one tap,
 *     no fee, no phrase — the posting key is granted in your own Farcaster app,
 *     and you can take it back there;
 *   - making a new account here (`CreateAccountSheet`): a brand-new FID, a
 *     registration fee you pay, and a recovery phrase you write down.
 *
 * They are different products with different trades, so they get different
 * sentences, and neither pretends to be the other.
 */
const LoginModal: FC<LoginModalProps> = memo(({ onClose }) => {
  /**
   * Making an account, from the same door as signing in to one.
   *
   * These are the two halves of "I want to be on Farcaster": one is for people
   * who already have an account, one for people who do not. Putting the second
   * behind the first — or behind a different screen nobody finds — is how a
   * client ends up only usable by people who were already users.
   */
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  /**
   * The two social doors, above the Farcaster handshake rather than in front of
   * it. Signing in with Farcaster is the client's own path and is left exactly
   * as measured; a person who wants the faster way in simply presses the faster
   * way in and ignores the QR that is already being drawn. With no app id
   * configured this whole block is absent — not empty, absent.
   */
  const socialDoors = areSocialSignUpsAvailable();

  if (isCreatingAccount) {
    return <CreateAccountSheet onClose={() => setIsCreatingAccount(false)} />;
  }

  return (
    <Modal>
      <DefaultModalContainer onClose={onClose}>
        <div className="flex size-full flex-col items-center justify-center p-4">
          <div
            className="relative flex max-h-[85dvh] w-full max-w-md flex-col items-start justify-center overflow-y-auto rounded-[12px] bg-[#141414] p-4"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {socialDoors ? (
              <div className="w-full" data-fiddy="login-social">
                {/* A third party may not take the way in down with it.
                    MEASURED (2026-10-22): with an app id configured and Privy's
                    SDK answering with a refusal — a real SDK and an app id the
                    dashboard does not know is enough — the render threw, the
                    nearest boundary was the app's full-screen one, and pressing
                    "Go social" replaced the whole client with "We encountered an
                    unexpected error. Try again": no doors, and no Farcaster
                    sign-in either. So the doors get their own boundary, and it
                    fails to the honest sentence with the other way in still
                    standing below it. */}
                <ErrorBoundary
                  fallbackRender={() => (
                    <SocialSignUpOptions
                      disabled
                      onPress={() => undefined}
                      unavailableNote="Google and X are not answering right now. You can still sign in with Farcaster below."
                    />
                  )}
                >
                  <Suspense
                    fallback={
                      <SocialSignUpOptions
                        disabled
                        onPress={() => undefined}
                        unavailableNote="Getting Google and X ready — one moment."
                      />
                    }
                  >
                    <SocialSignUpPrivy />
                  </Suspense>
                </ErrorBoundary>

                <div className="w-full py-6">
                  <Divider2 text="or use a Farcaster account" />
                </div>
              </div>
            ) : null}

            <LoginWithMobile onClose={onClose} />

            {/* Already on Farcaster: let Fiddy post for you as well as read.
                Its own block and its own page, with a link rather than a mode
                switch, because the approving happens in the person's own
                Farcaster app. */}
            <div
              className="mt-4 w-full border-t border-[#2a2a2a] pt-4 text-center"
              data-fiddy="connect-door"
            >
              <Link
                to="fiddyConnect"
                params={{}}
                searchParams={{}}
                title="Connect your Farcaster account"
                className="text-sm font-semibold text-[#d4ff3f] underline underline-offset-4"
                onClick={onClose}
              >
                Already have an account? Let Fiddy post for you
              </Link>
              <p className="mt-1 text-xs text-[#9ba193]">
                No fee, no passphrase — you approve it in your Farcaster app.
              </p>
            </div>

            <button
              type="button"
              className="fiddy-quiet-btn mt-3 self-center"
              data-fiddy="create-account-entry"
              onClick={() => setIsCreatingAccount(true)}
            >
              New here? Make your Fiddy account
            </button>
          </div>
        </div>
      </DefaultModalContainer>
    </Modal>
  );
});

LoginModal.displayName = 'LoginModal';

export { LoginModal };
