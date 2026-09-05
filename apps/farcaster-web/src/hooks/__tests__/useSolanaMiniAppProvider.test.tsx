// @vitest-environment jsdom

import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSolanaMiniAppProvider } from '~/hooks/useSolanaMiniAppProvider';

const mocks = vi.hoisted(() => ({
  address: undefined as string | undefined,
  closeConnectModal: vi.fn(),
  isConnectModalOpen: false,
  openConnectModal: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
  submitSignedSolanaTransaction: vi.fn(),
}));

vi.mock('~/contexts/SolanaWalletProvider', () => ({
  useSolanaWallet: () => ({
    address: mocks.address,
    signMessage: mocks.signMessage,
    signTransaction: mocks.signTransaction,
  }),
}));

vi.mock('~/contexts/WalletProvider', () => ({
  useWallet: () => ({
    closeConnectModal: mocks.closeConnectModal,
    isConnectModalOpen: mocks.isConnectModalOpen,
    openConnectModal: mocks.openConnectModal,
  }),
}));

vi.mock('~/utils/solanaTransfer', () => ({
  submitSignedSolanaTransaction: mocks.submitSignedSolanaTransaction,
}));

function transaction(): Transaction {
  const value = Object.create(Transaction.prototype) as Transaction;
  value.serialize = vi.fn(() => Buffer.from([1, 2, 3]));
  return value;
}

describe('useSolanaMiniAppProvider', () => {
  beforeEach(() => {
    mocks.address = undefined;
    mocks.isConnectModalOpen = false;
    mocks.closeConnectModal.mockReset();
    mocks.openConnectModal.mockReset();
    mocks.signMessage.mockReset();
    mocks.signTransaction.mockReset();
    mocks.submitSignedSolanaTransaction.mockReset();
  });

  it('returns the selected external Solana account when already connected', async () => {
    mocks.address = 'SolanaAddress123';
    const view = renderHook(() => useSolanaMiniAppProvider());

    await expect(
      view.result.current.request({ method: 'connect' }),
    ).resolves.toEqual({ publicKey: 'SolanaAddress123' });
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });

  it('opens the wallet chooser on Solana and waits for the connection', async () => {
    const view = renderHook(() => useSolanaMiniAppProvider());
    let connecting!: Promise<{ publicKey: string }>;
    act(() => {
      connecting = view.result.current.request({ method: 'connect' });
    });
    expect(mocks.openConnectModal).toHaveBeenCalledWith('solana');

    mocks.isConnectModalOpen = true;
    view.rerender();
    mocks.address = 'ConnectedAfterPrompt';
    view.rerender();

    await expect(connecting).resolves.toEqual({
      publicKey: 'ConnectedAfterPrompt',
    });
    expect(mocks.closeConnectModal).toHaveBeenCalledOnce();
  });

  it('rejects connect when the wallet chooser is closed', async () => {
    const view = renderHook(() => useSolanaMiniAppProvider());
    let connecting!: Promise<{ publicKey: string }>;
    act(() => {
      connecting = view.result.current.request({ method: 'connect' });
    });
    mocks.isConnectModalOpen = true;
    view.rerender();
    mocks.isConnectModalOpen = false;
    view.rerender();

    await expect(connecting).rejects.toThrow(
      'Solana wallet connection cancelled.',
    );
  });

  it('converts Mini App base64 messages to wallet bytes and back', async () => {
    mocks.signMessage.mockResolvedValue(new Uint8Array([4, 5, 6]));
    const view = renderHook(() => useSolanaMiniAppProvider());

    await expect(
      view.result.current.request({
        method: 'signMessage',
        params: { message: btoa(String.fromCharCode(1, 2, 3)) },
      }),
    ).resolves.toEqual({ signature: btoa(String.fromCharCode(4, 5, 6)) });
    expect(mocks.signMessage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it('signs a Mini App transaction in the external wallet', async () => {
    const input = transaction();
    const reconstructed = transaction();
    const from = vi.spyOn(Transaction, 'from').mockReturnValue(reconstructed);
    mocks.signTransaction.mockResolvedValue(new Uint8Array([4, 5, 6]));
    const view = renderHook(() => useSolanaMiniAppProvider());

    const result = await view.result.current.request({
      method: 'signTransaction',
      params: { transaction: input },
    });

    expect(result.signedTransaction).toBe(reconstructed);
    expect(mocks.signTransaction).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
    );
    expect(from).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    from.mockRestore();
  });

  it('submits the externally signed transaction through the Solana relay', async () => {
    const input = transaction();
    const signed = transaction();
    const from = vi.spyOn(Transaction, 'from').mockReturnValue(signed);
    mocks.signTransaction.mockResolvedValue(new Uint8Array([4, 5, 6]));
    mocks.submitSignedSolanaTransaction.mockResolvedValue('signature-123');
    const view = renderHook(() => useSolanaMiniAppProvider());

    await expect(
      view.result.current.request({
        method: 'signAndSendTransaction',
        params: { transaction: input },
      }),
    ).resolves.toEqual({ signature: 'signature-123' });
    expect(mocks.submitSignedSolanaTransaction).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
    );
    from.mockRestore();
  });

  it('preserves versioned Mini App transactions after external signing', async () => {
    const input = Object.create(
      VersionedTransaction.prototype,
    ) as VersionedTransaction;
    input.serialize = vi.fn(() => new Uint8Array([1, 2, 3]));
    const reconstructed = Object.create(
      VersionedTransaction.prototype,
    ) as VersionedTransaction;
    const deserialize = vi
      .spyOn(VersionedTransaction, 'deserialize')
      .mockReturnValue(reconstructed);
    mocks.signTransaction.mockResolvedValue(new Uint8Array([4, 5, 6]));
    const view = renderHook(() => useSolanaMiniAppProvider());

    const result = await view.result.current.request({
      method: 'signTransaction',
      params: { transaction: input },
    });

    expect(result.signedTransaction).toBe(reconstructed);
    expect(deserialize).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
    deserialize.mockRestore();
  });
});
