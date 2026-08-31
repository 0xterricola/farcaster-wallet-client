import { Provider } from 'ox';
import {
  decodeFunctionData,
  erc20Abi,
  parseEther,
  PublicClient,
  zeroAddress,
} from 'viem';
import { bsc } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import {
  BaseTransferInput,
  BaseTransferReader,
  createBaseTransferReader,
  createStandardEvmTransferReader,
  parseTransferAmount,
  prepareBaseTransfer,
  prepareEvmTransfer,
  submitBaseTransfer,
  submitEvmTransfer,
} from '~/utils/baseWalletTransfer';

const address = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const tokenAddress = '0x3333333333333333333333333333333333333333';
const hash = `0x${'a'.repeat(64)}`;
const input: BaseTransferInput = {
  address,
  recipient,
  amount: '1.25',
  tokenAddress,
};

function setup() {
  const reader = {
    nativeBalance: vi.fn().mockResolvedValue(parseEther('10')),
    tokenDetails: vi
      .fn()
      .mockResolvedValue({ symbol: 'TOKEN', decimals: 6, balance: 5_000_000n }),
    simulateToken: vi.fn().mockResolvedValue(undefined),
    estimateFee: vi.fn().mockResolvedValue(1_000_000_000_000n),
  } satisfies BaseTransferReader;
  let chain = '0x2105';
  let accounts: string[] = [address];
  const request = vi.fn(
    async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') {
        return chain;
      }
      if (method === 'eth_accounts') {
        return accounts;
      }
      if (method === 'wallet_switchEthereumChain') {
        chain = '0x2105';
        return null;
      }
      if (method === 'eth_sendTransaction') {
        return hash;
      }
      throw new Error(`Unexpected method ${method}: ${params}`);
    },
  );
  const provider = { request } as unknown as Pick<Provider.Provider, 'request'>;
  const sent = () =>
    request.mock.calls.filter(
      ([call]) => call.method === 'eth_sendTransaction',
    );
  return {
    reader,
    request,
    provider,
    sent,
    setChain: (next: string) => {
      chain = next;
    },
    setAccounts: (next: string[]) => {
      accounts = next;
    },
  };
}

describe('Base transfer amounts', () => {
  it('parses token amounts exactly without floats', () => {
    expect(parseTransferAmount('1.25', 6)).toBe(1_250_000n);
    expect(parseTransferAmount('9007199254740993', 0)).toBe(9007199254740993n);
  });
  it.each(['0', '-1', '1e3', 'NaN', '', '1,000', '.'])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => parseTransferAmount(amount, 6)).toThrow();
    },
  );
  it('rejects excess precision instead of rounding', () => {
    expect(() => parseTransferAmount('0.0000001', 6)).toThrow('decimal places');
  });
  it.each([-1, 256, 1.5])('rejects invalid decimals %s', (decimals) => {
    expect(() => parseTransferAmount('1', decimals)).toThrow('decimals');
  });
});

describe('prepareBaseTransfer', () => {
  it('encodes transfer with the recipient and exact amount; no approval', async () => {
    const { reader } = setup();
    const prepared = await prepareBaseTransfer(reader, input);
    expect(prepared.call.to).toBe(tokenAddress);
    expect(prepared.call.value).toBe(0n);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: prepared.call.data! }),
    ).toEqual({
      functionName: 'transfer',
      args: [recipient, 1_250_000n],
    });
    expect(reader.simulateToken).toHaveBeenCalledWith(prepared.call);
    expect(reader.estimateFee).toHaveBeenCalledWith(prepared.call);
  });
  it('prepares native ETH without a token contract call', async () => {
    const { reader } = setup();
    const prepared = await prepareBaseTransfer(reader, {
      ...input,
      tokenAddress: undefined,
      amount: '0.1',
    });
    expect(prepared.call).toEqual({
      account: address,
      to: recipient,
      value: parseEther('0.1'),
    });
    expect(reader.tokenDetails).not.toHaveBeenCalled();
    expect(reader.simulateToken).not.toHaveBeenCalled();
  });
  it.each(['invalid', zeroAddress])(
    'rejects recipient %s before RPC work',
    async (recipient) => {
      const { reader } = setup();
      await expect(
        prepareBaseTransfer(reader, { ...input, recipient }),
      ).rejects.toThrow('recipient');
      expect(reader.nativeBalance).not.toHaveBeenCalled();
    },
  );
  it('rejects insufficient live token balance', async () => {
    const { reader } = setup();
    reader.tokenDetails.mockResolvedValue({
      symbol: 'TOKEN',
      decimals: 6,
      balance: 1n,
    });
    await expect(prepareBaseTransfer(reader, input)).rejects.toThrow(
      'Insufficient TOKEN balance. Available: 0.000001 TOKEN on Base.',
    );
  });
  it('requires ETH for gas even when token balance is sufficient', async () => {
    const { reader } = setup();
    reader.nativeBalance.mockResolvedValue(1_000_000_000_000n);
    await expect(prepareBaseTransfer(reader, input)).rejects.toThrow(
      '20% fee buffer',
    );
  });
  it('reserves fees in addition to the native amount', async () => {
    const { reader } = setup();
    reader.nativeBalance.mockResolvedValue(parseEther('1.25'));
    await expect(
      prepareBaseTransfer(reader, { ...input, tokenAddress: undefined }),
    ).rejects.toThrow('estimated gas');
  });
  it('stops when token simulation fails', async () => {
    const { reader } = setup();
    reader.simulateToken.mockRejectedValue(new Error('Transfer restricted'));
    await expect(prepareBaseTransfer(reader, input)).rejects.toThrow(
      'Transfer restricted',
    );
    expect(reader.estimateFee).not.toHaveBeenCalled();
  });
});

describe('submitBaseTransfer', () => {
  it('switches to Base, checks fresh balances and submits one exact transfer', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.setChain('0x1');
    await expect(submitBaseTransfer({ ...fixture, prepared })).resolves.toBe(
      hash,
    );
    expect(fixture.reader.tokenDetails).toHaveBeenCalledTimes(2);
    expect(fixture.sent()).toHaveLength(1);
    expect(fixture.request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [
        {
          from: address,
          to: tokenAddress,
          value: '0x0',
          data: prepared.call.data,
          chainId: '0x2105',
        },
      ],
    });
  });
  it('blocks an expired review without opening the wallet', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    prepared.preparedAt -= 61_000;
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'expired',
    );
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it('blocks an account change', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.setAccounts([recipient]);
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'account changed',
    );
    expect(fixture.sent()).toHaveLength(0);
  });
  it('blocks changed token decimals', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.reader.tokenDetails.mockResolvedValue({
      symbol: 'TOKEN',
      decimals: 7,
      balance: 50_000_000n,
    });
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'Token details changed',
    );
    expect(fixture.sent()).toHaveLength(0);
  });
  it('blocks a balance that fell since review', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.reader.tokenDetails.mockResolvedValue({
      symbol: 'TOKEN',
      decimals: 6,
      balance: 0n,
    });
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'Insufficient',
    );
    expect(fixture.sent()).toHaveLength(0);
  });
  it('blocks a network change during the final RPC checks without switching again', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.reader.estimateFee.mockImplementation(async () => {
      fixture.setChain('0x1');
      return 100n;
    });
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'not on Base',
    );
    expect(fixture.sent()).toHaveLength(0);
  });
  it('blocks a stale view after asynchronous work', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    let current = true;
    fixture.reader.estimateFee.mockImplementation(async () => {
      current = false;
      return 100n;
    });
    await expect(
      submitBaseTransfer({ ...fixture, prepared, isCurrent: () => current }),
    ).rejects.toThrow('form changed');
    expect(fixture.sent()).toHaveLength(0);
  });
  it('propagates rejection without retrying the send', async () => {
    const fixture = setup();
    const prepared = await prepareBaseTransfer(fixture.reader, input);
    fixture.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') {
        return '0x2105';
      }
      if (method === 'eth_accounts') {
        return [address];
      }
      throw new Error('User rejected');
    });
    await expect(submitBaseTransfer({ ...fixture, prepared })).rejects.toThrow(
      'User rejected',
    );
    expect(fixture.sent()).toHaveLength(1);
  });
});

describe('chain-parameterized EVM transfers', () => {
  it('uses BNB metadata and submits with the BSC chain ID', async () => {
    const fixture = setup();
    fixture.setChain('0x38');
    const prepared = await prepareEvmTransfer(
      fixture.reader,
      { ...input, tokenAddress: undefined, amount: '0.1' },
      bsc,
    );
    expect(prepared).toMatchObject({
      symbol: 'BNB',
      chain: expect.objectContaining({ id: 56, name: 'BNB Smart Chain' }),
    });
    await expect(submitEvmTransfer({ ...fixture, prepared })).resolves.toBe(
      hash,
    );
    expect(fixture.request).toHaveBeenLastCalledWith({
      method: 'eth_sendTransaction',
      params: [
        expect.objectContaining({
          from: address,
          to: recipient,
          chainId: '0x38',
        }),
      ],
    });
  });

  it('uses the requested chain in balance and gas errors', async () => {
    const { reader } = setup();
    reader.tokenDetails.mockResolvedValue({
      symbol: 'TOKEN',
      decimals: 6,
      balance: 0n,
    });
    await expect(prepareEvmTransfer(reader, input, bsc)).rejects.toThrow(
      'TOKEN on BNB Smart Chain',
    );
    reader.tokenDetails.mockResolvedValue({
      symbol: 'TOKEN',
      decimals: 6,
      balance: 5_000_000n,
    });
    reader.nativeBalance.mockResolvedValue(0n);
    await expect(prepareEvmTransfer(reader, input, bsc)).rejects.toThrow(
      'Not enough BNB on BNB Smart Chain',
    );
  });
});

describe('live RPC simulation adapter', () => {
  it('rejects a client configured for another chain', () => {
    expect(() =>
      createBaseTransferReader({ chain: { id: 1 } } as PublicClient),
    ).toThrow('Base RPC');
  });
  it.each(['0x', `0x${'0'.repeat(63)}1`])(
    'accepts successful/no-return ERC-20 simulation %s',
    async (data) => {
      const call = vi.fn().mockResolvedValue({ data });
      const reader = createBaseTransferReader({
        chain: { id: 8453 },
        call,
      } as unknown as PublicClient);
      await expect(
        reader.simulateToken({ account: address, to: tokenAddress, value: 0n }),
      ).resolves.toBeUndefined();
    },
  );
  it('rejects an explicit false transfer result', async () => {
    const call = vi.fn().mockResolvedValue({ data: `0x${'0'.repeat(64)}` });
    const reader = createBaseTransferReader({
      chain: { id: 8453 },
      call,
    } as unknown as PublicClient);
    await expect(
      reader.simulateToken({ account: address, to: tokenAddress, value: 0n }),
    ).rejects.toThrow('returned false');
  });
});

describe('standard EVM fee adapter', () => {
  it('multiplies the exact gas estimate by the current gas price', async () => {
    const estimateGas = vi.fn().mockResolvedValue(21_000n);
    const getGasPrice = vi.fn().mockResolvedValue(3_000_000_000n);
    const reader = createStandardEvmTransferReader(
      {
        chain: bsc,
        estimateGas,
        getGasPrice,
      } as unknown as PublicClient,
      bsc,
    );
    const call = { account: address, to: recipient, value: 1n } as const;
    await expect(reader.estimateFee(call)).resolves.toBe(63_000_000_000_000n);
    expect(estimateGas).toHaveBeenCalledWith(call);
    expect(getGasPrice).toHaveBeenCalledOnce();
  });

  it('rejects an RPC client for a different chain', () => {
    expect(() =>
      createStandardEvmTransferReader(
        { chain: { id: 1 } } as PublicClient,
        bsc,
      ),
    ).toThrow('BNB Smart Chain RPC');
  });

  it('does not fabricate a fee when estimation fails', async () => {
    const reader = createStandardEvmTransferReader(
      {
        chain: bsc,
        estimateGas: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        getGasPrice: vi.fn().mockResolvedValue(1n),
      } as unknown as PublicClient,
      bsc,
    );
    await expect(
      reader.estimateFee({ account: address, to: recipient, value: 1n }),
    ).rejects.toThrow('RPC unavailable');
  });
});
