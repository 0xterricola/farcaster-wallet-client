import { afterEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line no-restricted-imports
import { onRequest } from '../../../../../functions/~wallet/solana-rpc';

const wallet = '11111111111111111111111111111111';

function request(method: string, params: unknown[], rpcUrl?: string) {
  return onRequest({
    env: { SOLANA_RPC_URL: rpcUrl },
    request: new Request('https://wallet.example/~wallet/solana-rpc', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Solana RPC Pages Function', () => {
  it('allows only the supported read methods and token programs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const rejected = await request('sendTransaction', ['secret']);
    expect(rejected.status).toBe(400);
    const wrongProgram = await request('getTokenAccountsByOwner', [
      wallet,
      { programId: 'NotAllowed' },
      { commitment: 'confirmed', encoding: 'jsonParsed' },
    ]);
    expect(wrongProgram.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('relays a confirmed balance read to the configured HTTPS endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 1, result: { value: 42 } }), {
        status: 200,
      }),
    );
    const response = await request(
      'getBalance',
      [wallet, { commitment: 'confirmed' }],
      'https://private-rpc.example/key',
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://private-rpc.example/key'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await response.json()).toEqual({ id: 1, result: { value: 42 } });
  });

  it('relays classic and Token-2022 account reads', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 1, result: { value: [] } }), {
        status: 200,
      }),
    );
    for (const programId of [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ]) {
      const response = await request('getTokenAccountsByOwner', [
        wallet,
        { programId },
        { commitment: 'confirmed', encoding: 'jsonParsed' },
      ]);
      expect(response.status).toBe(200);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an insecure configured upstream', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await request(
      'getBalance',
      [wallet, { commitment: 'confirmed' }],
      'http://rpc.example',
    );
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});
