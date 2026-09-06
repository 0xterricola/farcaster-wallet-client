import { describe, expect, it, vi } from 'vitest';

import {
  connectUnifiedMetaMask,
  getUnifiedAddressesFromSession,
  getWalletConnectionModeAvailability,
  METAMASK_UNIFIED_SCOPES,
  MetaMaskUnifiedCore,
  shouldReleaseIndependentConnection,
  validateUnifiedConnection,
} from '~/utils/metamaskConnection';

describe('shouldReleaseIndependentConnection', () => {
  it.each(['connecting', 'connected'] as const)(
    'releases a restored independent connection while Unified is %s',
    (unifiedStatus) => {
      expect(
        shouldReleaseIndependentConnection(unifiedStatus, 'connected'),
      ).toBe(true);
    },
  );

  it('does not release an independent connection when Unified is inactive', () => {
    expect(
      shouldReleaseIndependentConnection('disconnected', 'connected'),
    ).toBe(false);
  });
});

describe('getWalletConnectionModeAvailability', () => {
  it('allows every connection mode when all wallets are disconnected', () => {
    expect(
      getWalletConnectionModeAvailability({
        unified: 'disconnected',
        evm: 'disconnected',
        solana: 'disconnected',
      }),
    ).toEqual({
      unified: { disabled: false },
      evm: { disabled: false },
      solana: { disabled: false },
    });
  });

  it.each(['connecting', 'connected'] as const)(
    'blocks independent connections while Unified MetaMask is %s',
    (unified) => {
      const availability = getWalletConnectionModeAvailability({
        unified,
        evm: 'disconnected',
        solana: 'disconnected',
      });

      expect(availability.unified.disabled).toBe(false);
      expect(availability.evm).toEqual({
        disabled: true,
        reason:
          'Disconnect Unified MetaMask before choosing an independent EVM wallet.',
      });
      expect(availability.solana).toEqual({
        disabled: true,
        reason:
          'Disconnect Unified MetaMask before choosing an independent Solana wallet.',
      });
    },
  );

  it.each([
    ['evm', 'connected', 'disconnected'],
    ['solana', 'disconnected', 'connected'],
    ['evm connecting', 'connecting', 'disconnected'],
    ['solana connecting', 'disconnected', 'connecting'],
  ] as const)(
    'blocks Unified MetaMask while an independent %s connection is occupied',
    (_label, evm, solana) => {
      const availability = getWalletConnectionModeAvailability({
        unified: 'disconnected',
        evm,
        solana,
      });

      expect(availability.unified).toEqual({
        disabled: true,
        reason:
          'Disconnect your independent EVM and Solana wallets before connecting Unified MetaMask.',
      });
      expect(availability.evm.disabled).toBe(false);
      expect(availability.solana.disabled).toBe(false);
    },
  );

  it('does not let an error state keep another mode locked', () => {
    expect(
      getWalletConnectionModeAvailability({
        unified: 'error',
        evm: 'error',
        solana: 'error',
      }),
    ).toEqual({
      unified: { disabled: false },
      evm: { disabled: false },
      solana: { disabled: false },
    });
  });
});

describe('validateUnifiedConnection', () => {
  it('accepts and normalizes a complete EVM and Solana connection', () => {
    expect(
      validateUnifiedConnection({
        evmAddress: ' 0xabc ',
        solanaAddress: ' SolanaAddress ',
      }),
    ).toEqual({
      ok: true,
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
  });

  it('rejects an EVM-only result without exposing a partial connection', () => {
    expect(validateUnifiedConnection({ evmAddress: '0xabc' })).toMatchObject({
      ok: false,
      code: 'missing-solana-account',
      message:
        'MetaMask did not provide a Solana address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    });
  });

  it('rejects a Solana-only result without exposing a partial connection', () => {
    expect(
      validateUnifiedConnection({ solanaAddress: 'SolanaAddress' }),
    ).toMatchObject({
      ok: false,
      code: 'missing-evm-account',
      message:
        'MetaMask did not provide an EVM address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    });
  });

  it('rejects an empty result without exposing a connection', () => {
    expect(validateUnifiedConnection({})).toMatchObject({
      ok: false,
      code: 'missing-both-accounts',
      message:
        'MetaMask did not provide an EVM address or a Solana address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    });
  });
});

describe('getUnifiedAddressesFromSession', () => {
  it('extracts EVM and Solana addresses from all approved scopes', () => {
    expect(
      getUnifiedAddressesFromSession({
        sessionScopes: {
          'eip155:8453': {
            accounts: ['eip155:8453:0xabc'],
          },
          'solana:mainnet': {
            accounts: ['solana:mainnet:SolanaAddress'],
          },
        },
      }),
    ).toEqual({
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
  });

  it('ignores malformed and unrelated account identifiers', () => {
    expect(
      getUnifiedAddressesFromSession({
        sessionScopes: {
          'eip155:8453': {
            accounts: ['not-caip', 'cosmos:1:cosmos-address'],
          },
        },
      }),
    ).toEqual({
      evmAddress: undefined,
      solanaAddress: undefined,
    });
  });
});

function createCore(options?: {
  connectError?: Error;
  disconnectError?: Error;
  session?: Parameters<typeof getUnifiedAddressesFromSession>[0];
}) {
  const connect = vi.fn(async () => {
    if (options?.connectError) {
      throw options.connectError;
    }
  });
  const disconnect = vi.fn(async () => {
    if (options?.disconnectError) {
      throw options.disconnectError;
    }
  });
  const getSession = vi.fn(async () => options?.session);
  return {
    core: {
      connect,
      disconnect,
      provider: { getSession },
    } as MetaMaskUnifiedCore,
    connect,
    disconnect,
    getSession,
  };
}

describe('connectUnifiedMetaMask', () => {
  it('requests both scopes and returns only a complete shared session', async () => {
    const { core, connect, disconnect } = createCore({
      session: {
        sessionScopes: {
          'eip155:8453': { accounts: ['eip155:8453:0xabc'] },
          'solana:mainnet': {
            accounts: ['solana:mainnet:SolanaAddress'],
          },
        },
      },
    });

    await expect(connectUnifiedMetaMask(core)).resolves.toEqual({
      ok: true,
      evmAddress: '0xabc',
      solanaAddress: 'SolanaAddress',
    });
    expect(connect).toHaveBeenCalledWith([...METAMASK_UNIFIED_SCOPES], []);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('cleans up an incomplete approval without exposing the EVM account', async () => {
    const { core, disconnect } = createCore({
      session: {
        sessionScopes: {
          'eip155:8453': { accounts: ['eip155:8453:0xabc'] },
        },
      },
    });

    await expect(connectUnifiedMetaMask(core)).resolves.toMatchObject({
      ok: false,
      code: 'missing-solana-account',
    });
    expect(disconnect).toHaveBeenCalledWith([...METAMASK_UNIFIED_SCOPES]);
  });

  it('cleans up a rejected request and preserves the original error', async () => {
    const rejection = new Error('User rejected the request.');
    const { core, disconnect } = createCore({
      connectError: rejection,
      disconnectError: new Error('Cleanup failed.'),
    });

    await expect(connectUnifiedMetaMask(core)).rejects.toBe(rejection);
    expect(disconnect).toHaveBeenCalledWith([...METAMASK_UNIFIED_SCOPES]);
  });
});
