import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  CopyIcon,
} from 'lucide-react';
import { FormEvent, ReactNode, useMemo, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';
import { formatUnits, isAddress, parseEther, toHex } from 'viem';
import { useAccount, useBalance, useDisconnect } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { ExternalWalletSwap } from '~/components/rightSidebar/ExternalWalletSwap';
import { useWallet } from '~/contexts/WalletProvider';
import { truncateAddress } from '~/utils/ethereumUtils';

type WalletView = 'overview' | 'receive' | 'send' | 'trade';

function ExternalWalletPanel() {
  const { address, provider, clearPreferredWallet, openConnectModal } =
    useWallet();
  const { chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: balance, isLoading: isBalanceLoading } = useBalance({
    address,
  });
  const [view, setView] = useState<WalletView>('overview');
  const [copied, setCopied] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [transactionHash, setTransactionHash] = useState<string>();

  const formattedBalance = useMemo(() => {
    if (!balance) {
      return isBalanceLoading ? 'Loading…' : '—';
    }

    const value = Number(
      formatUnits(balance.value, balance.decimals),
    ).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
    return `${value} ${balance.symbol}`;
  }, [balance, isBalanceLoading]);

  if (!address) {
    return null;
  }

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleDisconnect = () => {
    disconnect();
    clearPreferredWallet();
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSendError(undefined);
    setTransactionHash(undefined);

    if (!provider) {
      setSendError('Wallet provider is unavailable. Reconnect and try again.');
      return;
    }

    if (!isAddress(recipient)) {
      setSendError('Enter a valid EVM address.');
      return;
    }

    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setSendError('Enter a valid amount.');
      return;
    }

    if (value <= 0n) {
      setSendError('Amount must be greater than zero.');
      return;
    }

    setIsSending(true);
    try {
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            to: recipient,
            value: toHex(value),
          },
        ],
      });
      setTransactionHash(String(hash));
      setAmount('');
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : 'Transaction was not sent.',
      );
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col overflow-y-auto border-t p-4 bg-app border-default"
      onClick={(event) => event.stopPropagation()}
    >
      {view === 'overview' && (
        <>
          <div className="rounded-2xl p-4 bg-elevated-nohover">
            <div className="text-sm text-muted">{chain?.name ?? 'Wallet'}</div>
            <div className="mt-1 text-3xl font-semibold text-default">
              {formattedBalance}
            </div>
            <button
              type="button"
              className="mt-3 flex items-center gap-2 text-sm text-muted hover:text-default"
              onClick={copyAddress}
            >
              <span>{truncateAddress(address, 6)}</span>
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <WalletAction
              label="Receive"
              icon={<ArrowDownToLineIcon className="size-5" />}
              onClick={() => setView('receive')}
            />
            <WalletAction
              label="Send"
              icon={<ArrowUpFromLineIcon className="size-5" />}
              onClick={() => setView('send')}
            />
            <WalletAction
              label="Trade"
              icon={<ArrowLeftRightIcon className="size-5" />}
              onClick={() => setView('trade')}
            />
          </div>

          <div className="mt-auto flex gap-2 pt-6">
            <DefaultButton
              className="flex-1"
              variant="secondary"
              onClick={openConnectModal}
            >
              Switch wallet
            </DefaultButton>
            <DefaultButton
              className="flex-1"
              variant="danger"
              onClick={handleDisconnect}
            >
              Disconnect
            </DefaultButton>
          </div>
        </>
      )}

      {view === 'receive' && (
        <WalletSubscreen title="Receive" onBack={() => setView('overview')}>
          <div className="flex flex-col items-center gap-4 py-4">
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
        </WalletSubscreen>
      )}

      {view === 'send' && (
        <WalletSubscreen title="Send" onBack={() => setView('overview')}>
          <form className="flex flex-col gap-4 pt-4" onSubmit={handleSend}>
            <label className="flex flex-col gap-2 text-sm text-default">
              Recipient
              <input
                className="rounded-xl border px-3 py-2 bg-app border-default"
                placeholder="0x…"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value.trim())}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-default">
              Amount ({balance?.symbol ?? 'ETH'})
              <input
                className="rounded-xl border px-3 py-2 bg-app border-default"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            {sendError && (
              <div className="rounded-xl bg-red-50 p-3 text-sm text-red-600">
                {sendError}
              </div>
            )}
            {transactionHash && (
              <div className="rounded-xl bg-green-50 p-3 text-sm text-green-700">
                <div>Transaction submitted</div>
                <div className="mt-1 break-all">
                  {truncateAddress(transactionHash, 8)}
                </div>
              </div>
            )}
            <DefaultButton type="submit" isLoading={isSending}>
              Review in wallet
            </DefaultButton>
          </form>
        </WalletSubscreen>
      )}

      {view === 'trade' && (
        <WalletSubscreen
          title="Trade on Base"
          onBack={() => setView('overview')}
        >
          <ExternalWalletSwap />
        </WalletSubscreen>
      )}
    </div>
  );
}

function WalletAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex flex-col items-center gap-2 rounded-xl p-3 text-sm font-semibold bg-elevated-nohover text-default hover:bg-overlay-light"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function WalletSubscreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-full hover:bg-overlay-light"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="font-semibold text-default">{title}</div>
      </div>
      {children}
    </div>
  );
}

export { ExternalWalletPanel };
