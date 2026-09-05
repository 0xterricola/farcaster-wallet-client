import { describe, expect, it } from 'vitest';

import { LIFI_SOLANA_CHAIN_ID } from '~/utils/solanaWallet';
import { walletTradeIntentFromToken } from '~/utils/walletTradeIntent';

describe('wallet trade intents', () => {
  it('accepts a checksummed token on a supported EVM dashboard chain', () => {
    expect(
      walletTradeIntentFromToken({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chain: 'base',
      }),
    ).toEqual({
      family: 'evm',
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
  });

  it('rejects an ambiguous address without a supported chain', () => {
    expect(
      walletTradeIntentFromToken({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chain: 'optimism',
      }),
    ).toBeUndefined();
  });

  it('rejects malformed EVM token contracts', () => {
    expect(
      walletTradeIntentFromToken({ address: '0x1234', chain: 'base' }),
    ).toBeUndefined();
  });

  it('accepts Solana embeds only with complete token metadata', () => {
    expect(
      walletTradeIntentFromToken({
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        chain: 'solana',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
      }),
    ).toEqual({
      family: 'solana',
      chainId: LIFI_SOLANA_CHAIN_ID,
      tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenDecimals: 6,
      tokenName: 'USD Coin',
      tokenSymbol: 'USDC',
    });
    expect(
      walletTradeIntentFromToken({
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        chain: 'solana',
      }),
    ).toBeUndefined();
  });
});
