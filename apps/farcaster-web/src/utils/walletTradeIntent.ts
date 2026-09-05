import { PublicKey } from '@solana/web3.js';
import { ApiChain, apiChainToChainId } from 'farcaster-client-data';
import { Address, getAddress, isAddress } from 'viem';

import { LIFI_SOLANA_CHAIN_ID } from '~/utils/solanaWallet';
import {
  DASHBOARD_CHAINS,
  walletChainCapabilities,
} from '~/utils/walletNetwork';

type TokenTradeTarget = {
  address: string;
  chain: ApiChain;
  decimals?: number;
  name?: string;
  symbol?: string;
};

export type WalletTradeIntentInput =
  | {
      family: 'evm';
      chainId: number;
      tokenAddress: Address;
    }
  | {
      family: 'solana';
      chainId: typeof LIFI_SOLANA_CHAIN_ID;
      tokenAddress: string;
      tokenDecimals: number;
      tokenName: string;
      tokenSymbol: string;
    };

export type WalletTradeIntent = WalletTradeIntentInput & { id: number };

function validSolanaAddress(value: string) {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export function walletTradeIntentFromToken({
  address,
  chain,
  decimals,
  name,
  symbol,
}: TokenTradeTarget): WalletTradeIntentInput | undefined {
  if (chain === 'solana') {
    if (
      !validSolanaAddress(address) ||
      !Number.isInteger(decimals) ||
      decimals === undefined ||
      decimals < 0 ||
      decimals > 18 ||
      !name?.trim() ||
      !symbol?.trim()
    ) {
      return undefined;
    }
    return {
      family: 'solana',
      chainId: LIFI_SOLANA_CHAIN_ID,
      tokenAddress: address,
      tokenDecimals: decimals,
      tokenName: name.trim(),
      tokenSymbol: symbol.trim(),
    };
  }

  const rawChainId = apiChainToChainId(chain);
  const chainId = rawChainId ? Number(rawChainId) : undefined;
  if (
    !chainId ||
    !DASHBOARD_CHAINS.has(chainId) ||
    !walletChainCapabilities(chainId).swap ||
    !isAddress(address)
  ) {
    return undefined;
  }
  return {
    family: 'evm',
    chainId,
    tokenAddress: getAddress(address),
  };
}
