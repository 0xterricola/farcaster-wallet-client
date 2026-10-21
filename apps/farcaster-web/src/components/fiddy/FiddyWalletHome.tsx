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
 *                                wallet (wagmi) and signs with it. Everything
 *                                that could move money is in the second half,
 *                                and it does exactly one thing: ask the wallet
 *                                to sign an authorization this page built from
 *                                Surp's live 402 — then stop.
 *
 * What happens after the signature: the encoded payment is held on screen and
 * named for what it is. Nothing is broadcast from here. Spending it is a
 * request to Surp made by the agent that needs the answer, which is a separate
 * step with its own approval — which is also why the tests for this file can
 * assert that no mainnet transaction is ever sent.
 */

import React, { memo, useCallback, useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';

import { saveFiddySetup, useFiddySetup } from '~/lib/fiddySetup';
import {
  describeWalletHome,
  shortAddress,
  WALLET_OPTIONS,
  type WalletChoiceId,
} from '~/lib/surp/walletChoice';
import type { WalletConnections } from '~/utils/walletFamily';
import {
  encodePaymentHeader,
  fetchPaymentOffer,
  preparePayment,
  type PreparedPayment,
  type X402Challenge,
  type X402Offer,
} from '~/lib/surp/x402';

export interface FiddyWalletHomeProps {
  choice: WalletChoiceId;
  connections: WalletConnections;
  chainId?: number;
  onChoose: (choice: WalletChoiceId) => void;
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
      if (!offer) return;
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
        setNotice('Surp asked to be paid in something this wallet cannot sign.');
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
  ({ requestTokens }: { requestTokens?: number }) => {
    const setup = useFiddySetup();
    const chainId = useChainId();
    const { address, connector } = useAccount();
    const { signTypedDataAsync } = useSignTypedData();

    const connections: WalletConnections = {
      evm:
        address === undefined
          ? { status: 'disconnected' }
          : {
              status: 'connected',
              address,
              walletName: connector?.name,
            },
      solana: { status: 'disconnected' },
    };

    const onSignTypedData = useCallback(
      async (typedData: PreparedPayment['typedData']) =>
        await signTypedDataAsync({
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        }),
      [signTypedDataAsync],
    );

    return (
      <FiddyWalletHome
        choice={setup.walletChoice}
        connections={connections}
        chainId={chainId}
        onChoose={(walletChoice) => saveFiddySetup({ walletChoice })}
        onSignTypedData={onAddressSafe(onSignTypedData, address)}
        requestTokens={requestTokens}
      />
    );
  },
);

FiddyWalletHomeConnected.displayName = 'FiddyWalletHomeConnected';

export { shortAddress };