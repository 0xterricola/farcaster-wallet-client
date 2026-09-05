import { getWallets } from '@wallet-standard/app';
import { useEffect, useState } from 'react';

export const SOLANA_MAINNET_CHAIN = 'solana:mainnet';
export const SOLANA_CONNECT_FEATURE = 'standard:connect';
export const SOLANA_DISCONNECT_FEATURE = 'standard:disconnect';
export const SOLANA_EVENTS_FEATURE = 'standard:events';
export const SOLANA_SIGN_MESSAGE_FEATURE = 'solana:signMessage';
export const SOLANA_SIGN_TRANSACTION_FEATURE = 'solana:signTransaction';

export type DetectedSolanaAccount = {
  readonly address: string;
  readonly chains: readonly string[];
};

export type DetectedSolanaWallet = {
  readonly accounts: readonly DetectedSolanaAccount[];
  readonly chains: readonly string[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly icon: string;
  readonly name: string;
  readonly version: string;
};

export function supportsSolanaMainnet(wallet: DetectedSolanaWallet): boolean {
  return (
    wallet.chains.includes(SOLANA_MAINNET_CHAIN) &&
    SOLANA_CONNECT_FEATURE in wallet.features &&
    SOLANA_SIGN_TRANSACTION_FEATURE in wallet.features
  );
}

export function filterSolanaWallets(
  wallets: readonly DetectedSolanaWallet[],
): readonly DetectedSolanaWallet[] {
  return wallets.filter(supportsSolanaMainnet);
}

export function useDetectedSolanaWallets(): readonly DetectedSolanaWallet[] {
  const [wallets, setWallets] = useState<readonly DetectedSolanaWallet[]>([]);

  useEffect(() => {
    const registry = getWallets();
    const sync = () => setWallets(filterSolanaWallets(registry.get()));
    const removeRegisterListener = registry.on('register', sync);
    const removeUnregisterListener = registry.on('unregister', sync);
    sync();
    return () => {
      removeRegisterListener();
      removeUnregisterListener();
    };
  }, []);

  return wallets;
}
