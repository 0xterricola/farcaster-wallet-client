import { isAllowedProtocol } from 'farcaster-client-data';
import { useCallback } from 'react';

const useExternalNavigate = () => {
  return useCallback(
    ({ to, openInNewTab }: { to: string; openInNewTab: boolean }) => {
      if (!window.open || !isAllowedProtocol(to)) {
        return;
      }
      const openInBrowser = (url: string, newTab: boolean) => {
        window.open(url, newTab ? '_blank' : '_self', 'noopener');
      };
      // A direct browser keeps the synchronous window.open path. Only a
      // possible host pays for the lazy SDK and host-navigation chunk.
      if (window.parent === window && !('ReactNativeWebView' in window)) {
        openInBrowser(to, openInNewTab);
        return;
      }
      void import('~/lib/miniAppHostOpen')
        .then(({ openExternalUrl }) =>
          openExternalUrl({ to, openInNewTab, openInBrowser }),
        )
        .catch(() => openInBrowser(to, openInNewTab));
    },
    [],
  );
};

export { useExternalNavigate };
