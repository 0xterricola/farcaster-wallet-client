/**
 * The Miniapp side of the Farcaster wallet: where a top-up is sent from when
 * this app is open inside a Farcaster client.
 *
 * WHY THIS FILE EXISTS AT ALL. Inside the Farcaster app there is no extension
 * to connect and no WalletConnect QR to scan: the wallet the person already
 * signed in with is right there, and the host offers it through the Farcaster
 * miniapp SDK. Reaching it is a request to the *host*, which is why this is a
 * different provider from the one the browser shells out to — and why the SDK
 * is imported lazily: it is a chunk of its own, fetched only when this app has
 * been opened as a miniapp.
 *
 * WHAT IT WILL NOT DO.
 *  - It never guesses. If the app is not inside a miniapp host, or the host
 *    offers no wallet, this answers `null` and the screen falls back to a
 *    wallet the person can connect — rather than pretending a send happened.
 *  - It does not decide anything about money. It hands back a provider and an
 *    address; the amount, the recipient and the review all come from
 *    `~/lib/fiddyCredit` and the server's own config.
 */

import type { Address } from 'viem';

/** The only part of a provider this file needs: one JSON-RPC call. */
export interface Eip1193Request {
  (args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface MiniappWallet {
  address: Address;
  provider: { request: Eip1193Request };
}

const isAddressLike = (value: unknown): value is Address =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Is this page open inside a Farcaster app? Asked without touching a wallet:
 * offering "pay with your Farcaster wallet" is a statement about where the
 * reader is, and asking the host for a provider just to find out would put a
 * prompt in front of somebody who has not decided anything yet.
 */
export const inFarcasterMiniapp = async (): Promise<boolean> => {
  try {
    const module = await import('@farcaster/miniapp-sdk');
    const sdk = module.default ?? (module.sdk as typeof module.default);
    return (await sdk?.isInMiniApp?.()) === true;
  } catch {
    return false;
  }
};

/**
 * The wallet the Farcaster app offers this page, or null.
 *
 * `isInMiniApp()` is asked before anything else: outside a host the SDK's own
 * calls time out rather than failing, and a screen must not hang on a wallet
 * that was never there.
 */
export const openMiniappWallet = async (): Promise<MiniappWallet | null> => {
  let sdk: typeof import('@farcaster/miniapp-sdk').default;
  try {
    const module = await import('@farcaster/miniapp-sdk');
    sdk = module.default ?? (module.sdk as typeof module.default);
  } catch {
    return null;
  }
  if (!sdk?.isInMiniApp) {
    return null;
  }
  try {
    if (!(await sdk.isInMiniApp())) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const provider = await sdk.wallet.getEthereumProvider();
    if (!provider) {
      return null;
    }
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
    })) as unknown;
    const address = Array.isArray(accounts)
      ? accounts.find((account) => isAddressLike(account))
      : undefined;
    if (!address) {
      return null;
    }
    // The host's provider is typed against the methods the SDK knows about; a
    // JSON-RPC call this client builds itself is broader, so the surface is
    // narrowed to the one call everything downstream makes.
    const request: Eip1193Request = (args) =>
      provider.request(args as never) as Promise<unknown>;
    return { address, provider: { request } };
  } catch {
    return null;
  }
};
