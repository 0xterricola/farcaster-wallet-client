import { AnalyticsEvent } from 'farcaster-analytics';
import {
  ApiOnchainTokenMinimal,
  ApiOnchainTransactionSwapEmbed,
} from 'farcaster-client-data';
import React, { useCallback } from 'react';

import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useWalletGeoRestricted } from '~/hooks/data/useWalletGeoRestricted';
import { useExternalNavigate } from '~/hooks/navigation/useExternalNavigate';
import { useOpenWalletToken } from '~/hooks/useOpenWalletToken';

import { TokenFIP2CardContent } from './TokenFIP2Card';

function PressableTokenFIP2Card({
  token,
  tx,
}: {
  token: ApiOnchainTokenMinimal;
  tx: ApiOnchainTransactionSwapEmbed | undefined;
}) {
  const navigate = useExternalNavigate();
  const openWalletToken = useOpenWalletToken();
  const isGeoRestricted = useWalletGeoRestricted();

  const { trackEvent } = useAnalytics();

  const onTokenFIP2Press = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();

      trackEvent(AnalyticsEvent.PressFIP2TokenEmbed, {
        ca: token.ca,
        chain: token.chain,
      });

      if (
        !isGeoRestricted &&
        openWalletToken({
          ca: token.ca,
          chain: token.chain,
          decimals: token.decimals,
          name: token.name,
          symbol: token.symbol,
          via: 'fip2-embed',
        })
      ) {
        return;
      }
      const url = `https://dexscreener.com/${token.chain}/${token.ca}`;
      navigate({ to: url, openInNewTab: true });
    },
    [
      navigate,
      openWalletToken,
      isGeoRestricted,
      token.ca,
      token.chain,
      token.decimals,
      token.name,
      token.symbol,
      trackEvent,
    ],
  );

  return (
    <div
      className="relative w-full cursor-pointer rounded-[12px]"
      onClick={onTokenFIP2Press}
    >
      <TokenFIP2CardContent
        token={token}
        tx={tx}
        tokenCardOnDismiss={undefined}
      />
    </div>
  );
}

export { PressableTokenFIP2Card };
