import { describe, expect, it } from 'vitest';

import {
  filterSolanaWallets,
  SOLANA_CONNECT_FEATURE,
  SOLANA_MAINNET_CHAIN,
  SOLANA_SIGN_TRANSACTION_FEATURE,
} from '~/hooks/useDetectedSolanaWallets';

function wallet({
  name,
  chains = [SOLANA_MAINNET_CHAIN],
  connect = true,
  sign = true,
}: {
  name: string;
  chains?: string[];
  connect?: boolean;
  sign?: boolean;
}) {
  return {
    version: '1.0.0' as const,
    name,
    icon: 'data:image/svg+xml;base64,AA==' as const,
    chains,
    accounts: [],
    features: {
      ...(connect ? { [SOLANA_CONNECT_FEATURE]: {} } : {}),
      ...(sign ? { [SOLANA_SIGN_TRANSACTION_FEATURE]: {} } : {}),
    },
  };
}

describe('Solana wallet discovery', () => {
  it('keeps mainnet wallets that can connect and sign transactions', () => {
    const phantom = wallet({ name: 'Phantom' });
    expect(
      filterSolanaWallets([
        phantom,
        wallet({ name: 'Testnet only', chains: ['solana:devnet'] }),
        wallet({ name: 'Read only', sign: false }),
        wallet({ name: 'Cannot connect', connect: false }),
      ] as never),
    ).toEqual([phantom]);
  });
});
