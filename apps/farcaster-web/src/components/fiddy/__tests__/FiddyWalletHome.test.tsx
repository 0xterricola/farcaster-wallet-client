// @vitest-environment jsdom
/**
 * The wallet home, and the boundary it must not cross.
 *
 * The load-bearing tests are the last two: signing is the owner's wallet's job,
 * and the page stops at the signature. `no mainnet spend` is asserted by
 * counting the requests this surface makes — it asks Surp for a price and it
 * never sends a payment — and `clicking pay with no wallet` is asserted to say
 * so rather than to throw.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import chat402 from '~/lib/surp/__tests__/fixtures/chat-402.json';
import { FiddyWalletHome } from '~/components/fiddy/FiddyWalletHome';
import type { PreparedPayment } from '~/lib/surp/x402';
import { EMPTY_WALLET_CONNECTIONS } from '~/utils/walletFamily';
import type { WalletConnections } from '~/utils/walletFamily';

const BASE = '0x1111111111111111111111111111111111111111';
const SIGNATURE = `0x${'cd'.repeat(65)}` as const;

const connected: WalletConnections = {
  ...EMPTY_WALLET_CONNECTIONS,
  evm: { status: 'connected', address: BASE, walletName: 'Rainbow' },
};

const stub402 = () => {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 402,
    json: async () => chat402,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the wallet choice', () => {
  it('shows both choices, and says who makes the second one', () => {
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={EMPTY_WALLET_CONNECTIONS}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByText('Bring your Farcaster wallet')).toBeTruthy();
    expect(screen.getByText('Create a fresh wallet for me')).toBeTruthy();
    expect(screen.getByText(/Your Fiddy account makes that wallet/)).toBeTruthy();
  });

  it('records the choice the owner makes', () => {
    const onChoose = vi.fn();
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={EMPTY_WALLET_CONNECTIONS}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(
      document.querySelector('[data-fiddy-wallet-choice="fresh"]') as HTMLElement,
    );
    expect(onChoose).toHaveBeenCalledWith('fresh');
  });

  it('names the wallet that pays, and what it pays for', () => {
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={connected}
        chainId={8453}
        onChoose={() => {}}
      />,
    );
    const summary = document.querySelector('[data-fiddy-wallet-summary]');
    expect(summary?.getAttribute('data-fiddy-wallet-summary')).toBe('can-pay');
    expect(summary?.textContent).toContain('Rainbow');
    expect(summary?.textContent).toContain('pays for Surp');
  });

  it('will not pretend a wallet can pay when none is connected', () => {
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={EMPTY_WALLET_CONNECTIONS}
        onChoose={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-fiddy-wallet-summary]')?.getAttribute(
        'data-fiddy-wallet-summary',
      ),
    ).toBe('cannot-pay');
  });
});

describe('paying, without paying', () => {
  it('asks Surp for the price and shows the sentence before anything is signed', async () => {
    stub402();
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={connected}
        chainId={8453}
        onChoose={() => {}}
        onSignTypedData={vi.fn(async () => SIGNATURE)}
      />,
    );
    fireEvent.click(document.querySelector('[data-fiddy="wallet-ask-price"]') as HTMLElement);
    const notice = await screen.findByText(/Pay \$0.01 from your wallet/);
    expect(notice.textContent).toContain('Your wallet will ask you to approve it');
  });

  it('signs with the owner’s wallet and stops there', async () => {
    const fetchMock = stub402();
    const onSignTypedData = vi.fn(
      async (_typedData: PreparedPayment['typedData']) => SIGNATURE,
    );
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={connected}
        chainId={8453}
        onChoose={() => {}}
        onSignTypedData={onSignTypedData}
      />,
    );

    fireEvent.click(document.querySelector('[data-fiddy="wallet-ask-price"]') as HTMLElement);
    await screen.findByText(/Pay \$0.01 from your wallet/);
    fireEvent.click(document.querySelector('[data-fiddy="wallet-pay"]') as HTMLElement);

    await waitFor(() => {
      expect(onSignTypedData).toHaveBeenCalledTimes(1);
    });
    // The typed data it asked the wallet for is Surp's live offer.
    const asked = onSignTypedData.mock.calls[0][0];
    expect(asked.domain.chainId).toBe(8453);
    expect(asked.domain.verifyingContract.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
    expect(asked.message.to.toLowerCase()).toBe(
      '0x2f9518019575e048320c1e7da4dc4d6d8384c2c8',
    );
    expect(asked.message.value).toBe('10000');

    const signed = await screen.findByText(/Approved — one payment of \$0.01/);
    expect(signed.textContent).toContain('Nothing has been sent yet');

    // NOTHING WAS SPENT: every request this surface made was an unpaid price
    // probe, and no request carried a payment header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [, init] of fetchMock.mock.calls as unknown as [
      string,
      { headers?: Record<string, string> },
    ][]) {
      const headers = init?.headers ?? {};
      expect(headers['X-Payment']).toBeUndefined();
      expect(headers['PAYMENT-SIGNATURE']).toBeUndefined();
    }
  });

  it('treats a refusal in the wallet as a decision, not an error', async () => {
    stub402();
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={connected}
        chainId={8453}
        onChoose={() => {}}
        onSignTypedData={async () => {
          throw new Error('user rejected');
        }}
      />,
    );
    fireEvent.click(document.querySelector('[data-fiddy="wallet-ask-price"]') as HTMLElement);
    await screen.findByText(/Pay \$0.01 from your wallet/);
    fireEvent.click(document.querySelector('[data-fiddy="wallet-pay"]') as HTMLElement);
    await screen.findByText(/That was not approved, so nothing was paid/);
    expect(document.querySelector('[data-fiddy="wallet-signed"]')).toBeNull();
  });

  it('says to connect a wallet instead of throwing when there is none', async () => {
    stub402();
    const onSignTypedData = vi.fn(async () => SIGNATURE);
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={EMPTY_WALLET_CONNECTIONS}
        onChoose={() => {}}
        onSignTypedData={onSignTypedData}
      />,
    );
    fireEvent.click(document.querySelector('[data-fiddy="wallet-ask-price"]') as HTMLElement);
    await screen.findByText(/Pay \$0.01 from your wallet/);
    fireEvent.click(document.querySelector('[data-fiddy="wallet-pay"]') as HTMLElement);
    await screen.findByText(/Connect the wallet you want to pay from first/);
    expect(onSignTypedData).not.toHaveBeenCalled();
  });

  it('says the screen cannot reach a wallet when the client wires none', async () => {
    stub402();
    render(
      <FiddyWalletHome
        choice="farcaster"
        connections={EMPTY_WALLET_CONNECTIONS}
        onChoose={() => {}}
      />,
    );
    fireEvent.click(document.querySelector('[data-fiddy="wallet-ask-price"]') as HTMLElement);
    await screen.findByText(/Pay \$0.01 from your wallet/);
    fireEvent.click(document.querySelector('[data-fiddy="wallet-pay"]') as HTMLElement);
    await screen.findByText(/This screen cannot reach a wallet/);
    // Nothing was signed, so nothing can have been spent.
    expect(document.querySelector('[data-fiddy="wallet-signed"]')).toBeNull();
  });
});