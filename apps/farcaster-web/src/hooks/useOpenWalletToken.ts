import { ApiChain } from 'farcaster-client-data';
import { useCallback } from 'react';

import { useOptionalEmbeddedWalletBridge } from '~/components/EmbeddedWallet';
import { useMinimizableWindowContext } from '~/contexts/MinimizableWindowProvider';
import { useWallet } from '~/contexts/WalletProvider';
import { walletTradeIntentFromToken } from '~/utils/walletTradeIntent';

type OpenWalletTokenOptions = {
  ca: string;
  chain: ApiChain;
  decimals?: number;
  name?: string;
  symbol?: string;
  via: string;
};

export function useOpenWalletToken() {
  const embeddedWalletBridge = useOptionalEmbeddedWalletBridge();
  const { openWalletTradeIntent } = useMinimizableWindowContext();
  const { preferredWallet } = useWallet();

  return useCallback(
    (token: OpenWalletTokenOptions) => {
      if (preferredWallet !== 'warpcast') {
        const intent = walletTradeIntentFromToken({
          address: token.ca,
          chain: token.chain,
          decimals: token.decimals,
          name: token.name,
          symbol: token.symbol,
        });
        if (!intent) {
          return false;
        }
        openWalletTradeIntent(intent);
        return true;
      }

      if (!embeddedWalletBridge) {
        return false;
      }
      embeddedWalletBridge.navigate({
        path: 'Token',
        params: { chain: token.chain, ca: token.ca, via: token.via },
      });
      return true;
    },
    [embeddedWalletBridge, openWalletTradeIntent, preferredWallet],
  );
}
