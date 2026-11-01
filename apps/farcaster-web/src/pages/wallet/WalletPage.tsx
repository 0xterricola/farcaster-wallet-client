/**
 * The wallet, as a place you can come back to.
 *
 * TWO THINGS LIVE ON THIS PAGE, AND THEY ARE NOT THE SAME THING. The Fiddy
 * *balance* at the top is a platform credit: USDC top-ups that Fiddy verified on
 * Base, spent inside Fiddy, held by nobody. The *wallet* underneath is the
 * person's own wallet, which pays for what their agent uses and which Fiddy
 * never holds. The page used to carry only the second, which made the tab bar's
 * "Wallet" answer half a question; adding funds — the screen the balance links
 * to — is the other half.
 *
 * This page used to say "Farcaster Wallet is available on Farcaster mobile" and
 * nothing else — true of the fork it came from, and false of this client, which
 * has a wallet surface of its own. So the page is now that surface: which wallet
 * pays (the client's own wallet home, the same one a payment for a brain is
 * asked through), the account's own wallet underneath, and one step to connect a
 * wallet you already hold.
 *
 * WHY CONNECTING IS A STEP AND NOT A DIALOG. The client's modal chooser shows
 * the wallet you picked last time plus a WalletConnect code — for someone with
 * MetaMask in the browser that is the wrong list, and it is the fork's modal
 * behaviour, not something to copy here. The full chooser already exists in this
 * repo (`PreferredWalletSelector`, which the settings page renders inline), and
 * it lists every wallet the browser actually announced. So this page shows that
 * same component, in Fiddy's own sheet frame, and comes back to the wallet as
 * soon as one is connected.
 *
 * WHO CAN CONNECT, AND WHY THE PAGE SAYS SO. A connect step needs a wallet
 * surface to talk to, which the layout that mounts this page provides. In a
 * signed-out layout there is none, so the page says that plainly rather than
 * showing a button that would do nothing.
 *
 * WHAT THE WALLET IS FOR, IN PLAIN WORDS. It pays for what the agent uses —
 * the brain it thinks with, one request at a time — and it signs each payment
 * you approve, so nothing leaves it without your say-so. No wallet of yours is
 * held by Fiddy, here or anywhere else.
 */

import React, { memo, useEffect, useState } from 'react';

import { FiddyAccountWallet } from '~/components/fiddy/FiddyAccountWallet';
import { FiddyBalanceSection } from '~/components/fiddy/FiddyFunding';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { FiddyWalletHomeConnected } from '~/components/fiddy/FiddyWalletHome';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Page } from '~/components/page/Page';
import { PreferredWalletSelector } from '~/components/wallet/PreferredWalletDialog';
import { useWallet } from '~/contexts/WalletProvider';

const WalletPage = memo(() => {
  useFiddyBrandGround();
  const { address, available } = useWallet();
  const [step, setStep] = useState<'wallet' | 'connect'>('wallet');

  // A connected wallet is what the connect step was for, so the step is over the
  // moment there is one — and the wallet underneath shows who pays now.
  useEffect(() => {
    if (step === 'connect' && address) {
      setStep('wallet');
    }
  }, [step, address]);

  if (step === 'connect') {
    return (
      <Page
        meta={{ title: 'Connect a wallet' }}
        className="fiddy-surface fiddy-page"
      >
        <div
          className="fiddy-page-inner"
          data-fiddy="wallet-page"
          data-step="connect"
        >
          <FiddySheet
            title="Connect a wallet"
            sub="Pick the wallet that pays for what your agent uses. Fiddy learns the address and asks you before anything is paid — it never holds the wallet itself."
            quiet={{
              label: 'Back to wallet',
              onClick: () => setStep('wallet'),
            }}
            name="wallet-connect"
            wide
          >
            <PreferredWalletSelector defaultFamily="evm" hideHeader />
          </FiddySheet>
        </div>
      </Page>
    );
  }

  return (
    <Page meta={{ title: 'Wallet' }} className="fiddy-surface fiddy-page">
      <div
        className="fiddy-page-inner"
        data-fiddy="wallet-page"
        data-step="wallet"
      >
        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">Wallet</h1>
          <p className="fiddy-page-sub">
            Your Fiddy balance is a credit you spend inside Fiddy, topped up
            with USDC on Base. Below it, the wallet that pays for what your
            agent uses signs every payment you approve — nothing leaves it
            without your say-so, and Fiddy never holds it.
          </p>
        </header>

        {/* What this account's Fiddy balance is, and the one press that adds to
            it. The number comes from Fiddy's own service on this origin and is
            never invented here; the section carries its own read, so this page
            does not have to know how a balance is fetched. */}
        <FiddyBalanceSection />

        {!available ? (
          <p className="fiddy-honest-note" data-fiddy="wallet-signed-out">
            <span>
              Sign in to connect a wallet you already hold. Until then nothing
              here can pay for anything, and nothing on this page can move
              money.
            </span>
          </p>
        ) : null}

        <FiddyWalletHomeConnected onConnect={() => setStep('connect')} />
        <FiddyAccountWallet />
      </div>
    </Page>
  );
});

WalletPage.displayName = 'WalletPage';

export { WalletPage };
