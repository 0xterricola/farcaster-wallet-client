/**
 * The Fiddy balance, wired: the chip in the chrome, the balance home, and the
 * add-funds sheet — each a thin read of the queries in `~/hooks/fiddy`.
 *
 * WHY THE THREE LIVE TOGETHER. They are three views of one thing, and the
 * sentences they show have to agree: the chip's number is the balance home's
 * number, and the add-funds sheet is the only place either of them comes from.
 * Splitting them into three modules would make it possible for two of them to
 * disagree about what a Fiddy balance is, which is the exact mistake the copy
 * rules exist to prevent.
 *
 * WHAT A BALANCE IS, ONE MORE TIME. A platform credit, spent inside Fiddy,
 * behind a USDC transfer that Fiddy verified on Base. Not custody, not a wallet
 * balance, not a deposit. The chip shows the number and nothing else; the home
 * says what it is.
 */

import { ChevronRight, Wallet } from 'lucide-react';
import React, { memo, useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';

import {
  AddFundsSheet,
  type AddFundsWalletOption,
} from '~/components/fiddy/AddFundsSheet';
import { Link } from '~/components/links/Link';
import { useWallet } from '~/contexts/WalletProvider';
import {
  useFundingBalance,
  useFundingConfig,
  useFundingSession,
} from '~/hooks/fiddy/useFiddyCredit';
import { useFiddyTopUp } from '~/hooks/fiddy/useFiddyTopUp';
import { inFarcasterMiniapp } from '~/lib/farcasterWallet';
import {
  formatUsd,
  type FundingBalance,
  type FundingConfig,
  fundingFailureCode,
  fundingFailureOwnerLine,
  type FundingMovement,
  type FundingSession,
} from '~/lib/fiddyCredit';
import { type PendingTopUp, readPendingTopUp } from '~/lib/fiddyPendingTopUp';
import { readInjectedWallet } from '~/lib/fiddyTopUpSend';

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

export interface FiddyBalanceChipProps {
  /** The available credit, as the server words it. Null = nothing to show. */
  usdc: string | null;
  /** Phones get the number alone; the top bar has room for the word. */
  compact?: boolean;
}

/**
 * The number in the chrome. It is a link, not a button, because it goes
 * somewhere — the balance home, where the number is explained and the recent
 * movements are.
 *
 * When there is no balance to show it renders nothing at all. A chip that read
 * "$0.00" for "this browser has no balance here" would be a claim about
 * somebody's money, and the one thing this surface must never do is invent a
 * number.
 */
export const FiddyBalanceChip = memo<FiddyBalanceChipProps>(
  ({ usdc, compact = false }) => {
    if (usdc === null) {
      return null;
    }
    const amount = formatUsd(usdc);
    return (
      /* The chip itself is the span: `Link` takes a title and a class and
         nothing else, and a probe reads the number off the chip's own
         attributes rather than guessing from the text. */
      <Link
        to="wallet"
        params={{}}
        searchParams={{}}
        title="Your Fiddy balance"
        className="fiddy-chip-link"
      >
        <span
          className={`fiddy-chip${compact ? ' fiddy-chip-compact' : ''}`}
          data-fiddy="balance-chip"
          data-fiddy-balance={usdc}
          data-fiddy-compact={compact ? 'true' : 'false'}
        >
          <Wallet size={compact ? 14 : 15} aria-hidden="true" />
          <span className="fiddy-chip-amount">{amount}</span>
          {compact ? null : (
            <span className="fiddy-chip-label">Fiddy balance</span>
          )}
        </span>
      </Link>
    );
  },
);

FiddyBalanceChip.displayName = 'FiddyBalanceChip';

/**
 * The chip, reading its own number. Nothing is rendered until a balance
 * arrives: no spinner, no zero, no placeholder — the chrome of a client should
 * not flicker a money number into existence.
 *
 * It reads the same query key the wallet page does, so React Query serves both
 * from one request rather than asking for the same number twice.
 */
export const FiddyBalanceChipConnected = memo<{ compact?: boolean }>(
  ({ compact = false }) => {
    const balance = useFundingBalance();
    if (!balance.isSuccess) {
      return null;
    }
    return (
      <FiddyBalanceChip
        usdc={balance.data.credit.availableUsdc}
        compact={compact}
      />
    );
  },
);

FiddyBalanceChipConnected.displayName = 'FiddyBalanceChipConnected';

// ---------------------------------------------------------------------------
// The balance home (the wallet page)
// ---------------------------------------------------------------------------

export interface FiddyBalanceHomeProps {
  session: FundingSession;
  sessionLine: string | null;
  sessionCode: string | null;
  balance: FundingBalance | null;
  loading: boolean;
  pending: PendingTopUp | null;
  onCheckPending: () => void;
  busy: boolean;
}

const movementLine = (movement: FundingMovement): string => {
  const when = new Date(movement.time);
  const day = Number.isNaN(when.getTime())
    ? movement.time
    : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return day;
};

const movementKind = (movement: FundingMovement): string => {
  if (movement.kind === 'spend') {
    return 'Spent';
  }
  if (movement.status === 'credited') {
    return 'Top-up';
  }
  return movement.kind === 'movement' ? 'Balance change' : movement.kind;
};

export const FiddyBalanceHome = memo<FiddyBalanceHomeProps>(
  ({
    session,
    sessionLine,
    sessionCode,
    balance,
    loading,
    pending,
    onCheckPending,
    busy,
  }) => (
    <div
      className="fiddy-balance"
      data-fiddy="balance-home"
      data-fiddy-session={session}
    >
      <div className="fiddy-balance-amount">
        <span className="fiddy-balance-label">Your Fiddy balance</span>
        <strong data-fiddy="balance-available">
          {balance === null ? '—' : formatUsd(balance.credit.availableUsdc)}
        </strong>
        <span className="fiddy-honest-note">
          <span>
            A credit you spend inside Fiddy. Every top-up behind it was a USDC
            transfer Fiddy checked on Base; Fiddy does not hold money in your
            wallet.
          </span>
        </span>
      </div>

      <Link
        to="fiddyAddFunds"
        params={{}}
        searchParams={{}}
        title="Add funds"
        className="fiddy-primary-btn"
      >
        {/* `Link` forwards a fixed prop set and drops anything else, so the
            marker a probe (and this screen's own tests) reach for lives on the
            label inside it rather than on the anchor. */}
        <span data-fiddy="balance-add-funds">Add funds</span>
        <ChevronRight size={16} aria-hidden="true" />
      </Link>

      {session !== 'ready' && !loading ? (
        <p
          className="fiddy-honest-note"
          data-fiddy="balance-session-line"
          role="status"
          aria-live="polite"
        >
          <span>
            {sessionLine ??
              'Fiddy cannot read a balance for this account here, so there is nothing to show yet.'}
            {sessionCode === null ? '' : ` (${sessionCode})`}
          </span>
        </p>
      ) : null}

      {pending !== null ? (
        <div className="fiddy-pending" data-fiddy="balance-pending">
          <span>
            A transfer of {formatUsd(pending.usdc)} is still not in your
            balance. Checking it again sends nothing.
          </span>
          <button
            type="button"
            className="fiddy-secondary-btn"
            data-fiddy="balance-pending-check"
            disabled={busy}
            onClick={onCheckPending}
          >
            Check again
          </button>
        </div>
      ) : null}

      {balance !== null && balance.entries.length > 0 ? (
        <section
          className="fiddy-balance-history"
          aria-labelledby="fiddy-history"
        >
          <h2 id="fiddy-history" className="fiddy-field-label">
            Recent movements
          </h2>
          <ul className="fiddy-balance-list" data-fiddy="balance-entries">
            {balance.entries.map((movement) => (
              <li key={movement.id} data-fiddy-movement={movement.kind}>
                <span className="fiddy-balance-movement">
                  <b>{movementKind(movement)}</b>
                  <small>
                    {movement.txHashShort ?? movementLine(movement)}
                  </small>
                </span>
                <span className="fiddy-balance-value">
                  {movement.kind === 'spend' ? '−' : '+'}
                  {formatUsd(movement.amount.usdc)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  ),
);

FiddyBalanceHome.displayName = 'FiddyBalanceHome';

/**
 * The balance home, wired: everything `FiddyBalanceHome` shows, read from the
 * queries. The wallet page mounts this and nothing else of the funding surface,
 * so a test of that page can stand it in with one line.
 */
export const FiddyBalanceSection = memo(() => {
  const config = useFundingConfig();
  const { session, line, code } = useFundingSession();
  const balance = useFundingBalance();
  const pendingTopUp = usePendingTopUp();
  const topUp = useFiddyTopUp(config.data ?? null);

  return (
    <FiddyBalanceHome
      session={session}
      sessionLine={line}
      sessionCode={code}
      balance={balance.data ?? null}
      loading={balance.isPending}
      pending={topUp.pending ?? pendingTopUp.pending}
      onCheckPending={() => void topUp.checkPending()}
      busy={topUp.busy}
    />
  );
});

FiddyBalanceSection.displayName = 'FiddyBalanceSection';

// ---------------------------------------------------------------------------
// The add-funds sheet, wired
// ---------------------------------------------------------------------------

export interface FiddyFundingPanelProps {
  quiet?: { label: string; onClick: () => void } | null;
}

/**
 * The flow, with its queries and its wallet resolution attached. Everything it
 * shows is passed to `AddFundsSheet`, which owns no network of its own — so the
 * same sheet is what the way in renders and what the wallet page opens.
 */
export const FiddyFundingPanel = memo<FiddyFundingPanelProps>(
  ({ quiet = null }) => {
    const config = useFundingConfig();
    const { session, line, code } = useFundingSession();
    const { provider, address, openConnectModal } = useWallet();
    const { address: wagmiAddress, connector } = useAccount();
    const [miniapp, setMiniapp] = useState(false);
    const [injected, setInjected] = useState(false);

    const topUp = useFiddyTopUp(config.data ?? null);

    useEffect(() => {
      let alive = true;
      void inFarcasterMiniapp().then((isMiniapp) => {
        if (alive) {
          setMiniapp(isMiniapp);
        }
      });
      setInjected(readInjectedWallet() !== null);
      return () => {
        alive = false;
      };
    }, []);

    const walletOptions = useMemo<AddFundsWalletOption[]>(() => {
      const options: AddFundsWalletOption[] = [];
      if (miniapp) {
        options.push({
          source: 'farcaster',
          label: 'Your Farcaster wallet',
          line: 'The wallet in the Farcaster app you are using. One approval, and it is on Base already.',
          available: true,
        });
      }
      const connected = Boolean((address ?? wagmiAddress) && provider);
      if (connected || injected) {
        options.push({
          source: 'wallet',
          label: connected
            ? (connector?.name ?? 'Your connected wallet')
            : (readInjectedWallet()?.label ?? 'Your browser wallet'),
          line: 'A wallet in this browser. Fiddy never sees its keys and never holds your money.',
          available: true,
        });
      }
      return options;
    }, [address, connector, injected, miniapp, provider, wagmiAddress]);

    const connectLine =
      walletOptions.length === 0
        ? 'No wallet is connected here yet. Connect one and this step can send from it.'
        : null;

    return (
      <div data-fiddy="funding-panel" data-fiddy-wallets={walletOptions.length}>
        <AddFundsSheet
          config={config.data ?? null}
          configLine={
            config.isError
              ? `${fundingFailureOwnerLine(config.error)} (${fundingFailureCode(config.error)})`
              : null
          }
          session={session}
          sessionLine={line ?? connectLine}
          sessionCode={code}
          walletOptions={walletOptions}
          pending={topUp.pending}
          progress={topUp.progress}
          busy={topUp.busy}
          onSend={(usd, source) => void topUp.send(usd, source)}
          onCheckPending={() => void topUp.checkPending()}
          onForgetPending={() => void topUp.forgetPending()}
          onDone={() => topUp.reset()}
          quiet={quiet}
        />
        {walletOptions.length === 0 && session === 'ready' ? (
          <button
            type="button"
            className="fiddy-secondary-btn"
            data-fiddy="funding-connect"
            onClick={() => openConnectModal('evm')}
          >
            Connect a wallet
          </button>
        ) : null}
      </div>
    );
  },
);

FiddyFundingPanel.displayName = 'FiddyFundingPanel';

/** The remembered transfer at the wallet-page level, without a config read. */
export const usePendingTopUp = (): {
  pending: PendingTopUp | null;
  reload: () => Promise<void>;
} => {
  const [pending, setPending] = useState<PendingTopUp | null>(null);
  useEffect(() => {
    let alive = true;
    void readPendingTopUp().then((record) => {
      if (alive) {
        setPending(record);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return {
    pending,
    reload: async () => setPending(await readPendingTopUp()),
  };
};

export type { FundingConfig };
