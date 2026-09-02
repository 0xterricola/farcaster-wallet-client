import { afterEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line no-restricted-imports
import { onRequest } from '../../../../../functions/~wallet/activity';

const wallet = '0x1111111111111111111111111111111111111111';

function request(query: string, apiKey?: string) {
  return onRequest({
    request: new Request(`https://wallet.example/~wallet/activity?${query}`),
    env: { ETHERSCAN_API_KEY: apiKey },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('wallet activity Pages Function', () => {
  it('rejects invalid addresses and unsupported networks without fetching', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await request('address=bad&chainId=8453', 'secret')).status).toBe(
      400,
    );
    expect(
      (await request(`address=${wallet}&chainId=123456`, 'secret')).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a server-side Etherscan key', async () => {
    const response = await request(`address=${wallet}&chainId=8453`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Wallet history is not configured.',
    });
  });

  it('fetches normal and token activity from fixed Etherscan V2 endpoints', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: '1',
            message: 'OK',
            result: [{ hash: 'x' }],
          }),
          { status: 200 },
        ),
      ),
    );
    const response = await request(`address=${wallet}&chainId=8453`, 'secret');
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.etherscan.io');
      expect(parsed.searchParams.get('chainid')).toBe('8453');
      expect(parsed.searchParams.get('address')).toBe(wallet);
      expect(parsed.searchParams.get('apikey')).toBe('secret');
    }
    expect(await response.json()).toMatchObject({
      source: 'etherscan',
      normalTransactions: [{ hash: 'x' }],
      tokenTransfers: [{ hash: 'x' }],
    });
  });

  it('uses Robinhood Chain Blockscout without an Etherscan key', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: [] }), { status: 200 }),
        ),
      );
    const response = await request(`address=${wallet}&chainId=4663`);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) {
      expect(new URL(String(url)).origin).toBe(
        'https://robinhoodchain.blockscout.com',
      );
    }
    expect(await response.json()).toEqual({
      source: 'blockscout',
      normalTransactions: [],
      tokenTransfers: [],
    });
  });
});
