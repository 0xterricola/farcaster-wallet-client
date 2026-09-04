import * as Dialog from '@radix-ui/react-dialog';
import { AnalyticsEvent } from 'farcaster-analytics';
import { useEmbeddedWalletsQuery } from 'farcaster-client-hooks';
import { CheckIcon, XIcon } from 'lucide-react';
import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
import { base } from 'viem/chains';
import { Connector, useAccount, useConnect, useDisconnect } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { Image } from '~/components/images/Image';
import { WalletFamilySelector } from '~/components/wallet/WalletFamilySelector';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useSolanaWallet } from '~/contexts/SolanaWalletProvider';
import { useWallet } from '~/contexts/WalletProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useIsAdmin } from '~/hooks/data/useIsAdmin';
import { DetectedSolanaWallet } from '~/hooks/useDetectedSolanaWallets';
import { WALLET_CONNECT_WALLET_NAME } from '~/utils/solanaWalletConnect';
import { WalletFamily } from '~/utils/walletFamily';

function getMiniAppPermission(
  wallet: NonNullable<
    ReturnType<typeof useEmbeddedWalletsQuery>['data']
  >['wallets'][number],
) {
  const miniAppPolicy = wallet.miniAppPolicy as
    | typeof wallet.miniAppPolicy
    | 'allowed'
    | 'blocked';
  return typeof miniAppPolicy === 'string'
    ? miniAppPolicy
    : miniAppPolicy.default;
}

const WALLET_CONNECT_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjgiIGhlaWdodD0iMjgiIHZpZXdCb3g9IjAgMCAyOCAyOCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4lMEE8cmVjdCB3aWR0aD0iMjgiIGhlaWdodD0iMjgiIGZpbGw9IiMzQjk5RkMiLz4lMEE8cGF0aCBkPSJNOC4zODk2OSAxMC4zNzM5QzExLjQ4ODIgNy4yNzUzOCAxNi41MTE4IDcuMjc1MzggMTkuNjEwMyAxMC4zNzM5TDE5Ljk4MzIgMTAuNzQ2OEMyMC4xMzgyIDEwLjkwMTcgMjAuMTM4MiAxMS4xNTI5IDE5Ljk4MzIgMTEuMzA3OEwxOC43MDc2IDEyLjU4MzVDMTguNjMwMSAxMi42NjA5IDE4LjUwNDUgMTIuNjYwOSAxOC40MjcxIDEyLjU4MzVMMTcuOTEzOSAxMi4wNzAzQzE1Ljc1MjMgOS45MDg3IDEyLjI0NzcgOS45MDg3IDEwLjA4NjEgMTIuMDcwM0w5LjUzNjU1IDEyLjYxOThDOS40NTkwOSAxMi42OTczIDkuMzMzNSAxMi42OTczIDkuMjU2MDQgMTIuNjE5OEw3Ljk4MDM5IDExLjM0NDJDNy44MjU0NyAxMS4xODkzIDcuODI1NDcgMTAuOTM4MSA3Ljk4MDM5IDEwLjc4MzJMOC4zODk2OSAxMC4zNzM5Wk0yMi4yNDg1IDEzLjAxMkwyMy4zODM4IDE0LjE0NzRDMjMuNTM4NyAxNC4zMDIzIDIzLjUzODcgMTQuNTUzNSAyMy4zODM4IDE0LjcwODRMMTguMjY0NSAxOS44Mjc3QzE4LjEwOTYgMTkuOTgyNyAxNy44NTg0IDE5Ljk4MjcgMTcuNzAzNSAxOS44Mjc3QzE3LjcwMzUgMTkuODI3NyAxNy43MDM1IDE5LjgyNzcgMTcuNzAzNSAxOS44Mjc3TDE0LjA3MDIgMTYuMTk0NEMxNC4wMzE0IDE2LjE1NTcgMTMuOTY4NiAxNi4xNTU3IDEzLjkyOTkgMTYuMTk0NEMxMy45Mjk5IDE2LjE5NDQgMTMuOTI5OSAxNi4xOTQ0IDEzLjkyOTkgMTYuMTk0NEwxMC4yOTY2IDE5LjgyNzdDMTAuMTQxNyAxOS45ODI3IDkuODkwNTMgMTkuOTgyNyA5LjczNTYxIDE5LjgyNzhDOS43MzU2IDE5LjgyNzggOS43MzU2IDE5LjgyNzcgOS43MzU2IDE5LjgyNzdMNC42MTYxOSAxNC43MDgzQzQuNDYxMjcgMTQuNTUzNCA0LjQ2MTI3IDE0LjMwMjIgNC42MTYxOSAxNC4xNDczTDUuNzUxNTIgMTMuMDEyQzUuOTA2NDUgMTIuODU3IDYuMTU3NjMgMTIuODU3IDYuMzEyNTUgMTMuMDEyTDkuOTQ1OTUgMTYuNjQ1NEM5Ljk4NDY4IDE2LjY4NDEgMTAuMDQ3NSAxNi42ODQxIDEwLjA4NjIgMTYuNjQ1NEMxMC4wODYyIDE2LjY0NTQgMTAuMDg2MiAxNi42NDU0IDEwLjA4NjIgMTYuNjQ1NEwxMy43MTk0IDEzLjAxMkMxMy44NzQzIDEyLjg1NyAxNC4xMjU1IDEyLjg1NyAxNC4yODA1IDEzLjAxMkMxNC4yODA1IDEzLjAxMiAxNC4yODA1IDEzLjAxMiAxNC4yODA1IDEzLjAxMkwxNy45MTM5IDE2LjY0NTRDMTcuOTUyNiAxNi42ODQxIDE4LjAxNTQgMTYuNjg0MSAxOC4wNTQxIDE2LjY0NTRMMjEuNjg3NCAxMy4wMTJDMjEuODQyNCAxMi44NTcxIDIyLjA5MzYgMTIuODU3MSAyMi4yNDg1IDEzLjAxMloiIGZpbGw9IndoaXRlIi8+JTBBPC9zdmc+';

export function PreferredWalletDialog() {
  const { closeConnectModal } = useWallet();

  return (
    <Dialog.Root
      defaultOpen
      onOpenChange={(open) => {
        if (!open) {
          closeConnectModal();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-10 animate-overlay-show bg-overlay" />
        <Dialog.Content
          className="focus:outline-hidden fixed left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 animate-content-show"
          onPointerDownOutside={(e) => {
            // Allow interactions with Warplet
            if (
              e.target instanceof HTMLElement &&
              e.target.closest('#warplet')
            ) {
              e.preventDefault();
            }
          }}
        >
          <div className="border-top border-left border-right relative w-[424px] overflow-hidden rounded-xl p-4 bg-app">
            <PreferredWalletSelector modal />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PreferredWalletSelector({
  defaultFamily = 'evm',
  modal,
  hideHeader = false,
}: {
  defaultFamily?: WalletFamily;
  modal?: boolean;
  hideHeader?: boolean;
}) {
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const {
    clearPreferredWallet,
    closeConnectModal,
    connectors,
    setPreferredWallet,
    preferredWallet,
  } = useWallet();
  const [localPreferredWallet, setLocalPreferredWallet] = useState<string>();
  const [walletFamily, setWalletFamily] = useState<WalletFamily>(defaultFamily);
  const [evmError, setEvmError] = useState<string>();
  const [isEvmConnecting, setIsEvmConnecting] = useState(false);
  const {
    address: solanaAddress,
    connect: connectSolana,
    detectedWallets: solanaWallets,
    disconnect: disconnectSolana,
    error: solanaError,
    status: solanaStatus,
    wallet: solanaWallet,
  } = useSolanaWallet();
  const {
    address: externalWalletAddress,
    connector: existingConnector,
    isConnected: isExternalWalletConnected,
  } = useAccount();
  const [showAllWallets, setShowAllWallets] = useState(!modal);
  const { trackEvent } = useAnalytics();
  const currentUser = useCurrentUser();
  const isAdmin = useIsAdmin();
  const { data: embeddedWalletsData } = useEmbeddedWalletsQuery({
    params: { includePrivate: true },
    scopeKey: currentUser.fid,
    enabled: isAdmin,
  });
  const blockedPrivateWallets = isAdmin
    ? (embeddedWalletsData?.wallets.filter(
        (wallet) =>
          !wallet.isPrimary && getMiniAppPermission(wallet) !== 'allowed',
      ) ?? [])
    : [];

  const handleSelectPreferredWallet = useCallback(
    (wallet: string) => {
      setLocalPreferredWallet(wallet);
      if (!modal) {
        setPreferredWallet(wallet);
      }
    },
    [modal, setPreferredWallet],
  );

  const handleConnect = useCallback(
    async (connector: Connector) => {
      setEvmError(undefined);
      setIsEvmConnecting(true);
      try {
        // Default to Base when establishing a new EVM connection.
        if (
          !isExternalWalletConnected ||
          !existingConnector ||
          connector.id !== existingConnector.id
        ) {
          await connectAsync({ connector: connector, chainId: base.id });
        }
        handleSelectPreferredWallet(connector.id);
      } catch (connectFailure) {
        setEvmError(
          connectFailure instanceof Error
            ? connectFailure.message
            : 'EVM connection failed.',
        );
      } finally {
        setIsEvmConnecting(false);
      }
    },
    [
      connectAsync,
      existingConnector,
      handleSelectPreferredWallet,
      isExternalWalletConnected,
    ],
  );

  const handleEvmDisconnect = useCallback(async () => {
    setEvmError(undefined);
    try {
      await disconnectAsync();
      if (preferredWallet !== 'warpcast') {
        setLocalPreferredWallet(undefined);
        clearPreferredWallet();
      }
    } catch (disconnectFailure) {
      setEvmError(
        disconnectFailure instanceof Error
          ? disconnectFailure.message
          : 'EVM disconnect failed.',
      );
    }
  }, [clearPreferredWallet, disconnectAsync, preferredWallet]);

  const handleDone = useCallback(() => {
    if (walletFamily === 'solana') {
      if (solanaAddress) {
        closeConnectModal();
      }
      return;
    }
    if (!localPreferredWallet) {
      return;
    }

    setPreferredWallet(localPreferredWallet);
    trackEvent(AnalyticsEvent.SetPreferredWallet, {
      wallet: localPreferredWallet,
    });

    closeConnectModal();
  }, [
    closeConnectModal,
    localPreferredWallet,
    setPreferredWallet,
    solanaAddress,
    trackEvent,
    walletFamily,
  ]);

  const handleSolanaConnect = useCallback(
    async (wallet: DetectedSolanaWallet) => {
      await connectSolana(wallet);
    },
    [connectSolana],
  );

  useEffect(() => {
    setLocalPreferredWallet(preferredWallet);
  }, [preferredWallet]);

  return (
    <div className="flex flex-col gap-4 ">
      {!hideHeader && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between">
            <div className="text-lg font-semibold">Connect wallets</div>
            {modal && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  closeConnectModal();
                }}
                className="flex cursor-pointer "
              >
                <XIcon className="size-6 text-muted hover:text-foreground" />
              </div>
            )}
          </div>
          <div className="text-md text-muted">
            EVM and Solana wallets stay connected independently. Miniapps that
            request an EVM wallet use your selected EVM connection.
          </div>
        </div>
      )}
      <WalletFamilySelector value={walletFamily} onChange={setWalletFamily} />
      {walletFamily === 'evm' ? (
        <div className="flex flex-col gap-3 rounded-xl p-3 bg-surface-secondary">
          <div>
            <div className="font-semibold text-default">EVM wallets</div>
            <div className="text-sm text-muted">
              Connect a detected browser wallet, or scan a QR code with
              WalletConnect, without changing your Solana connection.
            </div>
          </div>
          <div className="flex flex-col overflow-hidden rounded-lg bg-app">
            {blockedPrivateWallets.map((wallet, index) => (
              <Fragment key={wallet.id}>
                <WalletOption
                  name={wallet.displayName}
                  description="Blocked for mini-apps by default"
                  onClick={() => undefined}
                  isDisabled
                />
                {(index !== blockedPrivateWallets.length - 1 ||
                  connectors.length > 0) && (
                  <div className="h-px w-full bg-surface-secondary" />
                )}
              </Fragment>
            ))}
            {connectors.map((connector, index) => {
              if (!showAllWallets && connector.id !== localPreferredWallet) {
                return null;
              }

              const icon =
                connector.id === 'walletConnect'
                  ? WALLET_CONNECT_ICON
                  : connector.icon;

              return (
                <Fragment key={connector.id}>
                  <WalletOption
                    key={index}
                    name={connector.name}
                    description={
                      isExternalWalletConnected &&
                      connector.id === existingConnector?.id &&
                      externalWalletAddress
                        ? `${externalWalletAddress.slice(0, 6)}…${externalWalletAddress.slice(-4)}`
                        : undefined
                    }
                    icon={icon}
                    onClick={() => handleConnect(connector)}
                    isSelected={
                      localPreferredWallet === connector.id &&
                      isExternalWalletConnected &&
                      existingConnector?.id === connector.id
                    }
                    isConnected={
                      isExternalWalletConnected &&
                      existingConnector &&
                      connector.id === existingConnector.id
                    }
                    isInstalled={connector.id !== 'walletConnect'}
                    isDisabled={isEvmConnecting}
                  />
                  {index !== connectors.length - 1 && (
                    <div className="h-px w-full bg-surface-secondary" />
                  )}
                </Fragment>
              );
            })}
            {!showAllWallets && localPreferredWallet !== 'walletConnect' && (
              <WalletOption
                name="External Wallet"
                icon={
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M20 3L15 3C14.4477 3 14 3.44772 14 4L14 9C14 9.55228 14.4477 10 15 10L20 10C20.5523 10 21 9.55228 21 9L21 4C21 3.44772 20.5523 3 20 3Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-default"
                    />
                    <path
                      d="M10 21L10 8C10 7.73478 9.89464 7.48043 9.70711 7.29289C9.51957 7.10536 9.26522 7 9 7L4 7C3.73478 7 3.48043 7.10536 3.29289 7.29289C3.10536 7.48043 3 7.73478 3 8L3 20C3 20.2652 3.10536 20.5196 3.29289 20.7071C3.48043 20.8946 3.73478 21 4 21L16 21C16.2652 21 16.5196 20.8946 16.7071 20.7071C16.8946 20.5196 17 20.2652 17 20L17 15C17 14.7348 16.8946 14.4804 16.7071 14.2929C16.5196 14.1054 16.2652 14 16 14L3 14"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-default"
                    />
                  </svg>
                }
                onClick={() => {
                  const walletConnectConnector = connectors.find(
                    (connector) => connector.id === 'walletConnect',
                  );
                  if (walletConnectConnector) {
                    void handleConnect(walletConnectConnector);
                    return;
                  }

                  setShowAllWallets(true);
                }}
              />
            )}
          </div>
          {evmError && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
              {evmError}
            </div>
          )}
          {isExternalWalletConnected && (
            <DefaultButton
              className="w-full"
              variant="secondary"
              onClick={() => void handleEvmDisconnect()}
            >
              Disconnect EVM wallet
            </DefaultButton>
          )}
          <div className="text-xs text-faint">
            This EVM connection is independent from your Solana wallet and its
            WalletConnect session.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl p-3 bg-surface-secondary">
          <div>
            <div className="font-semibold text-default">Solana wallets</div>
            <div className="text-sm text-muted">
              Connect a detected browser wallet, or scan a QR code with
              WalletConnect, without changing your EVM connection.
            </div>
          </div>
          {solanaWallets.length ? (
            <div className="flex flex-col overflow-hidden rounded-lg bg-app">
              {solanaWallets.map((wallet, index) => (
                <Fragment key={`${wallet.name}:${wallet.version}`}>
                  <WalletOption
                    name={wallet.name}
                    description={
                      solanaWallet?.name === wallet.name && solanaAddress
                        ? `${solanaAddress.slice(0, 4)}…${solanaAddress.slice(-4)}`
                        : wallet.name === WALLET_CONNECT_WALLET_NAME
                          ? 'Scan with a mobile wallet'
                          : 'Detected Solana wallet'
                    }
                    icon={wallet.icon}
                    onClick={() => void handleSolanaConnect(wallet)}
                    isConnected={
                      solanaWallet?.name === wallet.name &&
                      Boolean(solanaAddress)
                    }
                    isSelected={
                      solanaWallet?.name === wallet.name &&
                      Boolean(solanaAddress)
                    }
                    isInstalled={wallet.name !== WALLET_CONNECT_WALLET_NAME}
                    isDisabled={solanaStatus === 'connecting'}
                  />
                  {index !== solanaWallets.length - 1 && (
                    <div className="h-px w-full bg-surface-secondary" />
                  )}
                </Fragment>
              ))}
            </div>
          ) : (
            <div className="rounded-lg p-3 text-sm text-muted bg-app">
              No compatible Solana browser wallet detected.
            </div>
          )}
          {solanaError && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
              {solanaError}
            </div>
          )}
          {solanaAddress && (
            <DefaultButton
              className="w-full"
              variant="secondary"
              onClick={() => void disconnectSolana()}
            >
              Disconnect Solana wallet
            </DefaultButton>
          )}
          <div className="text-xs text-faint">
            This Solana connection is independent from your EVM wallet and its
            WalletConnect session.
          </div>
        </div>
      )}
      {modal && (
        <DefaultButton
          className="h-11"
          onClick={handleDone}
          size="lg"
          disabled={
            walletFamily === 'solana' ? !solanaAddress : !localPreferredWallet
          }
        >
          Done
        </DefaultButton>
      )}
    </div>
  );
}

function WalletOption({
  name,
  description,
  icon,
  onClick,
  isSelected,
  isConnected,
  isInstalled,
  isDisabled,
}: {
  name: string;
  description?: string;
  icon?: string | ReactNode;
  onClick: () => void;
  isSelected?: boolean;
  isConnected?: boolean;
  isInstalled?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <div
      className={`flex flex-row items-center justify-between rounded-lg p-3 transition-colors ${
        isDisabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:bg-hover active:bg-elevated'
      }`}
      onClick={isDisabled ? undefined : onClick}
    >
      <div className="flex flex-row items-center gap-3">
        {typeof icon === 'string' ? (
          <Image src={icon} alt={name} className="size-[24px] rounded-lg" />
        ) : icon ? (
          icon
        ) : (
          <div className="size-[24px] rounded-lg bg-overlay-light" />
        )}
        <div className="flex flex-col">
          <div className="text-default">{name}</div>
          {description && (
            <div className="text-sm text-muted">{description}</div>
          )}
        </div>
      </div>
      {isSelected ? (
        <CheckIcon className="text-success" />
      ) : isConnected ? (
        <div className="text-xs text-muted">Connected</div>
      ) : isInstalled ? (
        <div className="text-xs text-faint">Installed</div>
      ) : null}
    </div>
  );
}
