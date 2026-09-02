import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SOLANA_RPC_URL,
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  fetchSolanaTokenPortfolio,
  formatSolanaTokenAmount,
  formatSolBalance,
  LIFI_SOLANA_CHAIN_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  solanaAddressUrl,
  solanaTokenUsd,
} from '~/utils/solanaWallet';

const tokenAccount = (mint: string, amount: string, decimals: number) => ({
  pubkey: `${mint}TokenAccount`,
  account: {
    data: {
      parsed: { info: { mint, tokenAmount: { amount, decimals } } },
    },
  },
});

describe('Solana wallet data', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a confirmed balance from the configured RPC', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: { value: 1_250_000_000 } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSolanaBalance('SolanaAddress', {
        rpcUrl: 'https://rpc.example.com',
      }),
    ).resolves.toBe(1_250_000_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rpc.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(request).toMatchObject({
      method: 'getBalance',
      params: ['SolanaAddress', { commitment: 'confirmed' }],
    });
  });

  it('uses the browser-compatible mainnet fallback when no RPC is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { value: 1 } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSolanaBalance('SolanaAddress');

    expect(fetchMock).toHaveBeenCalledWith(
      DEFAULT_SOLANA_RPC_URL,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces RPC errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 200,
        }),
      ),
    );
    await expect(fetchSolanaBalance('SolanaAddress')).rejects.toThrow(
      'rate limited',
    );
  });

  it('rejects malformed balances', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: { value: -1 } }), {
          status: 200,
        }),
      ),
    );
    await expect(fetchSolanaBalance('SolanaAddress')).rejects.toThrow(
      'invalid balance',
    );
  });

  it('formats lamports as SOL', () => {
    expect(formatSolBalance(1_250_000_000)).toBe('1.25 SOL');
  });

  it('builds a Mainnet explorer address link', () => {
    expect(solanaAddressUrl('abc/123')).toBe(
      'https://explorer.solana.com/address/abc%2F123?cluster=mainnet-beta',
    );
  });

  it('reads, aggregates, and removes empty SPL token accounts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              value: [
                tokenAccount('UsdcMint', '1200000', 6),
                tokenAccount('UsdcMint', '300000', 6),
                tokenAccount('EmptyMint', '0', 6),
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { value: [] },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSolanaTokenAccounts('SolanaAddress')).resolves.toEqual([
      {
        amount: '1500000',
        decimals: 6,
        mint: 'UsdcMint',
        programId: expect.any(String),
        tokenAccounts: [
          { address: 'UsdcMintTokenAccount', amount: '1200000' },
          { address: 'UsdcMintTokenAccount', amount: '300000' },
        ],
      },
    ]);
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string),
    );
    expect(
      bodies.every((body) => body.method === 'getTokenAccountsByOwner'),
    ).toBe(true);
    expect(new Set(bodies.map((body) => body.params[1].programId)).size).toBe(
      2,
    );
  });

  it('combines on-chain balances with LI.FI metadata without trusting indexed amounts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (typeof input === 'string' && input.startsWith('https://li.quest')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                tokens: {
                  [LIFI_SOLANA_CHAIN_ID]: [
                    {
                      address: 'UsdcMint',
                      chainId: LIFI_SOLANA_CHAIN_ID,
                      decimals: 6,
                      name: 'USD Coin',
                      priceUSD: '1',
                      symbol: 'USDC',
                    },
                  ],
                },
              }),
              { status: 200 },
            ),
          );
        }
        const body = JSON.parse(init?.body as string);
        const value = body.params[1].programId.includes('Tokenkeg')
          ? [
              tokenAccount('UsdcMint', '2500000', 6),
              tokenAccount('UnknownMint', '7', 0),
            ]
          : [];
        return Promise.resolve(
          new Response(JSON.stringify({ result: { value } }), { status: 200 }),
        );
      }),
    );

    const assets = await fetchSolanaTokenPortfolio('SolanaAddress');
    expect(assets).toEqual([
      expect.objectContaining({
        amount: '2500000',
        mint: 'UsdcMint',
        priceUSD: 1,
        recognized: true,
        symbol: 'USDC',
      }),
      expect.objectContaining({
        amount: '7',
        mint: 'UnknownMint',
        recognized: false,
      }),
    ]);
  });

  it('formats SPL amounts and estimated value without floating-point unit conversion', () => {
    const asset = {
      amount: '1234567',
      decimals: 6,
      mint: 'UsdcMint',
      name: 'USD Coin',
      priceUSD: 1,
      programId: SOLANA_TOKEN_PROGRAM_ID,
      recognized: true,
      symbol: 'USDC',
      tokenAccounts: [],
    };
    expect(formatSolanaTokenAmount(asset)).toBe('1.234567');
    expect(solanaTokenUsd(asset)).toBe(1.234567);
  });
});
