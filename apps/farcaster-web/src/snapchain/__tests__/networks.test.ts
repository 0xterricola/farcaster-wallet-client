/**
 * Which network Fiddy is reading, and which ones it may offer.
 *
 * What these tests hold, in one place: a network is never GUESSED. It comes
 * from a listed address whose network was measured, or from what the deployment
 * recorded; anything else reads as "not recorded", with the reason. And a
 * network is only OFFERED when there is an address for it — Snapchain has no
 * public node a stranger can read, so on a build without its own node it is
 * offered as nothing and says why.
 */

import { describe, expect, it } from 'vitest';

import {
  declaredNetwork,
  isFiddyNetwork,
  networkName,
  networkOffers,
  networkOfPublicAddress,
  networkReadingLine,
  publicAddressForNetwork,
  readNetwork,
  routeForNetwork,
} from '~/snapchain/networks';
import { PUBLIC_READ_NODES } from '~/snapchain/nodeChoice';

const PUBLIC_URL = PUBLIC_READ_NODES[0].url;
const OWN_URL = 'https://mine.example:3381';

describe('the network vocabulary', () => {
  it('knows exactly the two networks, and refuses anything else', () => {
    expect(isFiddyNetwork('snapchain')).toBe(true);
    expect(isFiddyNetwork('hypersnap')).toBe(true);
    expect(isFiddyNetwork('Snapchain')).toBe(false);
    expect(isFiddyNetwork('farcaster')).toBe(false);
    expect(isFiddyNetwork(null)).toBe(false);
  });

  it('names a reading, including the honest unknown', () => {
    expect(networkName('hypersnap')).toBe('Hypersnap');
    expect(networkName('snapchain')).toBe('Snapchain');
    expect(networkName(null)).toBe('Not recorded');
    expect(networkReadingLine({ network: null, source: null, why: 'x' })).toBe(
      'Network: not recorded',
    );
    expect(
      networkReadingLine({ network: 'hypersnap', source: 'address', why: 'x' }),
    ).toBe('Network: Hypersnap');
  });

  it('reads a network off a listed address, and nothing off a stranger', () => {
    expect(networkOfPublicAddress(PUBLIC_URL)).toBe('hypersnap');
    expect(networkOfPublicAddress(`${PUBLIC_URL}/`)).toBe('hypersnap');
    expect(networkOfPublicAddress('https://somebody-elses.example')).toBe(null);
    expect(networkOfPublicAddress(null)).toBe(null);
    expect(publicAddressForNetwork('hypersnap')).toBe(PUBLIC_URL);
    expect(publicAddressForNetwork('snapchain')).toBe(null);
  });

  it('takes a network from the deployment only when it names a real one', () => {
    expect(declaredNetwork({ VITE_FIDDY_NETWORK: 'snapchain' })).toBe(
      'snapchain',
    );
    expect(declaredNetwork({ VITE_FIDDY_NETWORK: ' Snapchain ' })).toBe(
      'snapchain',
    );
    expect(declaredNetwork({ VITE_FIDDY_NETWORK: 'hub' })).toBe(null);
    expect(declaredNetwork({})).toBe(null);
    expect(declaredNetwork({ VITE_FIDDY_NETWORK: 7 })).toBe(null);
  });
});

describe('readNetwork', () => {
  it('answers from the address when the address is a listed public node', () => {
    const reading = readNetwork({ choiceUrl: PUBLIC_URL, env: {} });

    expect(reading.network).toBe('hypersnap');
    expect(reading.source).toBe('address');
    expect(reading.why).toContain('measured when it was listed');
  });

  it('answers from what the deployment recorded for an own node', () => {
    const reading = readNetwork({
      choiceUrl: OWN_URL,
      choiceKind: 'own',
      env: { VITE_FIDDY_NETWORK: 'snapchain' },
    });

    expect(reading.network).toBe('snapchain');
    expect(reading.source).toBe('build');
    expect(reading.why).toContain(OWN_URL);
  });

  it('answers from the build even when the reader has chosen nothing yet', () => {
    const reading = readNetwork({
      choiceUrl: null,
      env: { VITE_FIDDY_NETWORK: 'hypersnap' },
    });

    expect(reading.network).toBe('hypersnap');
    expect(reading.source).toBe('build');
  });

  it('says it is not recorded rather than guessing, when nothing says', () => {
    const reading = readNetwork({
      choiceUrl: OWN_URL,
      choiceKind: 'own',
      env: {},
    });

    expect(reading.network).toBe(null);
    expect(reading.source).toBe(null);
    expect(reading.why).toContain('does not say which network it is');
    expect(reading.why).toContain('will not guess');
  });

  it('says there is no network to name when no server is named at all', () => {
    const reading = readNetwork({ choiceUrl: null, env: {} });

    expect(reading.network).toBe(null);
    expect(reading.why).toContain('No server has been named yet');
  });
});

describe('routeForNetwork', () => {
  it('sends Hypersnap to the listed public node', () => {
    const route = routeForNetwork('hypersnap', { env: {} });

    expect(route).toEqual({
      network: 'hypersnap',
      kind: 'public',
      url: PUBLIC_URL,
      note: expect.stringContaining('public node'),
    });
  });

  it('sends Snapchain to the reader own node, and only when the build says so', () => {
    expect(routeForNetwork('snapchain', { env: {} })).toBe(null);

    const route = routeForNetwork('snapchain', {
      choiceUrl: OWN_URL,
      env: { VITE_FIDDY_NETWORK: 'snapchain' },
    });
    expect(route?.kind).toBe('own');
    expect(route?.url).toBe(OWN_URL);
  });

  it('does not hand a build-configured node to the other network', () => {
    // The build's node speaks Hypersnap; asking for Snapchain does not get it.
    expect(
      routeForNetwork('snapchain', {
        env: {
          VITE_SNAPCHAIN_HTTP_URL: PUBLIC_URL,
          VITE_FIDDY_NETWORK: 'hypersnap',
        },
      }),
    ).toBe(null);
  });
});

describe('networkOffers', () => {
  it('offers both networks, each with the address it would be read from', () => {
    const offers = networkOffers({
      choiceUrl: OWN_URL,
      env: { VITE_FIDDY_NETWORK: 'snapchain' },
    });

    expect(offers.map((offer) => offer.facts.id)).toEqual([
      'snapchain',
      'hypersnap',
    ]);
    expect(offers[0].route?.url).toBe(OWN_URL);
    expect(offers[1].route?.url).toBe(PUBLIC_URL);
  });

  it('offers only what can be read: no own node, no Snapchain option', () => {
    const offers = networkOffers({ env: {} });

    expect(offers[0].route).toBe(null);
    expect(offers[0].why).toContain('fiddy node up --network snapchain');
    expect(offers[1].route?.url).toBe(PUBLIC_URL);
  });
});
