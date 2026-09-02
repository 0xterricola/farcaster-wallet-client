// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WalletFamilySelector } from '~/components/wallet/WalletFamilySelector';

describe('WalletFamilySelector', () => {
  it('identifies EVM as the selected family', () => {
    render(<WalletFamilySelector value="evm" onChange={vi.fn()} />);
    expect(
      screen.getByRole('tab', { name: 'EVM' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByRole('tab', { name: 'Solana' }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('reports a Solana family selection without changing it internally', () => {
    const onChange = vi.fn();
    render(<WalletFamilySelector value="evm" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Solana' }));
    expect(onChange).toHaveBeenCalledWith('solana');
    expect(
      screen.getByRole('tab', { name: 'EVM' }).getAttribute('aria-selected'),
    ).toBe('true');
  });
});
