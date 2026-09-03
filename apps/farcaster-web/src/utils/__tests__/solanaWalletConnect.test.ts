import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockSession = {
  namespaces: { solana?: { accounts: readonly string[] } };
  topic: string;
};

const providerInstance: {
  session: MockSession | undefined;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  client: { request: ReturnType<typeof vi.fn> };
} = {
  session: undefined,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  client: { request: vi.fn() },
};

const initMock = vi.fn(async (..._args: unknown[]) => providerInstance);

vi.mock('@walletconnect/universal-provider', () => ({
  UniversalProvider: {
    init: (...args: unknown[]) => initMock(...args),
  },
}));

const modalInstance = {
  openModal: vi.fn(async () => undefined),
  closeModal: vi.fn(),
};
const modalConstructor = vi.fn((..._args: unknown[]) => modalInstance);

vi.mock('@walletconnect/modal', () => ({
  WalletConnectModal: vi.fn().mockImplementation((...args: unknown[]) => {
    modalConstructor(...args);
    return modalInstance;
  }),
}));

const { createSolanaWalletConnectWallet, WALLET_CONNECT_WALLET_NAME } =
  await import('~/utils/solanaWalletConnect');

const SESSION: MockSession = {
  namespaces: {
    solana: {
      accounts: [
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d:SolAddress1111111111111111111111111111111',
      ],
    },
  },
  topic: 'topic-1',
};

function feature<T>(
  wallet: ReturnType<typeof createSolanaWalletConnectWallet>,
  name: string,
): T {
  return wallet.features[name] as T;
}

describe('createSolanaWalletConnectWallet', () => {
  beforeEach(() => {
    providerInstance.session = undefined;
    providerInstance.connect.mockReset();
    providerInstance.disconnect.mockReset();
    providerInstance.on.mockReset();
    providerInstance.off.mockReset();
    providerInstance.client.request.mockReset();
    initMock.mockClear();
    modalConstructor.mockClear();
    modalInstance.openModal.mockClear();
    modalInstance.closeModal.mockClear();
  });

  it('describes itself with the shared WalletConnect name and icon', () => {
    const wallet = createSolanaWalletConnectWallet('project-id');
    expect(wallet.name).toBe(WALLET_CONNECT_WALLET_NAME);
    expect(wallet.icon.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(wallet.chains).toEqual(['solana:mainnet']);
    expect(Object.keys(wallet.features)).toEqual(
      expect.arrayContaining([
        'standard:connect',
        'standard:disconnect',
        'standard:events',
        'solana:signTransaction',
      ]),
    );
  });

  it('opens the WalletConnect modal with the pairing URI and returns the connected account', async () => {
    providerInstance.connect.mockImplementation(async () => {
      providerInstance.session = SESSION;
    });
    providerInstance.on.mockImplementation(
      (event: string, listener: (uri: string) => void) => {
        if (event === 'display_uri') {
          listener('wc:pairing-uri');
        }
      },
    );

    const wallet = createSolanaWalletConnectWallet('project-id');
    const { connect } = feature<{
      connect: () => Promise<{ accounts: readonly { address: string }[] }>;
    }>(wallet, 'standard:connect');

    const result = await connect();

    expect(modalInstance.openModal).toHaveBeenCalledWith({
      uri: 'wc:pairing-uri',
    });
    expect(modalInstance.closeModal).toHaveBeenCalledOnce();
    expect(result.accounts).toEqual([
      {
        address: 'SolAddress1111111111111111111111111111111',
        chains: ['solana:mainnet'],
      },
    ]);
  });

  it('returns the existing session immediately without reopening the modal', async () => {
    providerInstance.session = SESSION;
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { connect } = feature<{
      connect: () => Promise<{ accounts: readonly { address: string }[] }>;
    }>(wallet, 'standard:connect');

    const result = await connect();

    expect(providerInstance.connect).not.toHaveBeenCalled();
    expect(modalInstance.openModal).not.toHaveBeenCalled();
    expect(result.accounts).toHaveLength(1);
  });

  it('throws when the wallet never establishes a session', async () => {
    providerInstance.connect.mockResolvedValue(undefined);
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { connect } = feature<{ connect: () => Promise<unknown> }>(
      wallet,
      'standard:connect',
    );

    await expect(connect()).rejects.toThrow(
      'WalletConnect session was not established.',
    );
  });

  it('disconnects the underlying session when one exists', async () => {
    providerInstance.session = SESSION;
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { disconnect } = feature<{ disconnect: () => Promise<void> }>(
      wallet,
      'standard:disconnect',
    );

    await disconnect();

    expect(providerInstance.disconnect).toHaveBeenCalledOnce();
  });

  it('does not call the underlying disconnect when there is no session', async () => {
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { disconnect } = feature<{ disconnect: () => Promise<void> }>(
      wallet,
      'standard:disconnect',
    );

    await disconnect();

    expect(providerInstance.disconnect).not.toHaveBeenCalled();
  });

  it('signs a transaction by base64-encoding the request and decoding the response', async () => {
    providerInstance.session = SESSION;
    providerInstance.client.request.mockResolvedValue({
      transaction: btoa('signed-bytes'),
    });
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { signTransaction } = feature<{
      signTransaction: (
        ...inputs: readonly { transaction: Uint8Array }[]
      ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
    }>(wallet, 'solana:signTransaction');

    const input = new TextEncoder().encode('unsigned-bytes');
    const [result] = await signTransaction({ transaction: input });

    expect(providerInstance.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        request: expect.objectContaining({ method: 'solana_signTransaction' }),
        topic: 'topic-1',
      }),
    );
    expect(new TextDecoder().decode(result.signedTransaction)).toBe(
      'signed-bytes',
    );
  });

  it('rejects signing before a session exists', async () => {
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { signTransaction } = feature<{
      signTransaction: (
        ...inputs: readonly { transaction: Uint8Array }[]
      ) => Promise<unknown>;
    }>(wallet, 'solana:signTransaction');

    await expect(
      signTransaction({ transaction: new Uint8Array() }),
    ).rejects.toThrow('Connect a Solana wallet before signing.');
  });

  it('treats a signature-only response as unsupported rather than guessing', async () => {
    providerInstance.session = SESSION;
    providerInstance.client.request.mockResolvedValue({
      signature: 'not-enough-to-submit',
    });
    const wallet = createSolanaWalletConnectWallet('project-id');
    const { signTransaction } = feature<{
      signTransaction: (
        ...inputs: readonly { transaction: Uint8Array }[]
      ) => Promise<unknown>;
    }>(wallet, 'solana:signTransaction');

    await expect(
      signTransaction({ transaction: new Uint8Array() }),
    ).rejects.toThrow(
      'This wallet did not return a signed transaction in a supported format.',
    );
  });

  it('relays session updates and deletions through the change event', async () => {
    let sessionUpdateHandler: (() => void) | undefined;
    let sessionDeleteHandler: (() => void) | undefined;
    providerInstance.on.mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'session_update') {
          sessionUpdateHandler = handler;
        }
        if (event === 'session_delete') {
          sessionDeleteHandler = handler;
        }
      },
    );

    const wallet = createSolanaWalletConnectWallet('project-id');
    const { on } = feature<{
      on: (
        event: 'change',
        listener: (properties: {
          accounts?: readonly { address: string }[];
        }) => void,
      ) => () => void;
    }>(wallet, 'standard:events');

    const listener = vi.fn();
    const unsubscribe = on('change', listener);

    // The provider resolves asynchronously; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    providerInstance.session = SESSION;
    sessionUpdateHandler?.();
    expect(listener).toHaveBeenCalledWith({
      accounts: [
        {
          address: 'SolAddress1111111111111111111111111111111',
          chains: ['solana:mainnet'],
        },
      ],
    });

    sessionDeleteHandler?.();
    expect(listener).toHaveBeenLastCalledWith({ accounts: [] });

    unsubscribe();
    expect(providerInstance.off).toHaveBeenCalledWith(
      'session_update',
      expect.any(Function),
    );
    expect(providerInstance.off).toHaveBeenCalledWith(
      'session_delete',
      expect.any(Function),
    );
  });
});
