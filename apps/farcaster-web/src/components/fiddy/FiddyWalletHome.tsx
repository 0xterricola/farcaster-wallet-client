/**
 * The wallet home: which wallet is connected, and what it pays for.
 *
 * Two halves, deliberately separated:
 *
 *   `FiddyWalletHome`            the choice and the summary, as a pure function
 *                                of the wallet state it is handed. No hooks, no
 *                                context, so it can be rendered anywhere and
 *                                tested for every state a real client is in.
 *   `FiddyWalletHomeConnected`   the thin wiring that reads the client's own
 *                                wallet and signs with it. Everything that could
 *                                move money is in the second half, and it does
 *                                exactly one thing: ask the wallet to sign an
 *                                authorization this page built from Surp's live
 *                                402 — then stop.
 *
 * WHICH WALLET THE WIRING READS. Not wagmi alone: this client has three wallets
 * behind one answer — an external one connected here (injected or by code), a
 * MetaMask multichain account, and the Farcaster wallet a person signed in
 * with. wagmi knows only the first, so reading it alone told a Farcaster user
 * with a wallet that nothing was connected. The connection is therefore read
 * from the client's own wallet context, which is the same answer the rest of the
 * app acts on.
 *
 * THE CONNECT STRIP IS A PROP, ON PURPOSE. A wallet page has to let a person
 * connect a wallet they already hold, and it does that by raising the client's
 * existing wallet dialog rather than growing a second chooser here. So the
 * button is wired by whoever mounts this surface (`onConnect`); a surface that
 * has a chooser beside it already (settings) passes nothing and grows no
 * button, and a signed-out layout — where no dialog exists to raise — gets no
 * button either, because a button that cannot work is the defect this whole
 * surface exists to avoid.
 *
 * What happens after the signature: the encoded payment is held on screen and
 * named for what it is. Nothing is broadcast from here. Spending it is a
 * request to Surp made by the agent that needs the answer, which is a separate
 * step with its own approval — which is also why the tests for this file can
 * assert that no mainnet transaction is ever sent.
 */

import React, { memo, useCallback, useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';

import { useSolanaWallet } from '~/contexts/SolanaWalletProvider';
import { useWallet } from '~/contexts/WalletProvider';
import { saveFiddySetup, useFiddySetup } from '~/lib/fiddySetup';
import {
  describeWalletHome,
  shortAddress,
  WALLET_OPTIONS,
  type WalletChoiceId,
} from '~/lib/surp/walletChoice';
import {
  encodePaymentHeader,
  fetchPaymentOffer,
  type PreparedPayment,
  preparePayment,
  toJsonRpcTypedData,
  type X402Challenge,
  type X402Offer,
} from '~/lib/surp/x402';
import type { WalletConnections } from '~/utils/walletFamily';

export interface FiddyWalletHomeProps {
  choice: WalletChoiceId;
  connections: WalletConnections;
  chainId?: number;
  onChoose: (choice: WalletChoiceId) => void;
  /**
   * Raise the wallet connection this client already has. Absent when the
   * surface has nothing to raise — then no button is drawn for it.
   */
  onConnect?: () => void;
  /** The wallet's own signature over the prepared authorization. */
  onSignTypedData?: (
    typedData: PreparedPayment['typedData'],
  ) => Promise<`0x${string}`>;
  /** How many tokens a request the agent makes is likely to need. */
  requestTokens?: number;
}

type PayState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'signed'; header: string; usd: number }
  | { status: 'declined'; line: string };

export const FiddyWalletHome = memo(
  ({
    choice,
    connections,
    chainId,
    onChoose,
    onConnect,
    onSignTypedData,
    requestTokens = 900,
  }: FiddyWalletHomeProps) => {
    const home = describeWalletHome({ choice, connections, chainId });
    const [pay, setPay] = useState<PayState>({ status: 'idle' });
    const [offer, setOffer] = useState<{
      challenge: X402Challenge;
      offer: X402Offer;
    } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const askPrice = useCallback(async () => {
      setNotice(null);
      try {
        const live = await fetchPaymentOffer(requestTokens);
        if (!live) {
          setNotice('Surp answered, but not with a price this page can use.');
          return;
        }
        setOffer(live);
        const prepared = preparePayment({
          offer: live.offer,
          from: home.address ?? '0x0000000000000000000000000000000000000000',
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        setNotice(
          prepared
            ? prepared.ownerLine
            : 'Surp asked to be paid in something this wallet cannot sign.',
        );
      } catch {
        setNotice(
          'Your browser could not read Surp directly, so there is no live price to show. Nothing was charged.',
        );
      }
    }, [home.address, requestTokens]);

    const payOnce = useCallback(async () => {
      if (!offer) {
        return;
      }
      // Two different nothings, said differently: no wallet wired into this
      // screen at all, versus a screen that can sign but nobody to sign with.
      if (!onSignTypedData) {
        setNotice(
          'This screen cannot reach a wallet, so nothing can be paid from here. Open your wallet settings to pay.',
        );
        return;
      }
      if (!home.address) {
        setNotice('Connect the wallet you want to pay from first.');
        return;
      }
      setPay({ status: 'asking' });
      const prepared = preparePayment({
        offer: offer.offer,
        from: home.address,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!prepared) {
        setPay({ status: 'idle' });
        setNotice(
          'Surp asked to be paid in something this wallet cannot sign.',
        );
        return;
      }
      try {
        const signature = await onSignTypedData(prepared.typedData);
        const header = encodePaymentHeader({
          challenge: offer.challenge,
          offer: offer.offer,
          prepared,
          signature,
        });
        setPay({ status: 'signed', header, usd: prepared.usd });
      } catch {
        // A refusal in a wallet is a decision, not an error to shout about.
        setPay({
          status: 'declined',
          line: 'That was not approved, so nothing was paid.',
        });
      }
    }, [offer, home.address, onSignTypedData]);

    return (
      <section className="fiddy-wallet-home" data-fiddy="wallet-home">
        <header>
          <h2 className="fiddy-field-label">Which wallet pays</h2>
          <p className="fiddy-honest-note">
            <span>
              Your wallet pays for what your agent uses. Fiddy never holds it,
              and it is never charged without you approving that payment.
            </span>
          </p>
        </header>

        {onConnect ? (
          <div
            className="fiddy-connect"
            data-fiddy="wallet-connection"
            data-fiddy-wallet-connection={
              home.address ? 'connected' : 'disconnected'
            }
          >
            <p className="fiddy-honest-note" role="status" aria-live="polite">
              <span>
                {home.address
                  ? 'A wallet is connected already. You can swap in another one at any time — swapping changes which wallet pays, and nothing else.'
                  : 'MetaMask, Rabby and other wallets in this browser connect in a tap. Any other wallet works by scanning a code with your phone. Fiddy learns the address and nothing more.'}
              </span>
            </p>
            <button
              type="button"
              className={
                home.address
                  ? 'fiddy-quiet-btn fiddy-quiet-btn-outline'
                  : 'fiddy-secondary-btn'
              }
              onClick={onConnect}
              data-fiddy="wallet-connect"
            >
              {home.address ? 'Use a different wallet' : 'Connect a wallet'}
            </button>
          </div>
        ) : null}

        <ul className="fiddy-card-list">
          {WALLET_OPTIONS.map((option) => {
            const selected = option.id === choice;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  className={`fiddy-brain-card${
                    selected ? ' fiddy-brain-card-selected' : ''
                  }`}
                  aria-pressed={selected}
                  data-fiddy-wallet-choice={option.id}
                  onClick={() => onChoose(option.id)}
                >
                  <span className="fiddy-card-head">
                    <span className="fiddy-card-title">{option.title}</span>
                    <span
                      className={`fiddy-tag fiddy-tag-${
                        option.available ? 'live' : 'soon'
                      }`}
                    >
                      {option.available ? 'ready' : 'not yet'}
                    </span>
                  </span>
                  <span className="fiddy-card-line">{option.line}</span>
                </button>
                {!option.available && option.unavailableReason ? (
                  <p
                    className="fiddy-honest-note"
                    data-fiddy-wallet-unavailable={option.id}
                  >
                    <span>{option.unavailableReason}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <p
          className="fiddy-honest-note"
          role="status"
          aria-live="polite"
          data-fiddy-wallet-summary={home.canPay ? 'can-pay' : 'cannot-pay'}
        >
          <span>{home.summary}</span>
        </p>

        <div className="fiddy-connect">
          <button
            type="button"
            className="fiddy-quiet-btn fiddy-quiet-btn-outline"
            onClick={() => void askPrice()}
            data-fiddy="wallet-ask-price"
          >
            See what one request costs
          </button>

          {notice ? (
            <p className="fiddy-honest-note" data-fiddy="wallet-notice">
              <span>{notice}</span>
            </p>
          ) : null}

          {offer ? (
            <button
              type="button"
              className="fiddy-secondary-btn"
              onClick={() => void payOnce()}
              disabled={pay.status === 'asking'}
              data-fiddy="wallet-pay"
            >
              {pay.status === 'asking'
                ? 'Waiting for your wallet…'
                : 'Approve this payment in my wallet'}
            </button>
          ) : null}

          {pay.status === 'declined' ? (
            <p role="status" aria-live="polite" className="fiddy-honest-note">
              <span>{pay.line}</span>
            </p>
          ) : null}

          {pay.status === 'signed' ? (
            <div className="fiddy-connected" data-fiddy="wallet-signed">
              <span className="fiddy-connected-dot" aria-hidden="true" />
              <span>
                Approved — one payment of ${pay.usd.toFixed(2)} is ready to send
                with your next request. Nothing has been sent yet, and this
                approval expires on its own.
              </span>
            </div>
          ) : null}
        </div>
      </section>
    );
  },
);

FiddyWalletHome.displayName = 'FiddyWalletHome';

/**
 * A signature request with no wallet behind it is a click that cannot work, so
 * the handler is withheld until there is an address — the surface then says
 * "connect the wallet you want to pay from first" instead of throwing.
 */
const onAddressSafe = (
  sign: (typedData: PreparedPayment['typedData']) => Promise<`0x${string}`>,
  address: string | undefined,
) => (address === undefined ? undefined : sign);

/**
 * The wiring: this client's own wallet, and its own signing call. The wallet
 * choice is stored beside the rest of the setup, which is a preference file and
 * holds no key — the wallet is reached through the connection, never stored.
 */
export const FiddyWalletHomeConnected = memo(
  ({
    onConnect,
    requestTokens,
  }: {
    /**
     * Raise the connect surface this client has. Passed by a page that owns one
     * (the wallet page switches to its connect step); omitted by a surface that
     * has a chooser beside it already (settings), which then grows no button.
     */
    onConnect?: () => void;
    requestTokens?: number;
  }) => {
    const setup = useFiddySetup();
    const { connector } = useAccount();
    const wagmiChainId = useChainId();
    const { signTypedDataAsync } = useSignTypedData();
    const solana = useSolanaWallet();
    const {
      address: connectedAddress,
      available: walletSurfaceAvailable,
      network,
      preferredWallet,
      provider,
    } = useWallet();

    // Which of the three wallets this is. The Farcaster wallet a person signed
    // in with is reached through the embedded bridge rather than through wagmi.
    const usesFarcasterWallet = preferredWallet === 'warpcast';

    const connections: WalletConnections = {
      evm:
        connectedAddress === undefined
          ? { status: 'disconnected' }
          : {
              status: 'connected',
              address: connectedAddress,
              walletName: usesFarcasterWallet
                ? 'Farcaster wallet'
                : connector?.name,
            },
      solana:
        solana.status === 'connected' && solana.address
          ? {
              status: 'connected',
              address: solana.address,
              walletName: solana.wallet?.name,
            }
          : { status: 'disconnected' },
    };

    const onSignTypedData = useCallback(
      async (typedData: PreparedPayment['typedData']) => {
        // The Farcaster wallet is not a wagmi connector, so it is asked over the
        // wire through the provider this client is connected through.
        // Everything else signs through wagmi, which knows its own connector's
        // quirks — and which chain it is on.
        if (usesFarcasterWallet) {
          if (!provider || !connectedAddress) {
            throw new Error('No wallet is connected to sign with.');
          }
          return (await provider.request({
            method: 'eth_signTypedData_v4',
            params: [connectedAddress, toJsonRpcTypedData(typedData)],
          })) as `0x${string}`;
        }

        return await signTypedDataAsync({
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        });
      },
      [usesFarcasterWallet, provider, connectedAddress, signTypedDataAsync],
    );

    return (
      <FiddyWalletHome
        choice={setup.walletChoice}
        connections={connections}
        chainId={
          network.actualChainId ??
          (usesFarcasterWallet ? undefined : wagmiChainId)
        }
        onChoose={(walletChoice) => saveFiddySetup({ walletChoice })}
        onConnect={walletSurfaceAvailable ? onConnect : undefined}
        onSignTypedData={onAddressSafe(onSignTypedData, connectedAddress)}
        requestTokens={requestTokens}
      />
    );
  },
);

FiddyWalletHomeConnected.displayName = 'FiddyWalletHomeConnected';

export { shortAddress };
