export const WALLET_FAMILIES = ['evm', 'solana'] as const;

export type WalletFamily = (typeof WALLET_FAMILIES)[number];

export type WalletFamilyConnection = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  address?: string;
  walletName?: string;
};

export type WalletConnections = Readonly<
  Record<WalletFamily, WalletFamilyConnection>
>;

export const EMPTY_WALLET_CONNECTIONS: WalletConnections = {
  evm: { status: 'disconnected' },
  solana: { status: 'disconnected' },
};

export const WALLET_FAMILY_DETAILS: Readonly<
  Record<WalletFamily, { label: string; description: string }>
> = {
  evm: {
    label: 'EVM',
    description: 'Base, Ethereum, and other EVM networks',
  },
  solana: {
    label: 'Solana',
    description: 'Solana Mainnet',
  },
};

export function isWalletFamily(value: unknown): value is WalletFamily {
  return WALLET_FAMILIES.some((family) => family === value);
}

export function updateWalletFamilyConnection(
  connections: WalletConnections,
  family: WalletFamily,
  connection: WalletFamilyConnection,
): WalletConnections {
  return { ...connections, [family]: connection };
}
