import { FC, memo, useMemo } from 'react';
import { QRCode } from 'react-qrcode-logo';

import { isDev } from '~/constants/env';

type LoginQRCodeProps = {
  /** The exact URL the phone should open. */
  url: string;
};

/**
 * The QR itself. It renders whatever URL it is handed and nothing else — the
 * legacy sync-channel version built a `farcaster.xyz/login-web` link in here,
 * which is how it stayed broken after Farcaster removed that flow. Callers now
 * pass a URL they have actually seen work.
 */
const LoginQRCode: FC<LoginQRCodeProps> = memo(({ url }) => {
  const showQRCodeURL = useMemo(() => {
    return isDev;
  }, []);

  return (
    <div className="w-[280px] overflow-hidden rounded-lg">
      <QRCode
        bgColor="#141414"
        ecLevel="H"
        eyeRadius={0}
        fgColor="#ffffff"
        size={260}
        value={url}
      />
      {showQRCodeURL && (
        <div className="mt-4 text-sm">
          <div className="mb-1 text-xs font-semibold text-light">
            (Development Only)
          </div>
          <div className="text-sm text-light">{url}</div>
          <div
            onClick={() => {
              navigator.clipboard.writeText(url);
            }}
            className="mb-1 text-link hover:cursor-pointer hover:underline"
          >
            Copy to clipboard
          </div>
        </div>
      )}
    </div>
  );
});

LoginQRCode.displayName = 'LoginQRCode';

export { LoginQRCode };
