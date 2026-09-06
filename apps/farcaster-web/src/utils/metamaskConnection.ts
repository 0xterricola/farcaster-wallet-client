import type { Scope } from '@metamask/connect-multichain';

export type WalletConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type WalletConnectionMode = 'unified' | 'evm' | 'solana';

export type WalletConnectionModeState = Readonly<{
  unified: WalletConnectionStatus;
  evm: WalletConnectionStatus;
  solana: WalletConnectionStatus;
}>;

export type WalletConnectionModeAvailability = Readonly<
  Record<
    WalletConnectionMode,
    Readonly<{
      disabled: boolean;
      reason?: string;
    }>
  >
>;

export type UnifiedConnectionFailureCode =
  | 'missing-both-accounts'
  | 'missing-evm-account'
  | 'missing-solana-account';

export type UnifiedConnectionResult =
  | Readonly<{
      ok: true;
      evmAddress: string;
      solanaAddress: string;
    }>
  | Readonly<{
      ok: false;
      code: UnifiedConnectionFailureCode;
      message: string;
    }>;

// Keep Base first so a new Unified session opens on the dashboard default.
// Every dashboard-supported EVM network is requested atomically so the shared
// provider can follow the existing network selector without reconnecting.
export const METAMASK_EVM_SCOPES = [
  'eip155:8453',
  'eip155:1',
  'eip155:42161',
  'eip155:56',
  'eip155:42220',
  'eip155:143',
  'eip155:999',
  'eip155:4663',
] as const;
export const METAMASK_SOLANA_SCOPE = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export const METAMASK_UNIFIED_SCOPES = [
  ...METAMASK_EVM_SCOPES,
  METAMASK_SOLANA_SCOPE,
] as const;

export type MetaMaskSessionData = Readonly<{
  sessionScopes?: Readonly<
    Record<
      string,
      Readonly<{
        accounts?: readonly string[];
      }>
    >
  >;
}>;

export type MetaMaskUnifiedCore = Readonly<{
  connect: (
    scopes: Scope[],
    caipAccountIds: `${string}:${string}:${string}`[],
  ) => Promise<void>;
  disconnect: (scopes?: Scope[]) => Promise<void>;
  provider: Readonly<{
    getSession: () =>
      | Promise<MetaMaskSessionData | undefined>
      | MetaMaskSessionData
      | undefined;
  }>;
}>;

function occupiesConnectionMode(status: WalletConnectionStatus): boolean {
  return status === 'connecting' || status === 'connected';
}

export function shouldReleaseIndependentConnection(
  unifiedStatus: WalletConnectionStatus,
  independentStatus: WalletConnectionStatus,
): boolean {
  return (
    occupiesConnectionMode(unifiedStatus) &&
    occupiesConnectionMode(independentStatus)
  );
}

/**
 * Unified MetaMask and independent wallet connections are mutually exclusive.
 * EVM and Solana independent connections may still coexist with each other.
 */
export function getWalletConnectionModeAvailability(
  state: WalletConnectionModeState,
): WalletConnectionModeAvailability {
  const unifiedOccupied = occupiesConnectionMode(state.unified);
  const independentOccupied =
    occupiesConnectionMode(state.evm) || occupiesConnectionMode(state.solana);

  return {
    unified: {
      disabled: independentOccupied,
      ...(independentOccupied
        ? {
            reason:
              'Disconnect your independent EVM and Solana wallets before connecting Unified MetaMask.',
          }
        : {}),
    },
    evm: {
      disabled: unifiedOccupied,
      ...(unifiedOccupied
        ? {
            reason:
              'Disconnect Unified MetaMask before choosing an independent EVM wallet.',
          }
        : {}),
    },
    solana: {
      disabled: unifiedOccupied,
      ...(unifiedOccupied
        ? {
            reason:
              'Disconnect Unified MetaMask before choosing an independent Solana wallet.',
          }
        : {}),
    },
  };
}

function usableAddress(address: string | undefined): string | undefined {
  const trimmed = address?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A Unified connection is atomic: both account families must be present before
 * either address is committed to application state.
 */
export function validateUnifiedConnection(input: {
  evmAddress?: string;
  solanaAddress?: string;
}): UnifiedConnectionResult {
  const evmAddress = usableAddress(input.evmAddress);
  const solanaAddress = usableAddress(input.solanaAddress);

  if (!evmAddress && !solanaAddress) {
    return {
      ok: false,
      code: 'missing-both-accounts',
      message:
        'MetaMask did not provide an EVM address or a Solana address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    };
  }
  if (!evmAddress) {
    return {
      ok: false,
      code: 'missing-evm-account',
      message:
        'MetaMask did not provide an EVM address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    };
  }
  if (!solanaAddress) {
    return {
      ok: false,
      code: 'missing-solana-account',
      message:
        'MetaMask did not provide a Solana address. Select or create a MetaMask Multichain Account with both addresses, then try again. Nothing was connected.',
    };
  }

  return {
    ok: true,
    evmAddress,
    solanaAddress,
  };
}

function addressFromCaipAccount(
  account: string,
  namespace: 'eip155' | 'solana',
): string | undefined {
  const [accountNamespace, reference, ...addressParts] = account.split(':');
  const address = addressParts.join(':').trim();
  if (accountNamespace !== namespace || !reference || !address) {
    return undefined;
  }
  return address;
}

export function getUnifiedAddressesFromSession(
  session: MetaMaskSessionData | undefined,
): Readonly<{ evmAddress?: string; solanaAddress?: string }> {
  const accounts = Object.values(session?.sessionScopes ?? {}).flatMap(
    (scope) => scope.accounts ?? [],
  );

  return {
    evmAddress: accounts
      .map((account) => addressFromCaipAccount(account, 'eip155'))
      .find(Boolean),
    solanaAddress: accounts
      .map((account) => addressFromCaipAccount(account, 'solana'))
      .find(Boolean),
  };
}

async function clearIncompleteUnifiedSession(
  core: MetaMaskUnifiedCore,
): Promise<void> {
  try {
    await core.disconnect([...METAMASK_UNIFIED_SCOPES]);
  } catch {
    // Preserve the useful connection failure. A later retry initializes the
    // SDK from persisted truth and can attempt cleanup again.
  }
}

/**
 * Requests EVM and Solana in one MetaMask session. No partial address is
 * returned: an incomplete approval is cleaned up and reported to the UI.
 */
export async function connectUnifiedMetaMask(
  core: MetaMaskUnifiedCore,
): Promise<UnifiedConnectionResult> {
  try {
    await core.connect([...METAMASK_UNIFIED_SCOPES], []);
    const result = validateUnifiedConnection(
      getUnifiedAddressesFromSession(await core.provider.getSession()),
    );
    if (!result.ok) {
      await clearIncompleteUnifiedSession(core);
    }
    return result;
  } catch (error) {
    await clearIncompleteUnifiedSession(core);
    throw error;
  }
}
