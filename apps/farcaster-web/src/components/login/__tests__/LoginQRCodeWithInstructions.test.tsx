// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginQRCodeWithInstructions } from '~/components/login/LoginQRCodeWithInstructions';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock('~/contexts/AnalyticsProvider', () => ({
  useAnalytics: () => ({ trackEvent }),
}));

// The QR itself is a lazy chunk with a canvas dependency; what this screen does
// with it — show it or not — is the thing under test, so the code is a stub
// that names the URL it was handed.
vi.mock('~/lazy/components', () => ({
  LoginQRCode: ({ url }: { url: string }) => (
    <div data-testid="login-qr-code">{url}</div>
  ),
}));

const RELAY_URL = 'https://farcaster.xyz/~/siwf?channelToken=ABCD1234';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const withUserAgent = (userAgent: string) => {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
};

const renderScreen = () =>
  render(
    <LoginQRCodeWithInstructions
      attemptingLogin={false}
      onClose={() => undefined}
      url={RELAY_URL}
    />,
  );

beforeEach(() => {
  trackEvent.mockClear();
});

afterEach(() => {
  cleanup();
  withUserAgent(DESKTOP_UA);
});

describe('LoginQRCodeWithInstructions on a phone', () => {
  beforeEach(() => {
    withUserAgent(IPHONE_UA);
  });

  it('leads with one tap into the Farcaster app, pointing at the same URL the QR would carry', () => {
    renderScreen();

    const open = screen.getByText('Open in Farcaster on this phone');

    expect(open.closest('a')?.getAttribute('href')).toBe(RELAY_URL);
  });

  it('does not show a code the phone cannot scan, and offers it behind a toggle for another device', () => {
    renderScreen();

    expect(screen.queryByTestId('login-qr-code')).toBeNull();

    fireEvent.click(screen.getByText('Show QR code for another device'));

    expect(screen.getByTestId('login-qr-code').textContent).toBe(RELAY_URL);
  });

  it('counts the tap, so what people actually use is measurable', () => {
    renderScreen();

    fireEvent.click(screen.getByText('Open in Farcaster on this phone'));

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(String(trackEvent.mock.calls[0][0])).toContain(
      'clicked open in farcaster app',
    );
  });
});

describe('LoginQRCodeWithInstructions on a desktop', () => {
  beforeEach(() => {
    withUserAgent(DESKTOP_UA);
  });

  it('keeps the code as the first thing on screen, as before', () => {
    renderScreen();

    expect(screen.getByTestId('login-qr-code').textContent).toBe(RELAY_URL);
    expect(screen.queryByText('Open in Farcaster on this phone')).toBeNull();
    expect(screen.queryByText('Show QR code for another device')).toBeNull();
  });
});
