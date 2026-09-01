import { AlertTriangleIcon, LoaderCircleIcon } from 'lucide-react';
import React, { ReactNode } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { WalletNetworkController } from '~/hooks/useWalletNetworkController';
import {
  DEFAULT_WALLET_CHAIN_ID,
  SELECTABLE_WALLET_CHAINS,
  walletNetworkName,
} from '~/utils/walletNetwork';

type Props = {
  network: WalletNetworkController;
  onDisconnect: () => void;
};

function ExternalWalletNetworkHeader({ network }: Pick<Props, 'network'>) {
  const confirmed =
    network.status === 'ready' || network.status === 'unavailable';
  return (
    <div className="mb-4 rounded-2xl border p-3 bg-elevated-nohover border-default">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-default">
          {confirmed ? 'Current network' : 'Dashboard network'}
        </span>
        <select
          aria-label={confirmed ? 'Current network' : 'Dashboard network'}
          className="rounded-lg border px-3 py-1.5 text-sm font-semibold bg-app border-default text-default"
          value={network.selectedChainId}
          disabled={!confirmed}
          onChange={(event) =>
            void network.switchNetwork(Number(event.target.value))
          }
        >
          {[...SELECTABLE_WALLET_CHAINS.values()].map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-1 text-xs text-muted">
        {confirmed
          ? 'Confirmed by your connected wallet.'
          : 'Wallet confirmation is required before wallet actions are enabled.'}
      </div>
    </div>
  );
}

function ExternalWalletNetworkBoundary({
  network,
  onDisconnect,
  children,
}: Props & { children: ReactNode }) {
  const selectedName = walletNetworkName(network.selectedChainId);

  if (network.status === 'ready') {
    return children;
  }

  if (network.status === 'unavailable') {
    return (
      <div className="flex flex-1 flex-col justify-center py-4">
        <div className="rounded-2xl border p-4 bg-elevated-nohover border-default">
          <div className="font-semibold text-default">
            {selectedName} wallet screens are not enabled yet
          </div>
          <div className="mt-2 text-sm text-muted">
            The wallet confirmed {selectedName}, but its balances and
            transaction screens remain locked until this network integration is
            complete.
          </div>
          <DefaultButton
            className="mt-4 w-full"
            onClick={() => void network.switchNetwork(DEFAULT_WALLET_CHAIN_ID)}
          >
            Return to Base
          </DefaultButton>
          <DefaultButton
            className="mt-2 w-full"
            variant="danger"
            onClick={onDisconnect}
          >
            Disconnect and choose another wallet
          </DefaultButton>
        </div>
      </div>
    );
  }

  const busy = [
    'disconnected',
    'loading',
    'checking',
    'switching',
    'adding',
  ].includes(network.status);
  const actualName = walletNetworkName(network.actualChainId);
  const requestedName = walletNetworkName(
    network.requestedChainId ?? network.selectedChainId,
  );
  const previousName = walletNetworkName(network.previousWorkingChainId);
  const canReturnToPrevious =
    network.previousWorkingChainId !== undefined &&
    network.previousWorkingChainId !== network.actualChainId &&
    network.previousWorkingChainId !== network.selectedChainId;

  if (busy) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center"
        role="status"
      >
        <LoaderCircleIcon
          aria-hidden="true"
          className="text-accent-primary size-7 animate-spin motion-reduce:animate-none"
        />
        <div className="mt-3 font-semibold text-default">
          {network.status === 'switching'
            ? `Waiting for ${requestedName}…`
            : network.status === 'adding'
              ? `Adding ${requestedName}…`
              : 'Checking wallet network…'}
        </div>
        <div className="mt-1 text-sm text-muted">
          Finish any open request in your wallet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col justify-center py-4">
      <div className="rounded-2xl border p-4 bg-elevated-nohover border-default">
        <div className="flex items-start gap-3">
          <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-orange-500" />
          <div>
            <div className="font-semibold text-default">
              Wallet network needs attention
            </div>
            <div className="mt-1 text-sm text-muted">
              Your wallet is on {actualName}. This wallet dashboard currently
              supports {selectedName}.
            </div>
          </div>
        </div>

        {network.error && (
          <div className="mt-3 rounded-xl p-3 text-sm text-muted bg-app">
            {network.error.message}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {network.actualChainId !== network.selectedChainId && (
            <DefaultButton
              className="w-full"
              onClick={() =>
                void network.switchNetwork(network.selectedChainId)
              }
            >
              Switch wallet to {selectedName}
            </DefaultButton>
          )}
          {network.error?.kind === 'network_not_added' && (
            <DefaultButton
              className="w-full"
              variant="secondary"
              onClick={() => void network.addNetwork(network.selectedChainId)}
            >
              Add {selectedName} to wallet
            </DefaultButton>
          )}
          {canReturnToPrevious && (
            <DefaultButton
              className="w-full"
              variant="secondary"
              onClick={() =>
                void network.switchNetwork(network.previousWorkingChainId!)
              }
            >
              Return to {previousName}
            </DefaultButton>
          )}
          <DefaultButton
            className="w-full"
            variant="secondary"
            onClick={() => void network.refreshNetwork()}
          >
            Check again
          </DefaultButton>
          <DefaultButton
            className="w-full"
            variant="danger"
            onClick={onDisconnect}
          >
            Disconnect and choose another wallet
          </DefaultButton>
        </div>
      </div>
      <div className="mt-3 text-center text-xs text-muted">
        Send, trade, and portfolio actions stay disabled until the wallet
        confirms {selectedName}.
      </div>
    </div>
  );
}

export { ExternalWalletNetworkBoundary, ExternalWalletNetworkHeader };
