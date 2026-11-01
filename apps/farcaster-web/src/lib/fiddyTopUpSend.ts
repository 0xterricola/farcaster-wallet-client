/**
 * Sending the top-up: from a wallet to Fiddy's treasury, on Base, in USDC.
 *
 * THE ONE THING THIS FILE DOES. It takes the config the server published, an
 * amount in dollars, and a wallet — and it asks that wallet to send exactly one
 * USDC transfer to the treasury address in the config. Nothing else moves, and
 * no amount is invented here: the presets and the $1 floor come from the
 * server (`~/lib/fiddyCredit`), and the recipient is always
 * `config.treasury.address`.
 *
 * WHY IT REUSES THE CLIENT'S OWN TRANSFER BUILDER. `~/utils/baseWalletTransfer`
 * is the surface this client already sends Base tokens with (`ExternalWalletSend`
 * uses it): it checks the token really is an ERC-20 on Base, reads the wallet's
 * own USDC balance, simulates the transfer before asking anyone to approve it,
 * estimates the fee including a buffer, and re-checks all of that at the moment
 * of the send so a changed wallet or a changed token cannot slip through. A
 * bespoke `eth_sendTransaction` here would be a second, less careful copy of
 * that — and this is money.
 *
 * TWO WALLETS, ONE PATH. In the Farcaster app the provider comes from the host
 * (`~/lib/farcasterWallet`); in a browser it is the wallet this client already
 * has connected, and — when there is none — an extension that injected itself
 * into the page. All three are EIP-1193 providers, so all three go through the
 * same builder and the same checks.
 *
 * EVERY REFUSAL IS NAMED. A wallet that is on another network, a wallet with no
 * USDC, a wallet with no ETH for the fee, and a person who simply did not
 * approve it are four different sentences (see `OWNER_LINES` in
 * `~/lib/fiddyCredit`) — never one generic "send failed".
 */

import type { Provider } from 'ox';
import type { Address, Hash } from 'viem';
import { base } from 'viem/chains';

import {
  formatUsd,
  type FundingConfig,
  FundingError,
  shortAddress,
} from '~/lib/fiddyCredit';
import {
  type BaseTransferReader,
  PreparedBaseTransfer,
  prepareEvmTransfer,
  submitEvmTransfer,
} from '~/utils/baseWalletTransfer';

/** Where the wallet came from, which is all the screen needs to say. */
export type TopUpSource = 'farcaster' | 'wallet';

/**
 * The only part of a provider this client uses: one JSON-RPC call. Declared
 * here rather than borrowed from `ox` because a miniapp host's provider is
 * typed against the methods its SDK knows, and this client builds its own
 * calls — the narrow surface is what both can satisfy.
 */
export interface TopUpProvider {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export interface TopUpWallet {
  source: TopUpSource;
  address: Address;
  provider: TopUpProvider;
  /** What to call it on screen: "your Farcaster wallet", "Rainbow". */
  label: string;
}

/** The transfer builder speaks `ox`; this client speaks one method. */
const asOxProvider = (
  provider: TopUpProvider,
): Pick<Provider.Provider, 'request'> =>
  provider as unknown as Pick<Provider.Provider, 'request'>;

/**
 * A wallet that injected itself into the page (a browser extension), when the
 * client has none of its own connected. Read defensively: a page inside a
 * miniapp host can have a `window.ethereum` that is not ours to drive, and an
 * object without `request` is not a provider.
 */
export const readInjectedWallet = (): TopUpWallet | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const injected = (
    window as unknown as {
      ethereum?: { request?: unknown; isMetaMask?: boolean };
    }
  ).ethereum;
  if (!injected || typeof injected.request !== 'function') {
    return null;
  }
  return {
    source: 'wallet',
    address: '0x0000000000000000000000000000000000000000',
    provider: injected as TopUpProvider,
    label: injected.isMetaMask ? 'MetaMask' : 'your browser wallet',
  };
};

/** The chain id the wallet is on right now, or null when it will not say. */
export const walletChainId = async (
  provider: TopUpProvider,
): Promise<number | null> => {
  try {
    const raw = await provider.request({ method: 'eth_chainId' });
    const parsed =
      typeof raw === 'string' ? Number.parseInt(raw, 16) : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** The wallet's own account, asked of the wallet rather than assumed. */
export const walletAccount = async (
  provider: TopUpProvider,
): Promise<Address | null> => {
  try {
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
    })) as unknown;
    const address = Array.isArray(accounts)
      ? accounts.find(
          (account): account is Address =>
            typeof account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account),
        )
      : undefined;
    return address ?? null;
  } catch (error) {
    throw describeSendFailure(error);
  }
};

/**
 * The transfer, prepared and checked, before anybody is asked to approve it.
 *
 * `usd` is a dollar amount, so the prepared transfer is `usd × 1e6` base units
 * of USDC — the same number the presets carry, and the number the ledger will
 * compare against its $1 floor.
 */
export const prepareTopUp = async ({
  reader,
  config,
  usd,
  from,
}: {
  reader: BaseTransferReader;
  config: FundingConfig;
  usd: string;
  from: Address;
}): Promise<PreparedBaseTransfer> => {
  try {
    return await prepareEvmTransfer(
      reader,
      {
        address: from,
        recipient: config.treasury.address,
        amount: usd,
        tokenAddress: config.asset.address as Address,
      },
      base,
    );
  } catch (error) {
    throw describeSendFailure(error);
  }
};

/**
 * Send it. Resolves with the Base transaction hash, which is the only thing the
 * credit route accepts — so a send that produced no hash is a failure here, not
 * a success with a missing field.
 */
export const sendTopUp = async ({
  reader,
  config,
  usd,
  wallet,
  isCurrent,
}: {
  reader: BaseTransferReader;
  config: FundingConfig;
  usd: string;
  wallet: TopUpWallet;
  isCurrent?: () => boolean;
}): Promise<Hash> => {
  const chainId = await walletChainId(wallet.provider);
  if (chainId !== null && chainId !== config.chain.id) {
    throw new FundingError('WRONG_NETWORK', {
      cause: new Error(`wallet chain ${chainId} is not ${config.chain.id}`),
    });
  }

  const account = await walletAccount(wallet.provider);
  if (account === null) {
    throw new FundingError('NOT_CONNECTED');
  }

  const prepared = await prepareTopUp({ reader, config, usd, from: account });

  const hash = (await submitEvmTransfer({
    provider: asOxProvider(wallet.provider),
    reader,
    prepared,
    isCurrent: isCurrent ?? (() => true),
  })) as unknown;

  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new FundingError('SEND_FAILED', {
      cause: new Error('the wallet did not return a transaction hash'),
    });
  }
  return hash as Hash;
};

/**
 * What went wrong, named. The transfer builder speaks in plain sentences and
 * the provider speaks in EIP-1193 codes; both are read here so that a screen
 * never has to show a raw string like "code 4001".
 */
export const describeSendFailure = (error: unknown): FundingError => {
  if (error instanceof FundingError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) {
    return new FundingError('DECLINED', { cause: error });
  }
  if (code === 4100 || code === 4900 || code === 4901) {
    return new FundingError('NOT_CONNECTED', { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    /not on (Base|Ethereum)|wallet_switchEthereumChain|chain mismatch/i.test(
      message,
    )
  ) {
    return new FundingError('WRONG_NETWORK', { cause: error });
  }
  if (
    /insufficient .*balance|exceeds balance|balance is too low/i.test(message)
  ) {
    return new FundingError('NOT_ENOUGH_USDC', { cause: error });
  }
  if (/not enough ETH|insufficient funds for gas|gas \* price/i.test(message)) {
    return new FundingError('NOT_ENOUGH_GAS', { cause: error });
  }
  if (
    /rejected|denied|cancell?ed by (the )?user|user cancell?ed/i.test(message)
  ) {
    return new FundingError('DECLINED', { cause: error });
  }
  return new FundingError('SEND_FAILED', { cause: error });
};

/**
 * The recipient line the review sheet shows: the treasury, short, with the full
 * address one press away in the copy button — never a second address from
 * anywhere else.
 */
export const treasuryLine = (config: FundingConfig): string =>
  shortAddress(config.treasury.address);

/** "5.00 USDC on Base" — what is about to move, said plainly. */
export const transferLine = (config: FundingConfig, usd: string): string =>
  `${formatUsd(usd)} in ${config.asset.symbol} on ${config.chain.name}`;
