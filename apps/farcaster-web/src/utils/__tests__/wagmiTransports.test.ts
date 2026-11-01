import { describe, expect, it } from 'vitest';
import { polygon } from 'wagmi/chains';

import { wagmiConfig } from '~/utils/wagmi';
import { DASHBOARD_CHAINS } from '~/utils/walletNetwork';

const transportUrl = (chainId: number) =>
  (
    wagmiConfig.getClient({ chainId }) as unknown as {
      transport: { url?: string };
    }
  ).transport.url;

// A chain's bundled viem default is whatever the package shipped, and Polygon's
// stopped answering keyless callers (`polygon-rpc.com` → `403 API key disabled,
// tenant disabled`, measured 2026-10-23; quilcast's own replacement,
// `polygon-bor-rpc.publicnode.com`, fails TLS from a browser with a certificate
// subject mismatch). Pin the endpoint here so a silent default cannot come back.
describe('wallet transports', () => {
  it('sends Polygon reads to the verified keyless endpoint', () => {
    const url = transportUrl(polygon.id);
    expect(url).toBe('https://1rpc.io/matic');
    expect(url).not.toMatch(/polygon-rpc\.com/);
    expect(url).not.toMatch(/publicnode\.com/);
  });

  it('gives every chain the wallet can show an explicit endpoint', () => {
    for (const chainId of [...DASHBOARD_CHAINS.keys(), polygon.id]) {
      const url = transportUrl(chainId);
      expect(url, `chain ${chainId}`).toMatch(/^https:\/\//);
    }
  });
});
