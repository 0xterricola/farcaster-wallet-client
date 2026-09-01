// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExternalWalletNetworkBoundary,
  ExternalWalletNetworkHeader,
} from '~/components/rightSidebar/ExternalWalletNetworkStatus';
import { WalletNetworkController } from '~/hooks/useWalletNetworkController';

vi.mock('~/components/forms/buttons/DefaultButton', async () => {
  const { createElement } = await import('react');
  return {
    DefaultButton: ({
      children,
      isLoading: _isLoading,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      isLoading?: boolean;
    }) => createElement('button', props, children),
  };
});

function controller(
  changes: Partial<WalletNetworkController> = {},
): WalletNetworkController {
  return {
    actualChainId: 8453,
    selectedChainId: 8453,
    previousWorkingChainId: 8453,
    requestedChainId: undefined,
    status: 'ready',
    error: undefined,
    refreshNetwork: vi.fn(async () => true),
    switchNetwork: vi.fn(async () => true),
    addNetwork: vi.fn(async () => true),
    reportChainChanged: vi.fn(),
    ...changes,
  };
}

afterEach(cleanup);

describe('external wallet network UI', () => {
  it('labels Base as current only after the wallet confirms it', () => {
    render(<ExternalWalletNetworkHeader network={controller()} />);
    expect(
      (screen.getByLabelText('Current network') as HTMLSelectElement).value,
    ).toBe('8453');
    expect(
      screen.getByText('Confirmed by your connected wallet.'),
    ).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Ethereum' })).toBeTruthy();
  });

  it('shows confirmed Ethereum and allows its capability-gated dashboard', () => {
    const network = controller({
      actualChainId: 1,
      selectedChainId: 1,
      status: 'ready',
    });
    render(
      <>
        <ExternalWalletNetworkHeader network={network} />
        <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
          <div>Send transaction</div>
        </ExternalWalletNetworkBoundary>
      </>,
    );
    expect(
      (screen.getByLabelText('Current network') as HTMLSelectElement).value,
    ).toBe('1');
    expect(screen.getByText('Send transaction')).toBeTruthy();
  });

  it('blocks wallet content and explains a recognized network mismatch', () => {
    const network = controller({
      actualChainId: 56,
      status: 'mismatch',
    });
    render(
      <>
        <ExternalWalletNetworkHeader network={network} />
        <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
          <div>Send transaction</div>
        </ExternalWalletNetworkBoundary>
      </>,
    );
    expect(screen.queryByText('Send transaction')).toBeNull();
    expect(screen.getByText(/wallet is on BNB Smart Chain/i)).toBeTruthy();
    expect(
      (screen.getByLabelText('Dashboard network') as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });

  it('lets the user switch to Base or check the current wallet state', () => {
    const network = controller({
      actualChainId: 42161,
      status: 'mismatch',
    });
    render(
      <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
        content
      </ExternalWalletNetworkBoundary>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch wallet to Base' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(network.switchNetwork).toHaveBeenCalledWith(8453);
    expect(network.refreshNetwork).toHaveBeenCalledOnce();
  });

  it('offers to add Base only when the wallet reports it missing', () => {
    const network = controller({
      actualChainId: 1,
      status: 'error',
      error: {
        kind: 'network_not_added',
        requestedChainId: 8453,
        message: 'This network is not currently added to the wallet.',
      },
    });
    render(
      <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
        content
      </ExternalWalletNetworkBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add Base to wallet' }));
    expect(network.addNetwork).toHaveBeenCalledWith(8453);
  });

  it('distinguishes a cancelled request from an unsupported network', () => {
    const network = controller({
      actualChainId: 1,
      status: 'error',
      error: {
        kind: 'rejected',
        requestedChainId: 8453,
        message: 'Network change was cancelled in the wallet.',
      },
    });
    render(
      <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
        content
      </ExternalWalletNetworkBoundary>,
    );
    expect(
      screen.getByText('Network change was cancelled in the wallet.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add Base/i })).toBeNull();
  });

  it('keeps content hidden while checking the wallet', () => {
    const network = controller({ status: 'checking' });
    render(
      <ExternalWalletNetworkBoundary network={network} onDisconnect={vi.fn()}>
        <div>Trade tokens</div>
      </ExternalWalletNetworkBoundary>,
    );
    expect(screen.queryByText('Trade tokens')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Checking wallet network',
    );
  });

  it('allows disconnecting to choose a wallet that supports Base', () => {
    const disconnect = vi.fn();
    const network = controller({ actualChainId: 999, status: 'mismatch' });
    render(
      <ExternalWalletNetworkBoundary
        network={network}
        onDisconnect={disconnect}
      >
        content
      </ExternalWalletNetworkBoundary>,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Disconnect and choose another wallet',
      }),
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
