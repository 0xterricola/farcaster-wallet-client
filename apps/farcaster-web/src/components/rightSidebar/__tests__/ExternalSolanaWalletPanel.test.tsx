// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ExternalSolanaWalletPanel } from '~/components/rightSidebar/ExternalSolanaWalletPanel';

const mockRefetch = vi.fn();
const mockUseSolanaBalance = vi.fn(() => ({
  data: 1_250_000_000,
  isError: false,
  isLoading: false,
  refetch: mockRefetch,
}));

vi.mock('~/hooks/useSolanaBalance', () => ({
  useSolanaBalance: () => mockUseSolanaBalance(),
}));

vi.mock('react-qrcode-logo', () => ({
  QRCode: ({ value }: { value: string }) => (
    <div data-testid="solana-qr">{value}</div>
  ),
}));

vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('~/components/rightSidebar/ExternalSolanaWalletPortfolio', () => ({
  ExternalSolanaWalletPortfolio: ({ address }: { address: string }) => (
    <div data-testid="solana-portfolio">{address}</div>
  ),
}));

vi.mock('~/components/rightSidebar/ExternalSolanaWalletSend', () => ({
  ExternalSolanaWalletSend: ({ onBack }: { onBack: () => void }) => (
    <div>
      <span>Solana send screen</span>
      <button onClick={onBack}>Back from send</button>
    </div>
  ),
}));

describe('ExternalSolanaWalletPanel', () => {
  it('shows the Solana Mainnet address and SOL balance', () => {
    render(
      <ExternalSolanaWalletPanel
        address="SolanaAddress123456"
        onManageWallets={vi.fn()}
        signTransaction={vi.fn()}
      />,
    );

    expect(screen.getByText('Solana Mainnet')).toBeTruthy();
    expect(screen.getByText('1.25 SOL')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'View address on Solana Explorer' }),
    ).toBeTruthy();
    expect(screen.getByTestId('solana-portfolio').textContent).toBe(
      'SolanaAddress123456',
    );
  });

  it('enables Send while keeping unfinished actions disabled', () => {
    render(
      <ExternalSolanaWalletPanel
        address="SolanaAddress123456"
        onManageWallets={vi.fn()}
        signTransaction={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Receive' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
    ).toBe(false);
    for (const name of ['Trade', 'Activity']) {
      expect(
        screen.getByRole('button', { name }).hasAttribute('disabled'),
      ).toBe(true);
    }
  });

  it('opens the Receive screen with an address QR', () => {
    render(
      <ExternalSolanaWalletPanel
        address="SolanaAddress123456"
        onManageWallets={vi.fn()}
        signTransaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Receive' }));

    expect(screen.getByText('Receive on Solana')).toBeTruthy();
    expect(screen.getByTestId('solana-qr').textContent).toBe(
      'SolanaAddress123456',
    );
  });

  it('opens the Send screen and can return to the overview', () => {
    render(
      <ExternalSolanaWalletPanel
        address="SolanaAddress123456"
        onManageWallets={vi.fn()}
        signTransaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Solana send screen')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back from send' }));
    expect(screen.getByText('Solana Mainnet')).toBeTruthy();
  });

  it('opens the shared wallet-connections screen', () => {
    const onManageWallets = vi.fn();
    render(
      <ExternalSolanaWalletPanel
        address="SolanaAddress123456"
        onManageWallets={onManageWallets}
        signTransaction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Wallets' }));
    expect(onManageWallets).toHaveBeenCalledOnce();
  });
});
