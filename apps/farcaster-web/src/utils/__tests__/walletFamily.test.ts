import { describe, expect, it } from 'vitest';

import {
  EMPTY_WALLET_CONNECTIONS,
  isWalletFamily,
  updateWalletFamilyConnection,
  WALLET_FAMILIES,
  WALLET_FAMILY_DETAILS,
} from '~/utils/walletFamily';

describe('wallet family model', () => {
  it('keeps EVM and Solana as distinct supported families', () => {
    expect(WALLET_FAMILIES).toEqual(['evm', 'solana']);
    expect(WALLET_FAMILY_DETAILS.evm.description).toContain('Base');
    expect(WALLET_FAMILY_DETAILS.solana.description).toBe('Solana Mainnet');
  });

  it('rejects network names and arbitrary strings as wallet families', () => {
    expect(isWalletFamily('evm')).toBe(true);
    expect(isWalletFamily('solana')).toBe(true);
    expect(isWalletFamily('base')).toBe(false);
    expect(isWalletFamily('mainnet-beta')).toBe(false);
    expect(isWalletFamily(undefined)).toBe(false);
  });

  it('keeps EVM and Solana connections live independently', () => {
    const evmConnected = updateWalletFamilyConnection(
      EMPTY_WALLET_CONNECTIONS,
      'evm',
      {
        status: 'connected',
        address: '0x1111111111111111111111111111111111111111',
        walletName: 'MetaMask',
      },
    );
    const bothConnected = updateWalletFamilyConnection(evmConnected, 'solana', {
      status: 'connected',
      address: '11111111111111111111111111111111',
      walletName: 'Phantom',
    });

    expect(bothConnected.evm).toMatchObject({
      status: 'connected',
      walletName: 'MetaMask',
    });
    expect(bothConnected.solana).toMatchObject({
      status: 'connected',
      walletName: 'Phantom',
    });
  });
});
