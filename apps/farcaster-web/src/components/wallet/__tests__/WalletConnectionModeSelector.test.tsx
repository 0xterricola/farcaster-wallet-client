// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WalletConnectionModeSelector } from '~/components/wallet/WalletConnectionModeSelector';
import { getWalletConnectionModeAvailability } from '~/utils/metamaskConnection';

describe('WalletConnectionModeSelector', () => {
  it('shows Unified, EVM, and Solana connection modes', () => {
    render(
      <WalletConnectionModeSelector
        availability={getWalletConnectionModeAvailability({
          unified: 'disconnected',
          evm: 'disconnected',
          solana: 'disconnected',
        })}
        onChange={vi.fn()}
        value="unified"
      />,
    );

    expect(screen.getByRole('tab', { name: 'Unified' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'EVM' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Solana' })).toBeTruthy();
  });

  it('disables independent modes while Unified is connected', () => {
    render(
      <WalletConnectionModeSelector
        availability={getWalletConnectionModeAvailability({
          unified: 'connected',
          evm: 'disconnected',
          solana: 'disconnected',
        })}
        onChange={vi.fn()}
        value="unified"
      />,
    );

    expect(
      screen.getByRole('tab', { name: 'EVM' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('tab', { name: 'Solana' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('tab', { name: 'Unified' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('does not select Unified while an independent wallet is connected', () => {
    const onChange = vi.fn();
    render(
      <WalletConnectionModeSelector
        availability={getWalletConnectionModeAvailability({
          unified: 'disconnected',
          evm: 'connected',
          solana: 'disconnected',
        })}
        onChange={onChange}
        value="evm"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Unified' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
