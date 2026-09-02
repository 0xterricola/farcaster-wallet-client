import { afterEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line no-restricted-imports
import { onRequest } from '../../../../../functions/~wallet/activity';

const wallet = '0x1111111111111111111111111111111111111111';

function request(
  query: string,
  keys: { alchemy?: string; etherscan?: string } = {},
) {
  return onRequest({
    request: new Request(`https://wallet.example/~wallet/activity?${query}`),
    env: {
      ALCHEMY_API_KEY: keys.alchemy,
      ETHERSCAN_API_KEY: keys.etherscan,
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('wallet activity Pages Function', () => {
  it('rejects invalid addresses and unsupported networks without fetching', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(
      (await request('address=bad&chainId=8453', { alchemy: 'secret' })).status,
    ).toBe(400);
    expect(
      (
        await request(`address=${wallet}&chainId=123456`, {
          etherscan: 'secret',
        })
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a server-side Etherscan key', async () => {
    const response = await request(`address=${wallet}&chainId=1`);
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
    const response = await request(`address=${wallet}&chainId=1`, {
      etherscan: 'secret',
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.etherscan.io');
      expect(parsed.searchParams.get('chainid')).toBe('1');
      expect(parsed.searchParams.get('address')).toBe(wallet);
      expect(parsed.searchParams.get('apikey')).toBe('secret');
    }
    expect(await response.json()).toMatchObject({
      source: 'etherscan',
      normalTransactions: [{ hash: 'x' }],
      tokenTransfers: [{ hash: 'x' }],
    });
  });

  it('requires a server-side Alchemy key for its three routed networks', async () => {
    for (const chainId of [56, 4663, 8453]) {
      const response = await request(`address=${wallet}&chainId=${chainId}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Wallet history is not configured.',
      });
    }
  });

  it.each([
    [56, 'https://bnb-mainnet.g.alchemy.com'],
    [4663, 'https://robinhood-mainnet.g.alchemy.com'],
    [8453, 'https://base-mainnet.g.alchemy.com'],
  ])(
    'routes chain %i transfer history through Alchemy',
    async (chainId, origin) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ result: { transfers: [{ hash: 'x' }] } }),
              { status: 200 },
            ),
          ),
        );
      const response = await request(`address=${wallet}&chainId=${chainId}`, {
        alchemy: 'alchemy-secret',
      });
      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
      const directions = new Set<string>();
      for (const [url, options] of fetch.mock.calls) {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe(origin);
        expect(parsed.pathname).toBe('/v2/alchemy-secret');
        expect(options?.method).toBe('POST');
        const body = JSON.parse(String(options?.body)) as {
          method: string;
          params: Array<Record<string, unknown>>;
        };
        expect(body.method).toBe('alchemy_getAssetTransfers');
        expect(body.params[0]).toMatchObject({
          category: ['external', 'erc20'],
          withMetadata: true,
          maxCount: '0x14',
          order: 'desc',
        });
        if (body.params[0].fromAddress === wallet) {
          directions.add('outgoing');
        }
        if (body.params[0].toAddress === wallet) {
          directions.add('incoming');
        }
      }
      expect(directions).toEqual(new Set(['outgoing', 'incoming']));
      expect(await response.json()).toEqual({
        source: 'alchemy',
        outgoingTransfers: [{ hash: 'x' }],
        incomingTransfers: [{ hash: 'x' }],
      });
    },
  );
});
