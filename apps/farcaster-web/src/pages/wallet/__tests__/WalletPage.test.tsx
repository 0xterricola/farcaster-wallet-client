// @vitest-environment jsdom
/**
 * The wallet page, and the sentence it is no longer allowed to say.
 *
 * The page used to be one line — "Farcaster Wallet is available on Farcaster
 * mobile" — which is true of the fork it was inherited from and false of this
 * client, where the wallet is a real thing you can connect and pay from. The
 * assertions here are therefore:
 *
 *   1. that sentence is gone, at every state this page can be in;
 *   2. what the page says instead is what the wallet is FOR, in plain words;
 *   3. the real surface is mounted (`[data-fiddy="wallet-home"]`);
 *   4. a person can connect a wallet, and the page comes back to the wallet the
 *      moment one connects — but only where the layout actually has a surface to
 *      talk to. Signed out there is none, and the page says that rather than
 *      showing a button that would do nothing;
 *   5. the account's own wallet is named when this device holds one, and while
 *      the accounts are still being read nothing is claimed at all;
 *   6. the Fiddy balance — the other half of what the tab bar's "Wallet" is
 *      about — is mounted, and it is the *balance* (a credit spent inside
 *      Fiddy) rather than a claim about anybody's wallet.
 *
 * WHY THE WALLET IS A REAL CONTEXT AND NOT A STUBBED RETURN. The page reacts to
 * a wallet that connects *while* the connect step is open, and a stubbed hook
 * returning a new object cannot re-render a memoized component — React skips it
 * when props are unchanged. A context is what the provider actually is, so it
 * re-renders the page the way a real connection does.
 *
 * The fork's page shell (meta, badge, helmet) and the chooser are stubbed: what
 * is under test is this page's composition, and the chooser is measured in the
 * browser by scripts/verify-wallet-surface.mjs.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { resetFiddySetup } from '~/lib/fiddySetup';
// A test renders the page component itself: the lazy wrapper in ~/lazy/pages
// exists to keep the production bundle split, and awaiting it here would test
// the wrapper, not the surface.
// eslint-disable-next-line no-restricted-imports
import { WalletPage } from '~/pages/wallet/WalletPage';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

type WalletValue = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  accounts: {} as Record<string, unknown>,
  WalletContext: undefined as unknown as React.Context<WalletValue>,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, connector: undefined }),
  useChainId: () => 8453,
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}));

vi.mock('~/contexts/WalletProvider', async () => {
  const ReactModule = await import('react');
  const WalletContext = ReactModule.createContext<WalletValue>(
    {},
  ) as React.Context<WalletValue>;
  mocks.WalletContext = WalletContext;
  return { useWallet: () => ReactModule.useContext(WalletContext) };
});

vi.mock('~/contexts/SolanaWalletProvider', () => ({
  useSolanaWallet: () => ({ status: 'disconnected' }),
}));

vi.mock('~/snapchain/accounts/session', () => ({
  useLocalAccounts: () => mocks.accounts,
}));

vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The dark-ground pin is the shell's job and is measured in the browser by the
// shell-paint probe; here it only has to stay out of the way (jsdom cannot build
// the StorageEvent it dispatches).
vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

vi.mock('~/components/wallet/PreferredWalletDialog', () => ({
  PreferredWalletSelector: () => <div data-fiddy="chooser" />,
}));

// The Fiddy balance at the top of the page reads Fiddy's own funding service
// through React Query and the client's wallet context. What it renders is
// measured where it lives (`AddFundsSheet.test.tsx`, `fiddyCredit.test.ts`);
// this page's job is to mount it, which is what the stand-in below proves.
vi.mock('~/components/fiddy/FiddyFunding', () => ({
  FiddyBalanceSection: () => <div data-fiddy="balance-home" />,
}));

const CONNECTED = '0x1111111111111111111111111111111111111111';

const account: LocalAccount = {
  id: '0xabc0000000000000000000000000000000000001',
  custodyAddress: '0xAbC0000000000000000000000000000000000001',
  phrase: 'one two three',
  fid: 4242,
  createdAt: 1,
};

/** The wallet context, in the shape this page reads. */
const walletValue = (overrides: WalletValue = {}): WalletValue => ({
  address: undefined,
  available: true,
  network: { actualChainId: undefined },
  preferredWallet: undefined,
  provider: undefined,
  ...overrides,
});

const accountsValue = (overrides: WalletValue = {}): WalletValue => ({
  accounts: [],
  current: undefined,
  loading: false,
  reload: async () => undefined,
  ...overrides,
});

const renderPage = ({
  wallet = walletValue(),
  accounts = accountsValue(),
}: {
  wallet?: WalletValue;
  accounts?: WalletValue;
} = {}) => {
  mocks.accounts = accounts;
  return render(
    <mocks.WalletContext.Provider value={wallet}>
      <WalletPage />
    </mocks.WalletContext.Provider>,
  );
};

beforeEach(() => {
  installFakeStorage();
  mocks.accounts = accountsValue();
});

afterEach(() => {
  cleanup();
  resetFiddySetup();
});

const pageText = () => document.body.textContent ?? '';
const subLine = () =>
  document.querySelector('.fiddy-page-sub')?.textContent ?? '';
const step = () =>
  document
    .querySelector('[data-fiddy="wallet-page"]')
    ?.getAttribute('data-step');

describe('the wallet page', () => {
  it('never says the wallet lives on Farcaster mobile', () => {
    renderPage();
    expect(pageText()).not.toContain('Farcaster mobile');
    expect(pageText()).not.toContain('available on Farcaster');
  });

  it('says what the wallet is for, in plain words', () => {
    renderPage();
    expect(subLine()).toContain('pays for what your agent uses');
    expect(subLine()).toContain('signs every payment you approve');
    expect(subLine()).toContain('never holds it');
  });

  it('mounts the Fiddy balance it is named after', () => {
    renderPage();
    expect(document.querySelector('[data-fiddy="balance-home"]')).toBeTruthy();
  });

  it('mounts the real wallet surface, not a notice about one', () => {
    renderPage();
    expect(document.querySelector('[data-fiddy="wallet-home"]')).toBeTruthy();
    expect(
      document
        .querySelector('[data-fiddy-wallet-summary]')
        ?.getAttribute('data-fiddy-wallet-summary'),
    ).toBe('cannot-pay');
  });

  it('offers connecting a wallet, and opens the full chooser for it', () => {
    renderPage();
    expect(
      document.querySelector('[data-fiddy="wallet-signed-out"]'),
    ).toBeNull();

    const button = document.querySelector(
      '[data-fiddy="wallet-connect"]',
    ) as HTMLElement;
    expect(button.textContent).toBe('Connect a wallet');
    fireEvent.click(button);

    expect(step()).toBe('connect');
    // The chooser that lists every wallet the browser announced, rather than the
    // client's modal, which lists only the wallet used last time.
    expect(document.querySelector('[data-fiddy="chooser"]')).toBeTruthy();
  });

  it('comes back to the wallet as soon as one connects', async () => {
    const Harness = () => {
      const [wallet, setWallet] = useState(walletValue());
      return (
        <>
          <mocks.WalletContext.Provider value={wallet}>
            <WalletPage />
          </mocks.WalletContext.Provider>
          <button
            type="button"
            onClick={() => setWallet(walletValue({ address: CONNECTED }))}
          >
            connect-in-test
          </button>
        </>
      );
    };

    render(<Harness />);
    fireEvent.click(
      document.querySelector('[data-fiddy="wallet-connect"]') as HTMLElement,
    );
    expect(step()).toBe('connect');

    fireEvent.click(
      Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'connect-in-test',
      ) as HTMLElement,
    );
    await waitFor(() => expect(step()).toBe('wallet'));
  });

  it('says so plainly when the layout has no wallet surface to offer', () => {
    renderPage({ wallet: walletValue({ available: false }) });

    expect(document.querySelector('[data-fiddy="wallet-connect"]')).toBeNull();
    expect(
      document.querySelector('[data-fiddy="wallet-signed-out"]')?.textContent,
    ).toContain('Sign in to connect a wallet');
  });

  it('names the account wallet this device holds', () => {
    renderPage({
      accounts: accountsValue({ accounts: [account], current: account }),
    });

    const card = document.querySelector('[data-fiddy="account-wallet"]');
    expect(card?.getAttribute('data-state')).toBe('has-wallet');
    expect(
      document
        .querySelector('[data-fiddy="account-wallet-address"]')
        ?.textContent?.trim(),
    ).toBe('0xAbC0…0001');
    expect(card?.textContent).toContain(
      'does not pay for what your agent uses',
    );
  });

  it('claims nothing while the accounts are still being read', () => {
    renderPage({ accounts: accountsValue({ loading: true }) });
    expect(document.querySelector('[data-fiddy="account-wallet"]')).toBeNull();
  });
});
