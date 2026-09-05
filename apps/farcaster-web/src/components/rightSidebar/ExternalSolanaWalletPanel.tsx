import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  CopyIcon,
  HistoryIcon,
  WalletIcon,
} from 'lucide-react';
import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { ExternalSolanaWalletActivity } from '~/components/rightSidebar/ExternalSolanaWalletActivity';
import { ExternalSolanaWalletPortfolio } from '~/components/rightSidebar/ExternalSolanaWalletPortfolio';
import { ExternalSolanaWalletSend } from '~/components/rightSidebar/ExternalSolanaWalletSend';
import { ExternalSolanaWalletSwap } from '~/components/rightSidebar/ExternalSolanaWalletSwap';
import { useSolanaBalance } from '~/hooks/useSolanaBalance';
import {
  formatSolBalance,
  SOLANA_MAINNET_NAME,
  solanaAddressUrl,
} from '~/utils/solanaWallet';
import { WalletTradeIntent } from '~/utils/walletTradeIntent';

type SolanaView = 'activity' | 'overview' | 'receive' | 'send' | 'trade';

export function ExternalSolanaWalletPanel({
  address,
  onManageWallets,
  signTransaction,
  tradeIntent,
}: {
  address: string;
  onManageWallets: () => void;
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  tradeIntent?: Extract<WalletTradeIntent, { family: 'solana' }>;
}) {
  const [view, setView] = useState<SolanaView>('overview');
  const [copied, setCopied] = useState(false);
  const balance = useSolanaBalance(address);
  useEffect(() => {
    if (tradeIntent) {
      setView('trade');
    }
  }, [tradeIntent]);
  const formattedBalance = useMemo(() => {
    if (balance.isLoading) {
      return 'Loading…';
    }
    if (balance.isError || balance.data === undefined) {
      return '—';
    }
    return formatSolBalance(balance.data);
  }, [balance.data, balance.isError, balance.isLoading]);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (view === 'receive') {
    return (
      <SolanaSubscreen
        title="Receive on Solana"
        onBack={() => setView('overview')}
      >
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="text-center text-sm text-muted">
            Send only Solana Mainnet assets to this address.
          </div>
          <div className="overflow-hidden rounded-2xl bg-white p-2">
            <QRCode value={address} size={180} quietZone={8} />
          </div>
          <div className="break-all text-center text-sm text-muted">
            {address}
          </div>
          <DefaultButton className="w-full" onClick={copyAddress}>
            {copied ? 'Copied' : 'Copy address'}
          </DefaultButton>
        </div>
      </SolanaSubscreen>
    );
  }

  if (view === 'send') {
    return (
      <ExternalSolanaWalletSend
        address={address}
        onBack={() => setView('overview')}
        signTransaction={signTransaction}
      />
    );
  }

  if (view === 'trade') {
    return (
      <ExternalSolanaWalletSwap
        key={tradeIntent?.id}
        address={address}
        initialBuyToken={
          tradeIntent
            ? {
                amount: '0',
                decimals: tradeIntent.tokenDecimals,
                mint: tradeIntent.tokenAddress,
                name: tradeIntent.tokenName,
                symbol: tradeIntent.tokenSymbol,
              }
            : undefined
        }
        onBack={() => setView('overview')}
        signTransaction={signTransaction}
      />
    );
  }

  if (view === 'activity') {
    return (
      <SolanaSubscreen
        title="Solana activity"
        onBack={() => setView('overview')}
      >
        <ExternalSolanaWalletActivity address={address} />
      </SolanaSubscreen>
    );
  }

  return (
    <>
      <div className="rounded-xl border p-3 bg-elevated-nohover border-default">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">
          Current network
        </div>
        <div className="mt-1 font-semibold text-default">
          {SOLANA_MAINNET_NAME}
        </div>
      </div>

      <div className="mt-4 rounded-2xl p-4 bg-elevated-nohover">
        <div className="text-sm text-muted">Solana</div>
        <div className="mt-1 text-3xl font-semibold text-default">
          {formattedBalance}
        </div>
        <button
          type="button"
          className="mt-3 flex items-center gap-2 text-sm text-muted hover:text-default"
          onClick={copyAddress}
        >
          <span>{`${address.slice(0, 6)}…${address.slice(-6)}`}</span>
          {copied ? (
            <CheckIcon className="size-4" />
          ) : (
            <CopyIcon className="size-4" />
          )}
        </button>
      </div>

      {balance.isError && (
        <div className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-600">
          SOL balance is temporarily unavailable.{' '}
          <button
            className="font-semibold underline"
            onClick={() => void balance.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-5 gap-2">
        <SolanaAction
          label="Receive"
          icon={<ArrowDownToLineIcon className="size-5" />}
          onClick={() => setView('receive')}
        />
        <SolanaAction
          label="Send"
          icon={<ArrowUpFromLineIcon className="size-5" />}
          onClick={() => setView('send')}
        />
        <SolanaAction
          label="Trade"
          icon={<ArrowLeftRightIcon className="size-5" />}
          onClick={() => setView('trade')}
        />
        <SolanaAction
          label="Activity"
          icon={<HistoryIcon className="size-5" />}
          onClick={() => setView('activity')}
        />
        <SolanaAction
          label="Wallets"
          icon={<WalletIcon className="size-5" />}
          onClick={onManageWallets}
          isManagement
        />
      </div>

      <div className="mt-3 rounded-xl p-3 text-xs leading-relaxed text-muted bg-elevated-nohover">
        SOL and SPL token balances, Receive, Send, same-chain Trade, and
        Activity are available.
      </div>

      <ExternalSolanaWalletPortfolio address={address} />

      <a
        className="mt-4 block text-center text-sm font-semibold text-accent hover:underline"
        href={solanaAddressUrl(address)}
        rel="noreferrer"
        target="_blank"
      >
        View address on Solana Explorer
      </a>
    </>
  );
}

function SolanaAction({
  disabled = false,
  icon,
  isManagement = false,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  isManagement?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex flex-col items-center gap-2 rounded-xl p-3 text-sm font-semibold hover:bg-overlay-light disabled:cursor-not-allowed disabled:opacity-40 ${
        isManagement
          ? 'text-accent bg-surface-secondary disabled:hover:bg-surface-secondary'
          : 'bg-elevated-nohover text-default disabled:hover:bg-elevated-nohover'
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function SolanaSubscreen({
  children,
  onBack,
  title,
}: {
  children: ReactNode;
  onBack: () => void;
  title: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          className="flex size-8 items-center justify-center rounded-full hover:bg-overlay-light"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="font-semibold text-default">{title}</div>
      </div>
      {children}
    </div>
  );
}
