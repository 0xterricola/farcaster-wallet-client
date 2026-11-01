import { MiniAppHost } from '@farcaster/miniapp-core';

/**
 * The wallet channel an older mini app SDK reaches for.
 *
 * A mini app can ask for the reader's wallet along two wires. The current one
 * is the host's own provider channel: `@farcaster/miniapp-host` builds
 * `ethProviderRequestV2` itself out of the `ethProvider` the host hands it, so
 * a wallet request never travels through this client's SDK object at all. The
 * older one is `sdk.ethProviderRequest` — the wire the SDK used before V2, and
 * the reason `getCapabilities` still declares `wallet.getEvmProvider` and
 * `wallet.getEthereumProvider` at all.
 *
 * That older wire used to answer `Error('not implemented')`, which is not a
 * refusal, it is a lie: this host declares the capability, the reader does have
 * a wallet connected, and the app's wallet button simply died with a message
 * nothing could act on. So the channel forwards to the same instrumented
 * provider the new wire uses — the one that already re-asks for accounts when
 * the wallet answers `UnauthorizedError`.
 *
 * The provider is reached through a getter because of render order: the SDK
 * object is built above the wallet in `MiniApp.tsx`, so a captured value would
 * be the one from the render that had no provider yet. The ref behind the
 * getter is filled as soon as the wallet is instrumented, during render, so a
 * mini app that asks for the wallet the instant it loads finds it.
 *
 * With no wallet in the session this throws a sentence that says so. That is
 * the honest half of the same rule: a refusal a mini app can read and show,
 * never a dead button.
 */
export type LegacyWalletRequest = Parameters<
  MiniAppHost['ethProviderRequest']
>[0];

export type LegacyWalletProvider = {
  /**
   * Method syntax, not an arrow property, and that is load-bearing: TypeScript
   * checks method members bivariantly, so the instrumented wallet — whose own
   * `request` accepts exactly the JSON-RPC methods ox declares — fits this slot
   * without a cast, while the wire on the other side still hands over the SDK's
   * own open request type. An arrow property here would refuse it.
   */
  request(request: LegacyWalletRequest): Promise<unknown>;
};

export const NO_WALLET_SENTENCE = 'No wallet is connected in Fiddy';

export function createLegacyWalletChannel(
  getProvider: () => LegacyWalletProvider | undefined,
): MiniAppHost['ethProviderRequest'] {
  const channel = async (request: LegacyWalletRequest): Promise<unknown> => {
    const provider = getProvider();
    if (!provider) {
      throw new Error(NO_WALLET_SENTENCE);
    }
    return await provider.request(request);
  };

  // The host type makes this function generic over the request it is given, so
  // its return type is read off the request. This channel answers with that
  // request's own result — the assertion is about the type, not the wire.
  return channel as MiniAppHost['ethProviderRequest'];
}
