import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifySolanaTransaction,
  fetchSolanaActivity,
  fetchSolanaSignatures,
  fetchSolanaTransaction,
  SolanaSignatureEntry,
} from '~/utils/solanaActivity';

const WALLET = 'WalletAddress11111111111111111111111111111';
const OTHER = 'OtherAddress2222222222222222222222222222222';
const MINT = 'MintAddress33333333333333333333333333333333';

const signatureEntry = (
  overrides: Partial<SolanaSignatureEntry> = {},
): SolanaSignatureEntry => ({
  blockTime: 1_700_000_000,
  signature: 'Signature1111111111111111111111111111111111111111111111111111111',
  slot: 42,
  ...overrides,
});

function transaction({
  accountKeys = [WALLET, OTHER],
  err = null,
  fee = 5_000,
  innerInstructions = [],
  instructions = [],
  postBalances,
  postTokenBalances = [],
  preBalances,
  preTokenBalances = [],
}: {
  accountKeys?: readonly string[];
  err?: unknown;
  fee?: number;
  innerInstructions?: unknown[];
  instructions?: unknown[];
  postBalances?: readonly number[];
  postTokenBalances?: unknown[];
  preBalances?: readonly number[];
  preTokenBalances?: unknown[];
}) {
  return {
    meta: {
      err,
      fee,
      innerInstructions,
      postBalances: postBalances ?? accountKeys.map(() => 1_000_000_000),
      postTokenBalances,
      preBalances: preBalances ?? accountKeys.map(() => 1_000_000_000),
      preTokenBalances,
    },
    transaction: {
      message: {
        accountKeys: accountKeys.map((pubkey) => ({ pubkey })),
        instructions,
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('classifySolanaTransaction', () => {
  it('classifies a native SOL send as the fee payer', () => {
    const tx = transaction({
      accountKeys: [WALLET, OTHER],
      postBalances: [899_995_000, 1_100_000_000],
      preBalances: [1_000_000_000, 1_000_000_000],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.type).toBe('send');
    expect(result.status).toBe('success');
    expect(result.sentAsset).toEqual({
      amount: '100000000',
      decimals: 9,
      mint: undefined,
    });
  });

  it('classifies a native SOL receive', () => {
    const tx = transaction({
      accountKeys: [OTHER, WALLET],
      postBalances: [899_995_000, 1_100_000_000],
      preBalances: [1_000_000_000, 1_000_000_000],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.type).toBe('receive');
    expect(result.receivedAsset).toEqual({
      amount: '100000000',
      decimals: 9,
      mint: undefined,
    });
  });

  it('classifies an SPL token send from the wallet-owned token account', () => {
    const tx = transaction({
      accountKeys: [OTHER, WALLET],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '400', decimals: 6 },
        },
      ],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '1000', decimals: 6 },
        },
      ],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.type).toBe('send');
    expect(result.sentAsset).toEqual({
      amount: '600',
      decimals: 6,
      mint: MINT,
    });
  });

  it('classifies a swap only when a recognized router is present', () => {
    const tx = transaction({
      accountKeys: [WALLET, OTHER],
      instructions: [
        { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' },
      ],
      postBalances: [899_995_000, 1_000_000_000],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '500', decimals: 6 },
        },
      ],
      preBalances: [1_000_000_000, 1_000_000_000],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '0', decimals: 6 },
        },
      ],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.type).toBe('swap');
    expect(result.sentAsset?.mint).toBeUndefined();
    expect(result.receivedAsset?.mint).toBe(MINT);
  });

  it('does not guess "swap" for an unrecognized multi-asset transaction', () => {
    const tx = transaction({
      accountKeys: [WALLET, OTHER],
      postBalances: [899_995_000, 1_000_000_000],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '500', decimals: 6 },
        },
      ],
      preBalances: [1_000_000_000, 1_000_000_000],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '0', decimals: 6 },
        },
      ],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.type).toBe('unknown');
    expect(result.sentAsset).toBeUndefined();
    expect(result.receivedAsset).toBeUndefined();
  });

  it('marks a failed transaction as failed while still classifying it', () => {
    const tx = transaction({
      accountKeys: [WALLET, OTHER],
      err: { InstructionError: [0, 'Custom'] },
      postBalances: [899_995_000, 1_000_000_000],
      preBalances: [1_000_000_000, 1_000_000_000],
    });
    const result = classifySolanaTransaction(tx, signatureEntry(), WALLET);
    expect(result.status).toBe('failed');
    expect(result.type).toBe('send');
  });

  it('returns an honest "unknown" for a transaction the RPC could not return', () => {
    const entry = signatureEntry({ err: null });
    const result = classifySolanaTransaction(undefined, entry, WALLET);
    expect(result).toMatchObject({
      status: 'success',
      type: 'unknown',
      signature: entry.signature,
    });
  });

  it('degrades to "unknown" instead of throwing on a malformed transaction shape', () => {
    const malformed = { transaction: {} } as Record<string, unknown>;
    expect(() =>
      classifySolanaTransaction(malformed, signatureEntry(), WALLET),
    ).not.toThrow();
    expect(
      classifySolanaTransaction(malformed, signatureEntry(), WALLET).type,
    ).toBe('unknown');
  });
});

describe('fetchSolanaSignatures', () => {
  it('requests a bounded page of recent signatures, capped at five', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', result: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSolanaSignatures(WALLET, {
      limit: 20,
      rpcUrl: 'https://rpc.example.com',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      method: 'getSignaturesForAddress',
      params: [WALLET, { commitment: 'confirmed', limit: 5 }],
    });
  });

  it('rejects on an RPC error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: 200,
        }),
      ),
    );
    await expect(fetchSolanaSignatures(WALLET)).rejects.toThrow('boom');
  });
});

describe('fetchSolanaTransaction', () => {
  it('returns undefined for a not-yet-indexed transaction instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: null }), {
          status: 200,
        }),
      ),
    );
    await expect(fetchSolanaTransaction('Sig')).resolves.toBeUndefined();
  });
});

describe('fetchSolanaActivity', () => {
  it('returns the recent activity as a plain, bounded list', async () => {
    const signatures = Array.from({ length: 2 }, (_, index) => ({
      blockTime: 1_700_000_000 + index,
      signature: `Sig${index}`,
      slot: index,
    }));
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse((init as { body: string }).body);
        if (body.method === 'getSignaturesForAddress') {
          return Promise.resolve(
            new Response(JSON.stringify({ result: signatures }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ result: null }), { status: 200 }),
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const activity = await fetchSolanaActivity(WALLET);
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ signature: 'Sig0' });
  });

  it('falls back to "unknown" for one transaction instead of failing the whole list', async () => {
    const signatures = [
      { blockTime: 1_700_000_000, signature: 'Sig0', slot: 0 },
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse((init as { body: string }).body);
        if (body.method === 'getSignaturesForAddress') {
          return Promise.resolve(
            new Response(JSON.stringify({ result: signatures }), {
              status: 200,
            }),
          );
        }
        return Promise.reject(new Error('network blip'));
      });
    vi.stubGlobal('fetch', fetchMock);

    const activity = await fetchSolanaActivity(WALLET);
    expect(activity).toEqual([
      expect.objectContaining({ signature: 'Sig0', type: 'unknown' }),
    ]);
  });
});
