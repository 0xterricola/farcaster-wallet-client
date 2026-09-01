import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  CopyIcon,
} from 'lucide-react';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';
import { formatUnits } from 'viem';
import { base } from 'viem/chains';
import { useConnect, useDisconnect } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { Image } from '~/components/images/Image';
import {
  ExternalWalletNetworkBoundary,
  ExternalWalletNetworkHeader,
} from '~/components/rightSidebar/ExternalWalletNetworkStatus';
import { ExternalWalletPortfolio } from '~/components/rightSidebar/ExternalWalletPortfolio';
import { ExternalWalletSend } from '~/components/rightSidebar/ExternalWalletSend';
import { ExternalWalletSwap } from '~/components/rightSidebar/ExternalWalletSwap';
import { useWallet } from '~/contexts/WalletProvider';
import { useLifiAsset } from '~/hooks/useLifiWallet';
import { truncateAddress } from '~/utils/ethereumUtils';
import { LIFI_NATIVE_ADDRESS } from '~/utils/lifiWallet';
import {
  DASHBOARD_CHAINS,
  walletChainCapabilities,
} from '~/utils/walletNetwork';

type WalletView = 'overview' | 'receive' | 'send' | 'trade';

function ExternalWalletPanel() {
  const {
    address,
    clearPreferredWallet,
    connectors,
    network,
    setPreferredWallet,
  } = useWallet();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
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
  const [copied, setCopied] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string>();

  useEffect(() => {
    setView('overview');
  }, [network.selectedChainId]);

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

  const browserWallets = connectors.filter(
    (connector) => connector.type === 'injected',
  );

  if (!address) {
    const connectWallet = async (connectorId: string) => {
      const selectedConnector = connectors.find(
        (connector) => connector.id === connectorId,
      );

      if (!selectedConnector) {
        setConnectError(
          connectorId === 'walletConnect'
            ? 'WalletConnect is not configured. Add a Reown project ID and reload.'
            : 'That browser wallet is no longer available. Reload and try again.',
        );
        return;
      }

      setConnectError(undefined);
      setIsConnecting(true);
      try {
        await connectAsync({
          connector: selectedConnector,
          chainId: base.id,
        });
        setPreferredWallet(selectedConnector.id);
      } catch (error) {
        setConnectError(
          error instanceof Error ? error.message : 'Wallet connection failed.',
        );
      } finally {
        setIsConnecting(false);
      }
    };

    return (
      <div
        className="flex h-full flex-col items-center justify-center border-t p-6 text-center bg-app border-default"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex size-14 items-center justify-center rounded-2xl bg-elevated-nohover">
          <ArrowDownToLineIcon className="size-7 text-default" />
        </div>
        <div className="mt-4 text-xl font-semibold text-default">
          Connect a wallet
        </div>
        <div className="mt-2 max-w-72 text-sm text-muted">
          Connect once to use the same wallet here and in miniapps.
        </div>
        {connectError && (
          <div className="mt-4 w-full rounded-xl bg-red-50 p-3 text-sm text-red-600">
            {connectError}
          </div>
        )}
        <div className="mt-6 flex w-full flex-col gap-2">
          {browserWallets.map((connector) => (
            <DefaultButton
              key={connector.uid}
              className="w-full"
              variant="secondary"
              isLoading={isConnecting}
              onClick={() => void connectWallet(connector.id)}
            >
              <span className="flex items-center justify-center gap-2">
                {connector.icon && (
                  <Image
                    src={connector.icon}
                    alt=""
                    className="size-5 rounded"
                  />
                )}
                {connector.name}
              </span>
            </DefaultButton>
          ))}
          <DefaultButton
            className="w-full"
            isLoading={isConnecting}
            onClick={() => void connectWallet('walletConnect')}
          >
            Connect with WalletConnect
          </DefaultButton>
        </div>
      </div>
    );
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
                disabled={!capabilities.send}
              />
              <WalletAction
                label="Trade"
                icon={<ArrowLeftRightIcon className="size-5" />}
                onClick={() => setView('trade')}
                disabled={!capabilities.swap}
              />
            </div>

            {(!capabilities.send || !capabilities.swap) && (
              <div className="mt-3 rounded-xl p-3 text-xs leading-relaxed text-muted bg-elevated-nohover">
                {chain.name} balances and Receive are available. Send and Trade
                stay disabled until their {chain.name} transaction paths are
                ready.
              </div>
            )}

            <ExternalWalletPortfolio
              key={`${chain.id}:${address.toLowerCase()}`}
              address={address}
              chain={chain}
            />

            <div className="mt-auto pt-6">
              <DefaultButton
                className="w-full"
                variant="danger"
                onClick={handleDisconnect}
              >
                Disconnect
              </DefaultButton>
            </div>
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
            title="Send on Base"
            onBack={() => setView('overview')}
          >
            <ExternalWalletSend key={address.toLowerCase()} address={address} />
          </WalletSubscreen>
        )}

        {view === 'trade' && capabilities.swap && (
          <WalletSubscreen
            title="Trade on Base"
            onBack={() => setView('overview')}
          >
            <ExternalWalletSwap key={address.toLowerCase()} />
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
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex flex-col items-center gap-2 rounded-xl p-3 text-sm font-semibold bg-elevated-nohover text-default hover:bg-overlay-light disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated-nohover"
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
