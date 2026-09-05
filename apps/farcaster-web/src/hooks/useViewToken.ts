import { chainIdToChain } from 'farcaster-client-data';
import { useFetchToken } from 'farcaster-client-hooks';
import { useCallback } from 'react';

import { useExternalNavigate } from '~/hooks/navigation/useExternalNavigate';
import { useOpenWalletToken } from '~/hooks/useOpenWalletToken';

const CAIP_19_ERC20_PATTERN = /^eip155:(\d+)\/erc20:(0x[a-fA-F0-9]{40})$/;

const parseToken = (token: string) => {
  const matches = token.match(CAIP_19_ERC20_PATTERN);
  if (!matches) {
    return null;
  }

  const [, chainId, address] = matches;

  const chain = chainIdToChain(chainId);
  if (!chain) {
    return null;
  }

  return {
    chain,
    ca: chain === 'solana' ? address : address.toLowerCase(),
  };
};

export const useViewToken = () => {
  const openUrl = useExternalNavigate();
  const fetchToken = useFetchToken();
  const openWalletToken = useOpenWalletToken();

  return useCallback(
    async ({ url, token }: { url: string; token: string }) => {
      const tokenData = parseToken(token);
      if (!tokenData) {
        openUrl({ to: url, openInNewTab: true });
        return;
      }

      try {
        await fetchToken(tokenData);

        if (
          !openWalletToken({
            ca: tokenData.ca,
            chain: tokenData.chain,
            via: 'miniapp_view_token',
          })
        ) {
          openUrl({ to: url, openInNewTab: true });
        }
      } catch {
        openUrl({ to: url, openInNewTab: true });
      }
    },
    [fetchToken, openUrl, openWalletToken],
  );
};
