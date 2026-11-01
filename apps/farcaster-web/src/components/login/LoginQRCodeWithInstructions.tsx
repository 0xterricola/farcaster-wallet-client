import classNames from 'classnames';
import { AnalyticsEvent } from 'farcaster-analytics';
import { FC, memo, useCallback, useState } from 'react';

import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { LoginQRCode } from '~/lazy/components';
import { isMobile } from '~/utils/navigatorUtils';

type LoginQRCodeWithInstructionsProps = {
  /** The SIWF relay URL — the thing the phone actually opens. */
  url: string;
  onClose: () => void;
  /** True once the phone has approved and we are finalising the session. */
  attemptingLogin: boolean;
  /** Shown under the code when the scan drags, before the hard timeout. */
  slow?: boolean;
};

/**
 * The way in, arranged for the device the person is actually holding.
 *
 * WHAT WAS WRONG WITH ONLY SHOWING A QR CODE
 * The code is scanned BY a phone. On a phone the page displaying it is that
 * same phone — you cannot point the camera at your own screen. So the one
 * device that cannot use the QR is the one most people are holding when they
 * tap a link to fiddy.fun.
 *
 * WHAT CHANGED, AND WHAT IT RESTS ON
 * The exact URL the QR encodes (`https://farcaster.xyz/~/siwf?channelToken=…`,
 * as the relay answers today — MEASURED 2026-10-21) is ALSO a link into the
 * Farcaster app on both platforms, because farcaster.xyz publishes the
 * app-link files:
 *
 *   - iOS: `https://farcaster.xyz/.well-known/apple-app-site-association`
 *     lists `V9B5DUDJ36.com.farcaster.mobile-client` with path `*`, excluding
 *     only `/~/register`, `/~/code/*`, `/~/download`, `/~/r/*`,
 *     `/referralCode/*` and `/magic-link` — so `/~/siwf` is an app link.
 *   - Android: `https://farcaster.xyz/.well-known/assetlinks.json` grants
 *     `delegate_permission/common.handle_all_urls` to `com.farcaster.mobile`.
 *
 * On a phone this screen therefore leads with a plain `<a href>` to that URL:
 * the tap opens Farcaster on its own sign-in request, and the page left behind
 * is still polling the relay channel the URL was made from — it completes by
 * itself, exactly as it does after a scan.
 *
 * WHAT IT DOES NOT PROMISE
 * That the Farcaster app is installed on that phone, or that the tap lands in
 * the app rather than on farcaster.xyz in the same browser. The relay poll
 * behind the button is identical either way, and the code is one tap away
 * behind the toggle for anyone who would rather scan it.
 *
 * On a desktop nothing is taken away: the code is still the first thing on
 * screen, because there it works.
 */
const LoginQRCodeWithInstructions: FC<LoginQRCodeWithInstructionsProps> = memo(
  ({ url, onClose, attemptingLogin, slow }) => {
    const { trackEvent } = useAnalytics();
    const onAPhone = isMobile();

    // On a phone the code is behind the toggle; on anything else it IS the
    // screen, as it has always been.
    const [showQRCode, setShowQRCode] = useState(!onAPhone);

    const onClickOpenInFarcaster = useCallback(() => {
      trackEvent(AnalyticsEvent.ClickedOpenInFarcasterApp, {
        platform: onAPhone ? 'phone' : 'other',
      });
    }, [onAPhone, trackEvent]);

    return (
      <>
        <div className="flex flex-col space-y-3 p-8 sm:items-start">
          {onAPhone && !showQRCode ? null : (
            <div className="flex w-full flex-row justify-around">
              <div
                className={classNames(
                  'relative mt-2 flex justify-around sm:mt-0',
                  attemptingLogin && 'animate-pulse',
                )}
              >
                <LoginQRCode url={url} />
              </div>
            </div>
          )}

          {onAPhone ? (
            <a
              className="flex w-full cursor-pointer items-center justify-center rounded-[300px] bg-[#d4ff3f] px-[36px] py-[14px]"
              data-fiddy="open-in-farcaster"
              href={url}
              onClick={onClickOpenInFarcaster}
              rel="noreferrer"
            >
              <span className="text-center text-[16px] font-semibold text-[#141414]">
                {attemptingLogin
                  ? 'Approved — finishing up…'
                  : 'Open in Farcaster on this phone'}
              </span>
            </a>
          ) : null}

          <h3 className="font-seasonMix text-3xl font-semibold text-light">
            {attemptingLogin ? 'Signing you in' : 'Log in with mobile'}
          </h3>

          <div className="text-light">
            {attemptingLogin
              ? 'Approved on your phone — finishing up here.'
              : onAPhone && !showQRCode
                ? 'One tap: Farcaster opens with this sign-in request, you approve it there, and this page finishes on its own.'
                : 'Open the Farcaster app on your phone and scan this code, or scan it with your Camera app.'}
          </div>

          {onAPhone && !showQRCode ? (
            <button
              type="button"
              className="text-left text-sm underline underline-offset-4 text-link"
              data-fiddy="show-qr-code"
              onClick={() => setShowQRCode(true)}
            >
              Show QR code for another device
            </button>
          ) : null}

          {slow && !attemptingLogin ? (
            <div className="text-sm text-muted">
              Still waiting. Make sure the Farcaster app is the app that opened,
              then approve the request there.
            </div>
          ) : null}

          <div
            className="landing-btn-secondary-bg flex w-full cursor-pointer items-center justify-center rounded-[300px] px-[36px] py-[10px]"
            onClick={onClose}
          >
            <div className="text-[16px] text-light">Cancel</div>
          </div>
        </div>
      </>
    );
  },
);

LoginQRCodeWithInstructions.displayName = 'LoginQRCodeWithInstructions';

export { LoginQRCodeWithInstructions };
