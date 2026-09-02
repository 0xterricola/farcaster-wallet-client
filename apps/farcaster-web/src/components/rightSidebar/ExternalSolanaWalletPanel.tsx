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
import React, { ReactNode, useMemo, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { ExternalSolanaWalletPortfolio } from '~/components/rightSidebar/ExternalSolanaWalletPortfolio';
import { useSolanaBalance } from '~/hooks/useSolanaBalance';
import {
  formatSolBalance,
  SOLANA_MAINNET_NAME,
  solanaAddressUrl,
} from '~/utils/solanaWallet';

type SolanaView = 'overview' | 'receive';

export function ExternalSolanaWalletPanel({
  address,
  onManageWallets,
}: {
  address: string;
  onManageWallets: () => void;
}) {
  const [view, setView] = useState<SolanaView>('overview');
  const [copied, setCopied] = useState(false);
  const balance = useSolanaBalance(address);
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

  return (
    <>
      <div className="rounded-xl border p-3 bg-elevated-nohover border-default">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">
          Current network
        </div>
        <div className="mt-1 font-semibold text-default">
          {SOLANA_MAINNET_NAME}
        </div>
        <div className="mt-1 text-xs text-muted">
          Confirmed by your connected Solana wallet.
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
          disabled
          label="Send"
          icon={<ArrowUpFromLineIcon className="size-5" />}
          onClick={() => undefined}
        />
        <SolanaAction
          disabled
          label="Trade"
          icon={<ArrowLeftRightIcon className="size-5" />}
          onClick={() => undefined}
        />
        <SolanaAction
          disabled
          label="Activity"
          icon={<HistoryIcon className="size-5" />}
          onClick={() => undefined}
        />
        <SolanaAction
          label="Wallets"
          icon={<WalletIcon className="size-5" />}
          onClick={onManageWallets}
        />
      </div>

      <div className="mt-3 rounded-xl p-3 text-xs leading-relaxed text-muted bg-elevated-nohover">
        SOL balance and Receive are available. Send, Trade, and Activity stay
        disabled until their Solana transaction and history paths are ready.
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
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex flex-col items-center gap-2 rounded-xl p-3 text-sm font-semibold bg-elevated-nohover text-default hover:bg-overlay-light disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated-nohover"
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
