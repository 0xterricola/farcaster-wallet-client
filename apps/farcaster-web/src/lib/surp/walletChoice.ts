/**
 * Which wallet pays, and what it is for.
 *
 * The owner is asked one question with two answers, and both answers have to be
 * true about this build:
 *
 *   Bring your Farcaster wallet   the wallet you signed in with, or an external
 *                                 one you connect. This build can do it: the
 *                                 address comes from the client's own wallet
 *                                 connection, and it is the address the Surp
 *                                 payment is prepared from.
 *
 *   Create a fresh wallet for me  a wallet made by the owner's Fiddy account.
 *                                 This build cannot make one, and it does not
 *                                 pretend to: a wallet created here would be a
 *                                 second, competing implementation of the one
 *                                 the control plane already has. The card says
 *                                 where it comes from and stays unavailable
 *                                 until the account hands one over.
 *
 * Everything here is a pure function of the wallet state the client already
 * holds, so the surface can render an honest answer for every combination —
 * nothing connected, a Farcaster wallet, an external wallet, the wrong chain —
 * without this module knowing anything about React.
 */

import type { WalletConnections } from '~/utils/walletFamily';

/** The chain this rail settles on. Anything else has to be switched to. */
export const PAYMENT_CHAIN_ID = 8453;
export const PAYMENT_CHAIN_NAME = 'Base';

export type WalletChoiceId = 'farcaster' | 'fresh';

export interface WalletOption {
  id: WalletChoiceId;
  title: string;
  /** One plain sentence, in the owner's words. */
  line: string;
  /** Whether this build can honour the choice today. */
  available: boolean;
  /** Why not, when it cannot. Always shown next to the card. */
  unavailableReason?: string;
}

export const WALLET_OPTIONS: readonly WalletOption[] = [
  {
    id: 'farcaster',
    title: 'Bring your Farcaster wallet',
    line: 'Use the wallet you signed in with, or connect one you already hold. This is the wallet that pays for Surp.',
    available: true,
  },
  {
    id: 'fresh',
    title: 'Create a fresh wallet for me',
    line: 'A brand-new wallet, made by your Fiddy account and shown here once it exists.',
    available: false,
    unavailableReason:
      'Your Fiddy account makes that wallet, not this page — Fiddy will show it here as soon as your account is linked. Nothing is created until you ask for it.',
  },
];

/** The mask every surface uses for an address. */
export const shortAddress = (address: string): string =>
  address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export interface WalletHomeInput {
  choice: WalletChoiceId;
  connections: WalletConnections;
  /** The chain the connected wallet is on, when the client knows it. */
  chainId?: number;
}

export interface WalletHome {
  choice: WalletChoiceId;
  /** The option the owner picked, for the summary line. */
  option: WalletOption;
  /** The address that will pay, when there is one. */
  address: string | null;
  /** Which wallet family it belongs to, for the label. */
  family: 'evm' | 'solana' | null;
  /** What the client calls that wallet, when it knows. */
  walletName: string | null;
  /** True when the address can actually sign a Base payment right now. */
  canPay: boolean;
  /** One sentence stating which wallet is connected and what it pays for. */
  summary: string;
}

export const describeWalletHome = ({
  choice,
  connections,
  chainId,
}: WalletHomeInput): WalletHome => {
  const option =
    WALLET_OPTIONS.find((candidate) => candidate.id === choice) ??
    WALLET_OPTIONS[0];
  const evm = connections.evm;
  const connected = evm.status === 'connected' && Boolean(evm.address);
  const address = connected ? (evm.address ?? null) : null;

  // A Base payment needs an EVM wallet on Base. A Solana wallet is a real
  // wallet and is worth naming, but it cannot sign this authorization, and
  // saying so here is cheaper than a failed signature later.
  const solana = connections.solana;
  const onRightChain = chainId === undefined || chainId === PAYMENT_CHAIN_ID;

  if (!connected && solana.status === 'connected' && solana.address) {
    return {
      choice,
      option,
      address: null,
      family: 'solana',
      walletName: solana.walletName ?? null,
      canPay: false,
      summary:
        'Your Solana wallet is connected. Surp is paid on Base, so connect an EVM wallet to use it — your Solana wallet is untouched.',
    };
  }

  if (!connected) {
    return {
      choice,
      option,
      address: null,
      family: null,
      walletName: null,
      canPay: false,
      summary:
        option.id === 'fresh'
          ? 'No wallet is connected yet. Your Fiddy account can make you one.'
          : 'No wallet is connected yet. Connect the wallet you want to pay from.',
    };
  }

  const name = evm.walletName ?? null;
  const who = name ? `${name} (${shortAddress(address as string)})` : shortAddress(address as string);

  if (!onRightChain) {
    return {
      choice,
      option,
      address,
      family: 'evm',
      walletName: name,
      canPay: false,
      summary: `${who} is connected, but it is not on ${PAYMENT_CHAIN_NAME}. Surp is paid on ${PAYMENT_CHAIN_NAME}; switch the wallet and this will work.`,
    };
  }

  return {
    choice,
    option,
    address,
    family: 'evm',
    walletName: name,
    canPay: true,
    summary: `${who} is connected. This is the wallet that pays for Surp — one request at a time, and only when you approve it.`,
  };
};