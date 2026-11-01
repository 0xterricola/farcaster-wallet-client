// @vitest-environment jsdom
/**
 * Adding funds, as the person meets it.
 *
 * The four claims worth holding this component to, asserted here:
 *
 *   1. the amounts come from the server's config, not from a list in the
 *      component, and the $1 floor is the server's number;
 *   2. nothing is sent without the review — the sheet that names the amount,
 *      the currency, the network and the address — and the review is what
 *      carries the send;
 *   3. a session the service will not credit cannot reach a send: the reason is
 *      on screen, the button is disabled, and no callback fires;
 *   4. a failure names its code and offers "check again" (which sends nothing)
 *      whenever a transfer hash exists.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AddFundsSheet,
  type AddFundsSheetProps,
} from '~/components/fiddy/AddFundsSheet';
import type { TopUpProgress } from '~/hooks/fiddy/useFiddyTopUp';
import { parseFundingConfig } from '~/lib/fiddyCredit';

const TREASURY = '0xe4c848a6fa503762e95ad862cd1e5f7f9f0aab5f';
const HASH = `0x${'ab'.repeat(32)}`;

const config = parseFundingConfig({
  ok: true,
  chain: { id: 8453, name: 'Base', caip2: 'eip155:8453' },
  asset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  treasury: { address: TREASURY, short: '0xe4c8…ab5f' },
  minimum: { usdc: '1.00', baseUnits: '1000000' },
  confirmations: 5,
  presets: [
    { usd: 5, label: 'Top up $5', usdc: '5.00', baseUnits: '5000000' },
    { usd: 10, label: 'Top up $10', usdc: '10.00', baseUnits: '10000000' },
    { usd: 25, label: 'Top up $25', usdc: '25.00', baseUnits: '25000000' },
  ],
  creditNote: 'A credit.',
});

const onSend = vi.fn();
const onCheckPending = vi.fn();
const onForgetPending = vi.fn();
const onDone = vi.fn();

const props = (
  overrides: Partial<AddFundsSheetProps> = {},
): AddFundsSheetProps => ({
  config,
  configLine: null,
  session: 'ready',
  sessionLine: null,
  sessionCode: null,
  walletOptions: [
    {
      source: 'wallet',
      label: 'MetaMask',
      line: 'A wallet in this browser.',
      available: true,
    },
  ],
  pending: null,
  progress: { name: 'idle' },
  busy: false,
  onSend,
  onCheckPending,
  onForgetPending,
  onDone,
  quiet: null,
  ...overrides,
});

const progress = (value: TopUpProgress) => props({ progress: value });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the amount step', () => {
  it('offers the server’s own presets and a field for another amount', () => {
    render(<AddFundsSheet {...props()} />);

    expect(screen.getByLabelText('Top up $5')).toBeTruthy();
    expect(screen.getByLabelText('Top up $10')).toBeTruthy();
    expect(screen.getByLabelText('Top up $25')).toBeTruthy();
    expect(screen.getByText(/Smallest top-up is \$1\.00\./)).toBeTruthy();
    expect(screen.getByText('Pay with')).toBeTruthy();
    expect(screen.getByText('MetaMask')).toBeTruthy();
  });

  it('refuses an amount below the floor the server set', () => {
    render(<AddFundsSheet {...props()} />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '0.50' },
    });

    expect(
      screen.getByText('Fiddy adds $1.00 or more at a time.'),
    ).toBeTruthy();
    expect(
      (screen.getByText('Review $0.50') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('refuses an amount that is not dollars rather than rounding it', () => {
    render(<AddFundsSheet {...props()} />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '5.001' },
    });

    expect(
      screen.getByText('Enter an amount in dollars, like 5 or 12.50.'),
    ).toBeTruthy();
    expect(
      (screen.getByText('Review $5.001') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('cannot send when the service will not credit this session, and says why', () => {
    render(
      <AddFundsSheet
        {...props({
          session: 'refused',
          sessionLine:
            'Sign in to Fiddy first, so the top-up can land in your balance.',
          sessionCode: 'AUTH_REQUIRED',
        })}
      />,
    );

    expect(
      screen.getByText(
        'Sign in to Fiddy first, so the top-up can land in your balance. (AUTH_REQUIRED)',
      ),
    ).toBeTruthy();
    const review = screen.getByText('Review $5.00') as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.click(review);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('the review sheet, before anything is sent', () => {
  it('names the amount, the currency, the network and the address', () => {
    render(<AddFundsSheet {...props()} />);
    fireEvent.click(screen.getByText('Review $5.00'));

    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('USDC on Base')).toBeTruthy();
    expect(screen.getByText('0xe4c8…ab5f')).toBeTruthy();
    expect(
      screen.getByLabelText("Copy Fiddy's address").getAttribute('title'),
    ).toBe(TREASURY);
    expect(screen.getByText('MetaMask')).toBeTruthy();
    expect(
      screen.getByText(
        /Fiddy waits until Base has settled the transfer, then adds it to your\s+Fiddy balance/,
      ),
    ).toBeTruthy();
  });

  it('is where the send happens, once, with the amount that was reviewed', () => {
    render(<AddFundsSheet {...props()} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '12.50' },
    });
    fireEvent.click(screen.getByText('Review $12.50'));
    fireEvent.click(screen.getByText('Send $12.50'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('12.50', 'wallet');
  });

  it('can be backed out of without sending', () => {
    render(<AddFundsSheet {...props()} />);
    fireEvent.click(screen.getByText('Review $5.00'));
    fireEvent.click(screen.getByText('Change the amount'));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Top up $5')).toBeTruthy();
  });
});

describe('after the send', () => {
  it('waits honestly while the wallet is being asked', () => {
    render(<AddFundsSheet {...progress({ name: 'sending' })} />);
    expect(screen.getByText(/Nothing has moved yet/)).toBeTruthy();
  });

  it('says Base is still settling rather than "done" or "failed"', () => {
    render(<AddFundsSheet {...progress({ name: 'confirming', attempt: 3 })} />);
    expect(
      screen.getByText(/Base is still settling that transfer/),
    ).toBeTruthy();
  });

  it('reports the credit landing', () => {
    render(
      <AddFundsSheet
        {...progress({ name: 'credited', usdc: '5.00', settled: true })}
      />,
    );
    expect(screen.getByText(/Added \$5.00 to your Fiddy balance/)).toBeTruthy();
  });

  it('never credits twice, and says so in words', () => {
    render(
      <AddFundsSheet
        {...progress({ name: 'already-credited', usdc: '5.00' })}
      />,
    );
    expect(screen.getByText(/already in your Fiddy balance/)).toBeTruthy();
    expect(screen.getByText(/not added twice/)).toBeTruthy();
  });

  it('names a failure’s code, and offers to check a transfer it kept', () => {
    render(
      <AddFundsSheet
        {...progress({
          name: 'failed',
          code: 'FUNDING_CREDIT_UNAVAILABLE',
          line: 'Fiddy could not add that just now.',
          txHash: HASH,
        })}
      />,
    );

    expect(screen.getByText('Fiddy could not add that just now.')).toBeTruthy();
    expect(screen.getByText('FUNDING_CREDIT_UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();

    fireEvent.click(screen.getByText('Check that transfer again'));
    expect(onCheckPending).toHaveBeenCalledTimes(1);
    // Checking is free: a failure with a hash must never offer a second send.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers a way back to a failure that has no transfer behind it', () => {
    render(
      <AddFundsSheet
        {...progress({
          name: 'failed',
          code: 'DECLINED',
          line: 'That was not approved, so nothing was sent.',
          txHash: null,
        })}
      />,
    );

    expect(
      screen.getByText('That was not approved, so nothing was sent.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('a transfer from earlier that is not in the balance yet', () => {
  it('is offered at the top of the sheet, with a free way to check it', () => {
    render(
      <AddFundsSheet
        {...props({
          pending: {
            txHash: HASH,
            usdc: '5.00',
            at: Date.now(),
            source: 'wallet',
          },
        })}
      />,
    );

    expect(
      screen.getByText(/A transfer from earlier is not in your balance yet/),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Check again'));
    expect(onCheckPending).toHaveBeenCalledTimes(1);
  });
});
