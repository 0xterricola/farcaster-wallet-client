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
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';
import { formatUnits } from 'viem';
import { base } from 'viem/chains';
import { useDisconnect } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { ExternalSolanaWalletPanel } from '~/components/rightSidebar/ExternalSolanaWalletPanel';
import { ExternalWalletActivity } from '~/components/rightSidebar/ExternalWalletActivity';
import {
  ExternalWalletNetworkBoundary,
  ExternalWalletNetworkHeader,
} from '~/components/rightSidebar/ExternalWalletNetworkStatus';
import { ExternalWalletPortfolio } from '~/components/rightSidebar/ExternalWalletPortfolio';
import { ExternalWalletSend } from '~/components/rightSidebar/ExternalWalletSend';
import { ExternalWalletSwap } from '~/components/rightSidebar/ExternalWalletSwap';
import { PreferredWalletSelector } from '~/components/wallet/PreferredWalletDialog';
import { WalletFamilySelector } from '~/components/wallet/WalletFamilySelector';
import { useMinimizableWindowContext } from '~/contexts/MinimizableWindowProvider';
import { useSolanaWallet } from '~/contexts/SolanaWalletProvider';
import { useWallet } from '~/contexts/WalletProvider';
import { useLifiAsset } from '~/hooks/useLifiWallet';
import { truncateAddress } from '~/utils/ethereumUtils';
import { LIFI_NATIVE_ADDRESS } from '~/utils/lifiWallet';
import { WalletFamily } from '~/utils/walletFamily';
import {
  DASHBOARD_CHAINS,
  walletChainCapabilities,
} from '~/utils/walletNetwork';
import { WalletTradeIntent } from '~/utils/walletTradeIntent';

type WalletView =
  | 'overview'
  | 'receive'
  | 'send'
  | 'trade'
  | 'activity'
  | 'connections';

function ExternalWalletPanel() {
  const { address, clearPreferredWallet, network } = useWallet();
  const { address: solanaAddress, signTransaction: signSolanaTransaction } =
    useSolanaWallet();
  const { disconnect } = useDisconnect();
  const { consumeWalletTradeIntent, walletTradeIntent } =
    useMinimizableWindowContext();
  const chain = DASHBOARD_CHAINS.get(network.selectedChainId) ?? base;
  const capabilities = walletChainCapabilities(chain.id);
  const {
    data: balance,
    isLoading: isBalanceLoading,
    isError: balanceError,
  } = useLifiAsset(
    network.status === 'ready' ? address : undefined,
    LIFI_NATIVE_ADDRESS,
    chain,
  );
  const [view, setView] = useState<WalletView>('overview');
  const [activeTradeIntent, setActiveTradeIntent] = useState<
    WalletTradeIntent | undefined
  >();
  const handlingTradeIntent = useRef<number | undefined>(undefined);
  const [dashboardFamily, setDashboardFamily] = useState<WalletFamily>(() =>
    !address && solanaAddress ? 'solana' : 'evm',
  );
  const visibleDashboardFamily: WalletFamily =
    dashboardFamily === 'evm' && !address && solanaAddress
      ? 'solana'
      : dashboardFamily === 'solana' && !solanaAddress && address
        ? 'evm'
        : dashboardFamily;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setView('overview');
  }, [network.selectedChainId]);

  useEffect(() => {
    if (
      !walletTradeIntent ||
      handlingTradeIntent.current === walletTradeIntent.id
    ) {
      return;
    }
    if (walletTradeIntent.family === 'solana') {
      if (!solanaAddress) {
        setDashboardFamily('solana');
        setView('connections');
        return;
      }
      handlingTradeIntent.current = walletTradeIntent.id;
      setDashboardFamily('solana');
      setActiveTradeIntent(walletTradeIntent);
      consumeWalletTradeIntent(walletTradeIntent.id);
      return;
    }
    if (!address) {
      setDashboardFamily('evm');
      setView('connections');
      return;
    }

    handlingTradeIntent.current = walletTradeIntent.id;
    const intent = walletTradeIntent;
    setDashboardFamily('evm');
    void (async () => {
      const ready =
        network.selectedChainId === intent.chainId && network.status === 'ready'
          ? true
          : await network.switchNetwork(intent.chainId);
      if (ready) {
        setActiveTradeIntent(intent);
        setView('trade');
      }
      consumeWalletTradeIntent(intent.id);
    })();
  }, [
    address,
    consumeWalletTradeIntent,
    network,
    solanaAddress,
    walletTradeIntent,
  ]);

  const formattedBalance = useMemo(() => {
    if (!balance || balanceError) {
      return isBalanceLoading ? 'Loading…' : '—';
    }

    const value = Number(
      formatUnits(balance.balance, balance.decimals),
    ).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
    return `${value} ${balance.symbol}`;
  }, [balance, isBalanceLoading, balanceError]);

  if (!address && !solanaAddress) {
    return (
      <div
        className="flex h-full flex-col overflow-y-auto border-t p-4 bg-app border-default"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4">
          <div className="text-lg font-semibold text-default">
            Wallet connections
          </div>
          <div className="mt-1 text-sm text-muted">
            EVM and Solana wallets connect independently.
          </div>
        </div>
        <PreferredWalletSelector
          defaultFamily={walletTradeIntent?.family ?? 'evm'}
          hideHeader
        />
      </div>
    );
  }

  if (view === 'connections') {
    return (
      <div
        className="flex h-full flex-col overflow-y-auto border-t p-4 bg-app border-default"
        onClick={(event) => event.stopPropagation()}
      >
        <WalletSubscreen
          title="Wallet connections"
          onBack={() => setView('overview')}
        >
          <div className="mt-4">
            <PreferredWalletSelector
              defaultFamily={
                walletTradeIntent?.family ?? visibleDashboardFamily
              }
              hideHeader
            />
          </div>
        </WalletSubscreen>
      </div>
    );
  }

  if (visibleDashboardFamily === 'solana' && solanaAddress) {
    return (
      <div
        className="flex h-full flex-col overflow-y-auto border-t p-4 bg-app border-default"
        onClick={(event) => event.stopPropagation()}
      >
        {address && (
          <div className="mb-4">
            <WalletFamilySelector
              value={visibleDashboardFamily}
              onChange={setDashboardFamily}
            />
          </div>
        )}
        <ExternalSolanaWalletPanel
          address={solanaAddress}
          onManageWallets={() => setView('connections')}
          signTransaction={signSolanaTransaction}
          tradeIntent={
            activeTradeIntent?.family === 'solana'
              ? activeTradeIntent
              : undefined
          }
        />
      </div>
    );
  }

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

  return (
    <div
      className="flex h-full flex-col overflow-y-auto border-t p-4 bg-app border-default"
      onClick={(event) => event.stopPropagation()}
    >
      {solanaAddress && (
        <div className="mb-4">
          <WalletFamilySelector
            value={visibleDashboardFamily}
            onChange={setDashboardFamily}
          />
        </div>
      )}
      <ExternalWalletNetworkHeader network={network} />
      <ExternalWalletNetworkBoundary
        network={network}
        onDisconnect={handleDisconnect}
      >
        {view === 'overview' && (
          <>
            <div className="rounded-2xl p-4 bg-elevated-nohover">
              <div className="text-sm text-muted">{chain.name}</div>
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

            <div className="mt-4 grid grid-cols-5 gap-2">
              <WalletAction
                label="Receive"
                icon={<ArrowDownToLineIcon className="size-5" />}
                onClick={() => setView('receive')}
              />
              <WalletAction
                label="Send"
                icon={<ArrowUpFromLineIcon className="size-5" />}
                onClick={() => setView('send')}
                disabled={!capabilities.send}
              />
              <WalletAction
                label="Trade"
                icon={<ArrowLeftRightIcon className="size-5" />}
                onClick={() => setView('trade')}
                disabled={!capabilities.swap}
              />
              <WalletAction
                label="Activity"
                icon={<HistoryIcon className="size-5" />}
                onClick={() => setView('activity')}
              />
              <WalletAction
                label="Wallets"
                icon={<WalletIcon className="size-5" />}
                onClick={() => setView('connections')}
                isManagement
              />
            </div>

            {(!capabilities.send || !capabilities.swap) && (
              <div className="mt-3 rounded-xl p-3 text-xs leading-relaxed text-muted bg-elevated-nohover">
                {chain.name} balances, Receive
                {capabilities.send ? ', and Send are' : ' are'} available.{' '}
                {capabilities.send ? 'Trade stays' : 'Send and Trade stay'}{' '}
                disabled until the remaining {chain.name} transaction paths are
                ready.
              </div>
            )}

            <ExternalWalletPortfolio
              key={`${chain.id}:${address.toLowerCase()}`}
              address={address}
              chain={chain}
            />
          </>
        )}

        {view === 'receive' && (
          <WalletSubscreen
            title={`Receive on ${chain.name}`}
            onBack={() => setView('overview')}
          >
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="text-center text-sm text-muted">
                Select {chain.name} as the sending network. This QR code
                contains only your address; it does not select the network for
                the sender.
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
          </WalletSubscreen>
        )}

        {view === 'send' && capabilities.send && (
          <WalletSubscreen
            title={`Send on ${chain.name}`}
            onBack={() => setView('overview')}
          >
            <ExternalWalletSend
              key={`${chain.id}:${address.toLowerCase()}`}
              address={address}
              chain={chain}
            />
          </WalletSubscreen>
        )}

        {view === 'trade' && capabilities.swap && (
          <WalletSubscreen
            title={`Trade on ${chain.name}`}
            onBack={() => setView('overview')}
          >
            <ExternalWalletSwap
              key={`${chain.id}:${address.toLowerCase()}:${activeTradeIntent?.id ?? 'manual'}`}
              chain={chain}
              initialBuyTokenAddress={
                activeTradeIntent?.family === 'evm' &&
                activeTradeIntent.chainId === chain.id
                  ? activeTradeIntent.tokenAddress
                  : undefined
              }
            />
          </WalletSubscreen>
        )}

        {view === 'activity' && (
          <WalletSubscreen
            title={`Activity on ${chain.name}`}
            onBack={() => setView('overview')}
          >
            <ExternalWalletActivity
              key={`${chain.id}:${address.toLowerCase()}`}
              address={address}
              chain={chain}
            />
          </WalletSubscreen>
        )}
      </ExternalWalletNetworkBoundary>
    </div>
  );
}

function WalletAction({
  label,
  icon,
  onClick,
  disabled = false,
  isManagement = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  isManagement?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex flex-col items-center gap-2 rounded-xl p-3 text-sm font-semibold hover:bg-overlay-light disabled:cursor-not-allowed disabled:opacity-40 ${
        isManagement
          ? 'text-accent bg-surface-secondary disabled:hover:bg-surface-secondary'
          : 'bg-elevated-nohover text-default disabled:hover:bg-elevated-nohover'
      }`}
      onClick={onClick}
      disabled={disabled}
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
