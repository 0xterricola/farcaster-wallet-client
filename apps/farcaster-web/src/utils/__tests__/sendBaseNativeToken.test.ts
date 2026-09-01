import { Provider } from 'ox';
import { bsc, celo } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import {
  ensureEvmWalletAccount,
  sendBaseNativeToken,
  sendEvmNativeToken,
} from '~/utils/sendBaseNativeToken';

const address = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`;

function setup({
  initialChain = '0x2105',
  switchedChain = '0x2105',
  accounts = [address],
  switchRejected = false,
  sendRejected = false,
} = {}) {
  let chain = initialChain;
  const request = vi.fn(async ({ method }: { method: string }) => {
    switch (method) {
      case 'eth_chainId':
        return chain;
      case 'eth_accounts':
        return accounts;
      case 'wallet_switchEthereumChain':
        if (switchRejected) {
          throw new Error('Switch rejected');
        }
        chain = switchedChain;
        return null;
      case 'eth_sendTransaction':
        if (sendRejected) {
          throw new Error('Send rejected');
        }
        return hash;
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const send = () =>
    sendBaseNativeToken({
      provider: { request } as unknown as Pick<Provider.Provider, 'request'>,
      address,
      recipient,
      value: 1n,
    });
  const methods = () => request.mock.calls.map(([call]) => call.method);
  return { request, send, methods };
}

describe('sendBaseNativeToken', () => {
  it('sends on Base without prompting to switch', async () => {
    const { request, send, methods } = setup();
    await expect(send()).resolves.toBe(hash);
    expect(methods()).toEqual([
      'eth_chainId',
      'eth_accounts',
      'eth_chainId',
      'eth_sendTransaction',
    ]);
    expect(request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [
        { from: address, to: recipient, value: '0x1', chainId: '0x2105' },
      ],
    });
  });

  it('switches from another network and verifies before sending', async () => {
    const { request, send, methods } = setup({ initialChain: '0x1' });
    await expect(send()).resolves.toBe(hash);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }],
    });
    expect(methods()).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_accounts',
      'eth_chainId',
      'eth_sendTransaction',
    ]);
  });

  it('does not send when switching is rejected', async () => {
    const { send, methods } = setup({
      initialChain: '0x1',
      switchRejected: true,
    });
    await expect(send()).rejects.toThrow('Switch rejected');
    expect(methods()).not.toContain('eth_sendTransaction');
  });

  it('does not send if the wallet remains on another network', async () => {
    const { send, methods } = setup({
      initialChain: '0x1',
      switchedChain: '0x1',
    });
    await expect(send()).rejects.toThrow('Wallet is not on Base');
    expect(methods()).not.toContain('eth_sendTransaction');
  });

  it.each([{ accounts: [recipient] }, { accounts: [] }])(
    'does not send with changed or missing accounts: $accounts',
    async ({ accounts }) => {
      const { send, methods } = setup({ accounts });
      await expect(send()).rejects.toThrow('Wallet account changed');
      expect(methods()).not.toContain('eth_sendTransaction');
    },
  );

  it('propagates transaction rejection without retrying', async () => {
    const { send, methods } = setup({ sendRejected: true });
    await expect(send()).rejects.toThrow('Send rejected');
    expect(
      methods().filter((method) => method === 'eth_sendTransaction'),
    ).toHaveLength(1);
  });
});

describe('generic EVM wallet guards', () => {
  it('verifies and sends with the requested BSC chain ID', async () => {
    let chain = '0x1';
    const request = vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') {
        return chain;
      }
      if (method === 'wallet_switchEthereumChain') {
        chain = '0x38';
        return null;
      }
      if (method === 'eth_accounts') {
        return [address];
      }
      if (method === 'eth_sendTransaction') {
        return hash;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await expect(
      sendEvmNativeToken({
        provider: { request } as never,
        address,
        recipient,
        value: 1n,
        chain: bsc,
      }),
    ).resolves.toBe(hash);
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x38' }],
    });
    expect(request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [{ from: address, to: recipient, value: '0x1', chainId: '0x38' }],
    });
  });

  it('verifies and sends with the requested Celo chain ID', async () => {
    let chain = '0x1';
    const request = vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') {
        return chain;
      }
      if (method === 'wallet_switchEthereumChain') {
        chain = '0xa4ec';
        return null;
      }
      if (method === 'eth_accounts') {
        return [address];
      }
      if (method === 'eth_sendTransaction') {
        return hash;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await expect(
      sendEvmNativeToken({
        provider: { request } as never,
        address,
        recipient,
        value: 1n,
        chain: celo,
      }),
    ).resolves.toBe(hash);
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xa4ec' }],
    });
    expect(request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [
        { from: address, to: recipient, value: '0x1', chainId: '0xa4ec' },
      ],
    });
  });

  it('names the requested chain when final verification fails', async () => {
    const request = vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') {
        return '0x1';
      }
      if (method === 'eth_accounts') {
        return [address];
      }
      return null;
    });
    await expect(
      ensureEvmWalletAccount({ request } as never, address, bsc, false),
    ).rejects.toThrow('not on BNB Smart Chain');
  });
});
