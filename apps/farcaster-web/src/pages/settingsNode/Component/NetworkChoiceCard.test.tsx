// @vitest-environment jsdom
/**
 * The network chooser, as the reader meets it.
 *
 * What these tests hold: both networks are named in plain words, the one the
 * client is reading is stated, only a network this client has an address for is
 * offered — and pressing it really saves that address (which is what moves the
 * reads), while a network with nothing behind it says why instead of offering a
 * button.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  networkOffers,
  type NetworkRoute,
  readNetwork,
} from '~/snapchain/networks';
import { PUBLIC_READ_NODES } from '~/snapchain/nodeChoice';

import { NetworkChoiceCard } from './NetworkChoiceCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** No address answers in these tests unless the test says so. */
const offline = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );

const PUBLIC_URL = PUBLIC_READ_NODES[0].url;

describe('NetworkChoiceCard', () => {
  it('names both networks, and says which one this client is reading', () => {
    render(
      <NetworkChoiceCard
        reading={readNetwork({ choiceUrl: PUBLIC_URL, env: {} })}
        offers={networkOffers({ env: {} })}
        onChooseRoute={vi.fn()}
      />,
    );

    expect(screen.getByText('Snapchain')).toBeTruthy();
    expect(screen.getByText('Hypersnap')).toBeTruthy();
    expect(
      screen.getByText(/every account, cast and follow lives on/),
    ).toBeTruthy();
    expect(
      screen.getByText(/not where your Farcaster account lives/i),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy="network-choice"]'),
    ).toBeTruthy();
    expect(screen.getByText(/reading from hypersnap/)).toBeTruthy();
  });

  it('offers Hypersnap with the address reads would go to', () => {
    render(
      <NetworkChoiceCard
        reading={readNetwork({ choiceUrl: null, env: {} })}
        offers={networkOffers({ env: {} })}
        onChooseRoute={vi.fn()}
      />,
    );

    expect(screen.getByText(PUBLIC_URL)).toBeTruthy();
    expect(screen.getByText('Read from Hypersnap')).toBeTruthy();
  });

  it('does not offer Snapchain when nothing can answer for it, and says why', () => {
    render(
      <NetworkChoiceCard
        reading={readNetwork({ choiceUrl: null, env: {} })}
        offers={networkOffers({ env: {} })}
        onChooseRoute={vi.fn()}
      />,
    );

    expect(
      document.querySelector('[data-fiddy="network-blocked-snapchain"]'),
    ).toBeTruthy();
    expect(screen.queryByText('Read from Snapchain')).toBeNull();
    expect(screen.getByText(/fiddy node up --network snapchain/)).toBeTruthy();
  });

  it('saves the network address when a reader picks it, then reports what it answered', async () => {
    offline();
    const onChooseRoute = vi.fn(async (_route: NetworkRoute) => null);
    render(
      <NetworkChoiceCard
        reading={readNetwork({ choiceUrl: null, env: {} })}
        offers={networkOffers({ env: {} })}
        onChooseRoute={onChooseRoute}
      />,
    );

    fireEvent.click(screen.getByText('Read from Hypersnap'));

    await waitFor(() => expect(onChooseRoute).toHaveBeenCalledTimes(1));
    expect(onChooseRoute.mock.calls[0][0]).toEqual({
      network: 'hypersnap',
      kind: 'public',
      url: PUBLIC_URL,
      note: expect.any(String),
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'did not answer just now',
      ),
    );
  });

  it('offers Snapchain too when the build runs a node that speaks it', () => {
    render(
      <NetworkChoiceCard
        reading={readNetwork({
          choiceUrl: 'https://mine.example:3381',
          choiceKind: 'own',
          env: { VITE_FIDDY_NETWORK: 'snapchain' },
        })}
        offers={networkOffers({
          choiceUrl: 'https://mine.example:3381',
          env: { VITE_FIDDY_NETWORK: 'snapchain' },
        })}
        onChooseRoute={vi.fn()}
      />,
    );

    // This client is already reading Snapchain, so the Snapchain row says so
    // and the other network is the one on offer.
    expect(screen.getByText('Reading from this one')).toBeTruthy();
    expect(screen.getByText('https://mine.example:3381')).toBeTruthy();
    expect(screen.getByText('Read from Hypersnap')).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy="network-blocked-snapchain"]'),
    ).toBeNull();
  });
});
