import { isAllowedProtocol } from 'farcaster-client-data';

import {
  isInsideMiniAppHost,
  loadMiniAppHostSdk,
  type MiniAppHostSdk,
} from '~/lib/miniAppSession';

type OpenExternalUrlOptions = {
  to: string;
  openInNewTab: boolean;
  openInBrowser: (to: string, openInNewTab: boolean) => void;
  loadSdk?: () => Promise<MiniAppHostSdk | undefined>;
};

/** Open an allowed link through a proven host, or keep the browser path. */
const openExternalUrl = async ({
  to,
  openInNewTab,
  openInBrowser,
  loadSdk = loadMiniAppHostSdk,
}: OpenExternalUrlOptions): Promise<void> => {
  if (!isAllowedProtocol(to)) {
    return;
  }
  const sdk = await loadSdk();
  if (sdk && (await isInsideMiniAppHost({ sdk }))) {
    try {
      if (!sdk.actions.openUrl) {
        throw new Error('openUrl is unavailable');
      }
      await sdk.actions.openUrl(to);
      return;
    } catch {
      // A host that cannot open links leaves the ordinary browser path available.
    }
  }
  openInBrowser(to, openInNewTab);
};

export { openExternalUrl };
