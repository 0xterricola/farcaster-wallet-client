import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSolanaAmount,
  prepareSolanaTransfer,
  solanaTransactionUrl,
  submitSignedSolanaTransaction,
  waitForSolanaConfirmation,
} from '~/utils/solanaTransfer';
import { SOLANA_TOKEN_PROGRAM_ID } from '~/utils/solanaWallet';

const sender = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();

function rpcMock(overrides: Record<string, unknown> = {}) {
  return vi.fn((_input: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    const defaults: Record<string, unknown> = {
      getAccountInfo: { value: {} },
      getFeeForMessage: { value: 5_000 },
      getLatestBlockhash: {
        value: { blockhash, lastValidBlockHeight: 123 },
      },
      getMinimumBalanceForRentExemption: 2_039_280,
      getSignatureStatuses: {
        value: [{ confirmationStatus: 'confirmed', err: null }],
      },
      sendTransaction: Keypair.generate().publicKey.toBase58().repeat(2),
    };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          result: overrides[body.method] ?? defaults[body.method],
        }),
        { status: 200 },
      ),
    );
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Solana transfers', () => {
  it('converts decimal amounts to exact base units', () => {
    expect(parseSolanaAmount('1.234567', 6)).toBe(1_234_567n);
    expect(() => parseSolanaAmount('1.0000001', 6)).toThrow(
      'at most 6 decimal places',
    );
    expect(() => parseSolanaAmount('0', 9)).toThrow('greater than zero');
  });

  it('prepares a native SOL transfer and includes the RPC fee', async () => {
    const fetch = rpcMock();
    vi.stubGlobal('fetch', fetch);
    const prepared = await prepareSolanaTransfer({
      amount: '0.25',
      recipient,
      sender,
      solBalanceLamports: 1_000_000_000,
    });

    expect(prepared.amountBaseUnits).toBe(250_000_000n);
    expect(prepared.feeLamports).toBe(5_000);
    const transaction = Transaction.from(prepared.transaction);
    expect(transaction.instructions).toHaveLength(1);
    expect(
      transaction.instructions[0].programId.equals(SystemProgram.programId),
    ).toBe(true);
    expect(
      fetch.mock.calls.map(
        ([, init]) => JSON.parse(init?.body as string).method,
      ),
    ).toEqual(['getLatestBlockhash', 'getAccountInfo', 'getFeeForMessage']);
  });

  it('blocks an undersized native transfer to an address without a SOL account', async () => {
    const fetch = rpcMock({
      getAccountInfo: { value: null },
      getMinimumBalanceForRentExemption: 890_880,
    });
    vi.stubGlobal('fetch', fetch);

    await expect(
      prepareSolanaTransfer({
        amount: '0.0001',
        recipient,
        sender,
        solBalanceLamports: 25_830_444,
      }),
    ).rejects.toThrow(
      'This address has no Solana account yet. Send at least 0.00089088 SOL to create it.',
    );
    expect(
      fetch.mock.calls.map(
        ([, init]) => JSON.parse(init?.body as string).method,
      ),
    ).toEqual([
      'getLatestBlockhash',
      'getAccountInfo',
      'getMinimumBalanceForRentExemption',
    ]);
  });

  it('allows enough native SOL to initialize a recipient account', async () => {
    vi.stubGlobal(
      'fetch',
      rpcMock({
        getAccountInfo: { value: null },
        getMinimumBalanceForRentExemption: 890_880,
      }),
    );

    const prepared = await prepareSolanaTransfer({
      amount: '0.001',
      recipient,
      sender,
      solBalanceLamports: 25_830_444,
    });

    expect(prepared.recipientMinimumLamports).toBe(890_880);
  });

  it('rejects native sends that cannot cover amount and fee', async () => {
    vi.stubGlobal('fetch', rpcMock());
    await expect(
      prepareSolanaTransfer({
        amount: '1',
        recipient,
        sender,
        solBalanceLamports: 1_000_000_000,
      }),
    ).rejects.toThrow('amount and network costs');
  });

  it('prepares a checked SPL transfer from the actual token account', async () => {
    const fetch = rpcMock();
    vi.stubGlobal('fetch', fetch);
    const mint = Keypair.generate().publicKey.toBase58();
    const source = Keypair.generate().publicKey.toBase58();
    const prepared = await prepareSolanaTransfer({
      amount: '1.5',
      asset: {
        amount: '2000000',
        decimals: 6,
        mint,
        name: 'USD Coin',
        programId: SOLANA_TOKEN_PROGRAM_ID,
        recognized: true,
        symbol: 'USDC',
        tokenAccounts: [{ address: source, amount: '2000000' }],
      },
      recipient,
      sender,
      solBalanceLamports: 10_000_000,
    });

    expect(prepared.amountBaseUnits).toBe(1_500_000n);
    expect(Transaction.from(prepared.transaction).instructions).toHaveLength(1);
    expect(
      fetch.mock.calls.map(
        ([, init]) => JSON.parse(init?.body as string).method,
      ),
    ).toEqual(['getLatestBlockhash', 'getAccountInfo', 'getFeeForMessage']);
  });

  it('shows recipient account rent and checks SOL when an ATA must be created', async () => {
    vi.stubGlobal('fetch', rpcMock({ getAccountInfo: { value: null } }));
    await expect(
      prepareSolanaTransfer({
        amount: '1',
        asset: {
          amount: '1000000',
          decimals: 6,
          mint: Keypair.generate().publicKey.toBase58(),
          name: 'USD Coin',
          programId: SOLANA_TOKEN_PROGRAM_ID,
          recognized: true,
          symbol: 'USDC',
          tokenAccounts: [
            {
              address: Keypair.generate().publicKey.toBase58(),
              amount: '1000000',
            },
          ],
        },
        recipient,
        sender,
        solBalanceLamports: 1_000_000,
      }),
    ).rejects.toThrow('network costs');
  });

  it('submits signed bytes with preflight and waits for confirmation', async () => {
    const signature = Keypair.generate().publicKey.toBase58().repeat(2);
    const fetch = rpcMock({ sendTransaction: signature });
    vi.stubGlobal('fetch', fetch);

    await expect(
      submitSignedSolanaTransaction(new Uint8Array([1, 2, 3])),
    ).resolves.toBe(signature);
    await expect(
      waitForSolanaConfirmation(signature, { attempts: 1, intervalMs: 0 }),
    ).resolves.toBeUndefined();
    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse(init?.body as string),
    );
    expect(bodies[0]).toMatchObject({
      method: 'sendTransaction',
      params: [
        expect.any(String),
        { preflightCommitment: 'confirmed', skipPreflight: false },
      ],
    });
    expect(bodies[1].method).toBe('getSignatureStatuses');
    expect(solanaTransactionUrl(signature)).toContain('/tx/');
  });

  it('surfaces a confirmed transaction failure', async () => {
    vi.stubGlobal(
      'fetch',
      rpcMock({
        getSignatureStatuses: {
          value: [
            { confirmationStatus: 'confirmed', err: { InstructionError: 1 } },
          ],
        },
      }),
    );
    await expect(
      waitForSolanaConfirmation(Keypair.generate().publicKey.toBase58(), {
        attempts: 1,
        intervalMs: 0,
      }),
    ).rejects.toThrow('transaction failed');
  });
});
