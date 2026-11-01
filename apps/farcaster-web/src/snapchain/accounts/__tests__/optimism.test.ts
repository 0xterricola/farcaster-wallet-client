/**
 * Registering an account: the reads, the guards and the bytes that get signed.
 *
 * The point of these tests is that nothing here is assumed about the chain. The
 * price is read (and refused when it is absurd), the calldata is built from the
 * contract's own ABI rather than from a hand-written hex string, and the fees are
 * read from the endpoint and capped. A test that only checked "a request was
 * made" would pass for a client that signs whatever it is told.
 *
 * The numbers used as fixtures are shaped like the real ones: MEASURED on
 * 2026-10-21, `price()` on the live IdGateway answered 0x4a0910b5d25a
 * (81_402_795_512_410 wei ≈ $0.20), and the gas price was 0xf5201 (0.001 gwei).
 */

import { encodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  buildRegistrationRequest,
  ID_GATEWAY_ADDRESS,
  MAX_REGISTRATION_PRICE_WEI,
  readChainId,
  readFidOf,
  readOptimismBalance,
  readRegistrationPrice,
  registerFid,
  type RegistrationSigner,
  sendRawTransaction,
  signRegistrationTransaction,
} from '~/snapchain/accounts/optimism';

/** The live price, as the contract answered it. */
const LIVE_PRICE_HEX =
  '0x00000000000000000000000000000000000000000000000000004a0910b5d25a';
const LIVE_PRICE_WEI = 81_402_795_512_410n;

const RAW_TX = `0x${'ab'.repeat(100)}` as `0x${string}`;
const TX_HASH = `0x${'cd'.repeat(32)}` as `0x${string}`;

const CUSTODY_ADDRESS =
  '0x1111111111111111111111111111111111111111' as `0x${string}`;

const signer = (): RegistrationSigner => ({
  address: CUSTODY_ADDRESS,
  signTransaction: vi.fn(async () => RAW_TX),
});

type Handler = (params: unknown[]) => string;

const rpcFetch = (handlers: Record<string, Handler>) => {
  const requests: { method: string; params: unknown[] }[] = [];

  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    requests.push(body);
    const handler = handlers[body.method];

    if (!handler) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'no handler' },
        }),
        { status: 200 },
      );
    }

    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: handler(body.params) }),
      { status: 200 },
    );
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
};

describe('reading the chain', () => {
  it('reads the registration fee the contract quotes', async () => {
    const { fetchImpl } = rpcFetch({ eth_call: () => LIVE_PRICE_HEX });

    await expect(
      readRegistrationPrice({ rpcUrl: 'http://rpc.test', fetchImpl }),
    ).resolves.toBe(LIVE_PRICE_WEI);
  });

  it('refuses a fee of zero instead of believing it', async () => {
    const { fetchImpl } = rpcFetch({ eth_call: () => '0x0' });

    await expect(
      readRegistrationPrice({ rpcUrl: 'http://rpc.test', fetchImpl }),
    ).rejects.toThrow(/fee of zero/);
  });

  it('refuses a fee far above the cap', async () => {
    const absurd = `0x${(MAX_REGISTRATION_PRICE_WEI * 2n).toString(16)}`;
    const { fetchImpl } = rpcFetch({ eth_call: () => absurd });

    await expect(
      readRegistrationPrice({ rpcUrl: 'http://rpc.test', fetchImpl }),
    ).rejects.toThrow(/far higher than it should be/);
  });

  it('reads the chain id, the balance and the FID that owns an address', async () => {
    const { fetchImpl } = rpcFetch({
      eth_chainId: () => '0xa',
      eth_getBalance: () => '0xde0b6b3a7640000',
      eth_call: (_params) => `0x${'0'.repeat(63)}7`,
    });

    await expect(
      readChainId({ rpcUrl: 'http://rpc.test', fetchImpl }),
    ).resolves.toBe(10);

    await expect(
      readOptimismBalance({
        rpcUrl: 'http://rpc.test',
        address: CUSTODY_ADDRESS,
        fetchImpl,
      }),
    ).resolves.toBe(1_000_000_000_000_000_000n);

    await expect(
      readFidOf({
        rpcUrl: 'http://rpc.test',
        address: CUSTODY_ADDRESS,
        fetchImpl,
      }),
    ).resolves.toBe(7);
  });

  it('answers with a sentence, not a stack, when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      readRegistrationPrice({
        rpcUrl: 'http://rpc.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/couldn't reach the Optimism endpoint/);
  });
});

describe('the transaction that gets signed', () => {
  it('is a registration to the IdGateway, for the price, naming the account itself', () => {
    const request = buildRegistrationRequest({
      recovery: CUSTODY_ADDRESS,
      value: LIVE_PRICE_WEI,
    });

    expect(request.to).toBe(ID_GATEWAY_ADDRESS);
    expect(request.chainId).toBe(10);
    expect(request.value).toBe(LIVE_PRICE_WEI);
    expect(request.recovery).toBe(CUSTODY_ADDRESS);
    // Calldata built from the ABI, not hand-copied. The deployed IdGateway
    // answers both `register(address)` (0x4420e486) and
    // `register(address,uint256)` (0x6d705ebb) — MEASURED on 2026-10-21 by
    // reading the contract's own bytecode, which carries both selectors — and
    // this client signs the two-argument form, the one our registration design
    // document pins and the one that can carry extra storage later.
    expect(request.data).toBe(
      encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'register',
            stateMutability: 'payable',
            inputs: [
              { name: 'recovery', type: 'address' },
              { name: 'extraStorage', type: 'uint256' },
            ],
            outputs: [
              { name: 'fid', type: 'uint256' },
              { name: 'overpayment', type: 'uint256' },
            ],
          },
        ] as const,
        functionName: 'register',
        args: [CUSTODY_ADDRESS, 0n],
      }),
    );
    expect(request.data.startsWith('0x6d705ebb')).toBe(true);
  });

  it('signs an EIP-1559 transaction with the fee and gas it read, with headroom', async () => {
    const fakeSigner = signer();
    const { fetchImpl } = rpcFetch({
      eth_getTransactionCount: () => '0x5',
      eth_estimateGas: () => '0x30d40', // 200,000
      eth_gasPrice: () => '0xf5201', // 0.001 gwei
      eth_maxPriorityFeePerGas: () => '0x0',
    });

    const request = buildRegistrationRequest({
      recovery: CUSTODY_ADDRESS,
      value: LIVE_PRICE_WEI,
    });

    const raw = await signRegistrationTransaction({
      request,
      signer: fakeSigner,
      rpcUrl: 'http://rpc.test',
      fetchImpl,
    });

    expect(raw).toBe(RAW_TX);

    const signed = (fakeSigner.signTransaction as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;

    expect(signed.chainId).toBe(10);
    expect(signed.type).toBe('eip1559');
    expect(signed.to).toBe(ID_GATEWAY_ADDRESS);
    expect(signed.value).toBe(LIVE_PRICE_WEI);
    expect(signed.data).toBe(request.data);
    expect(signed.nonce).toBe(5);
    // 200,000 × 1.3
    expect(signed.gas).toBe(260_000n);
    // 0xf5201 (0.001004033 gwei) × 2 + 0 tip
    expect(signed.maxFeePerGas).toBe(2_008_066n);
  });

  it('refuses to sign fees an endpoint made up', async () => {
    const fakeSigner = signer();
    const { fetchImpl } = rpcFetch({
      eth_getTransactionCount: () => '0x1',
      eth_estimateGas: () => '0x30d40',
      // 6 gwei: doubled + tip is well past the 10 gwei ceiling
      eth_gasPrice: () => '0x165a0bc00',
      eth_maxPriorityFeePerGas: () => '0x0',
    });

    await expect(
      signRegistrationTransaction({
        request: buildRegistrationRequest({
          recovery: CUSTODY_ADDRESS,
          value: LIVE_PRICE_WEI,
        }),
        signer: fakeSigner,
        rpcUrl: 'http://rpc.test',
        fetchImpl,
      }),
    ).rejects.toThrow(/will not sign/);

    expect(fakeSigner.signTransaction).not.toHaveBeenCalled();
  });

  it('sends the signed bytes and accepts only a transaction id back', async () => {
    const { fetchImpl, requests } = rpcFetch({
      eth_sendRawTransaction: () => TX_HASH,
    });

    await expect(
      sendRawTransaction({ rpcUrl: 'http://rpc.test', raw: RAW_TX, fetchImpl }),
    ).resolves.toBe(TX_HASH);

    expect(requests[0]?.params).toEqual([RAW_TX]);
  });

  it('reports a sentence when the endpoint answers with something that is not a hash', async () => {
    const { fetchImpl } = rpcFetch({
      eth_sendRawTransaction: () => '0xdeadbeef',
    });

    await expect(
      sendRawTransaction({ rpcUrl: 'http://rpc.test', raw: RAW_TX, fetchImpl }),
    ).rejects.toThrow(/didn't send back a transaction id/);
  });
});

describe('the whole registration', () => {
  it('reads the price, signs, sends, and reports what was sent', async () => {
    const fakeSigner = signer();
    const { fetchImpl, requests } = rpcFetch({
      eth_call: () => LIVE_PRICE_HEX,
      eth_getTransactionCount: () => '0x0',
      eth_estimateGas: () => '0x30d40',
      eth_gasPrice: () => '0xf5201',
      eth_maxPriorityFeePerGas: () => '0x0',
      eth_sendRawTransaction: () => TX_HASH,
    });

    const result = await registerFid({
      rpcUrl: 'http://rpc.test',
      signer: fakeSigner,
      fetchImpl,
    });

    expect(result.txHash).toBe(TX_HASH);
    expect(result.price).toBe(LIVE_PRICE_WEI);
    expect(fakeSigner.signTransaction).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.method)).toEqual([
      'eth_call',
      'eth_getTransactionCount',
      'eth_estimateGas',
      'eth_gasPrice',
      'eth_maxPriorityFeePerGas',
      'eth_sendRawTransaction',
    ]);
  });
});
