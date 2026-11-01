/**
 * The wallet channel an older mini app SDK asks through.
 *
 * Two wires reach a mini app from the wallet: the host's own provider channel
 * (`@farcaster/miniapp-host` builds `ethProviderRequestV2` out of the
 * `ethProvider` it is given) and the older `sdk.ethProviderRequest`. The older
 * one used to answer `Error('not implemented')` while this host declared
 * `wallet.getEvmProvider` and `wallet.getEthereumProvider` in
 * `getCapabilities` — a declared capability that threw is a wallet button dying
 * inside somebody's mini app with a message nothing could act on.
 *
 * These tests hold the two halves of the rule: the request reaches the wallet
 * that is connected, and with no wallet the refusal says so in words.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createLegacyWalletChannel,
  LegacyWalletProvider,
  NO_WALLET_SENTENCE,
} from '~/components/miniApp/legacyWalletChannel';

describe('the legacy mini app wallet channel', () => {
  it('forwards the request to the connected wallet and answers with its value', async () => {
    const request = vi.fn().mockResolvedValue(['0x1234']);
    const channel = createLegacyWalletChannel(() => ({ request }));

    await expect(
      channel({ method: 'eth_requestAccounts' } as never),
    ).resolves.toEqual(['0x1234']);
    expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
  });

  it('reads the wallet at call time, not at construction time', async () => {
    // The SDK object is built before the wallet is instrumented, so a captured
    // provider would be the empty one from that first render.
    const wallet: { provider: LegacyWalletProvider | undefined } = {
      provider: undefined,
    };
    const channel = createLegacyWalletChannel(() => wallet.provider);

    wallet.provider = { request: vi.fn().mockResolvedValue('0xabc') };

    await expect(channel({ method: 'eth_accounts' } as never)).resolves.toBe(
      '0xabc',
    );
  });

  it('refuses in words when no wallet is connected', async () => {
    const channel = createLegacyWalletChannel(() => undefined);

    await expect(channel({ method: 'eth_accounts' } as never)).rejects.toThrow(
      NO_WALLET_SENTENCE,
    );
    expect(NO_WALLET_SENTENCE).toBe('No wallet is connected in Fiddy');
  });

  it('does not swallow what the wallet itself refuses', async () => {
    const refusal = new Error('User rejected the request');
    const channel = createLegacyWalletChannel(() => ({
      request: vi.fn().mockRejectedValue(refusal),
    }));

    await expect(channel({ method: 'personal_sign' } as never)).rejects.toThrow(
      refusal,
    );
  });
});
