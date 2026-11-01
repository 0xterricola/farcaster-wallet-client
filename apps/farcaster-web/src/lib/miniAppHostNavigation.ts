// Host navigation technique adapted from backmeupplz/quilcast commit
// d0a87cce7fd7 (MIT): https://github.com/backmeupplz/quilcast/commit/d0a87cce7fd7
import type { MiniAppHostSdk } from '~/lib/miniAppSession';

/** Let the Farcaster client's own back gesture walk this app's history. */
const enableMiniAppHostNavigation = async ({
  sdk,
}: {
  sdk: MiniAppHostSdk;
}): Promise<boolean> => {
  try {
    await sdk.back?.enableWebNavigation();
    return true;
  } catch {
    // A host without web navigation must not break the client.
    return false;
  }
};

export { enableMiniAppHostNavigation };
