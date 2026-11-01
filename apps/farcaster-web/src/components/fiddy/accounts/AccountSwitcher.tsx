/**
 * More than one account, and which one you are.
 *
 * The reason this screen exists is that a person can now make an account here,
 * which means a browser can hold more than one — and the moment that is true,
 * "which account am I?" stops being obvious. So this sheet answers it out loud:
 * the selected row says so, every row shows what this device can do with it, and
 * the switch is announced before it happens rather than discovered afterwards.
 *
 * WHAT SWITCHING DOES, HONESTLY: it re-signs-in the client as that account (the
 * same device-only session a fresh sign-in produces) and reboots the app, so no
 * feed, draft or reaction can leak across accounts. What it does NOT do is move
 * anything between accounts — each account's key material is stored under its
 * own FID and is used for that FID only.
 */

import { KeyRound } from 'lucide-react';
import React, { memo, useCallback, useEffect, useState } from 'react';

import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';
import { useAuth } from '~/contexts/AuthProvider';
import { postSignInLocation } from '~/lib/postSignInLanding';
import {
  describeLocalAccount,
  type LocalAccount,
  removeLocalAccount,
  selectLocalAccount,
} from '~/snapchain/accounts/localAccounts';
import {
  signInAsLocalAccount,
  useLocalAccounts,
} from '~/snapchain/accounts/session';
import { loadAppKey } from '~/snapchain/appKeyStorage';

import { CreateAccountSheet } from './CreateAccountSheet';

export interface AccountSwitcherSheetProps {
  onClose: () => void;
}

export const AccountSwitcherSheet = memo<AccountSwitcherSheetProps>(
  ({ onClose }) => {
    const { accounts, currentId, current, reload } = useLocalAccounts();
    const { signIn } = useAuth();
    const [creating, setCreating] = useState(false);
    const [busyId, setBusyId] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [removing, setRemoving] = useState<string | undefined>();
    /** Which accounts this device actually holds a posting key for. */
    const [withKeys, setWithKeys] = useState<Record<string, boolean>>({});

    useEffect(() => {
      let live = true;

      void (async () => {
        const next: Record<string, boolean> = {};

        for (const account of accounts) {
          next[account.id] = account.fid
            ? (await loadAppKey(account.fid)) !== null
            : false;
        }

        if (live) {
          setWithKeys(next);
        }
      })();

      return () => {
        live = false;
      };
    }, [accounts]);

    const switchTo = useCallback(
      async (account: LocalAccount) => {
        setError(undefined);
        setBusyId(account.id);

        try {
          await selectLocalAccount(account.id);
          await signInAsLocalAccount({ account, signIn });
        } catch (thrown) {
          setBusyId(undefined);
          setError(
            thrown instanceof Error && thrown.message
              ? thrown.message
              : "we couldn't switch accounts - try again",
          );
          return;
        }

        // A clean boot, so nothing from the account we just left is still on
        // screen. Same destination rule as a sign-in.
        window.location.replace(
          postSignInLocation({
            pathname: window.location.pathname,
            href: window.location.href,
          }),
        );
      },
      [signIn],
    );

    const forget = useCallback(
      async (account: LocalAccount) => {
        if (removing !== account.id) {
          setRemoving(account.id);
          return;
        }

        await removeLocalAccount(account.id);
        setRemoving(undefined);
        await reload();
      },
      [removing, reload],
    );

    if (creating) {
      return (
        <CreateAccountSheet
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      );
    }

    return (
      <Modal>
        <DefaultModalContainer onClose={() => onClose()}>
          <div className="flex size-full flex-col items-center justify-center p-4">
            <div
              className="relative flex w-full max-w-md flex-col items-start justify-center rounded-[12px] p-4"
              data-fiddy="account-switcher"
              onClick={(event) => event.stopPropagation()}
            >
              <FiddySheet
                name="accounts"
                egg="none"
                title="Your accounts"
                sub={
                  current
                    ? `Signing in as ${describeLocalAccount(current)}.`
                    : 'This browser is not holding an account of its own yet.'
                }
                primary={{
                  label: 'Make another account',
                  onClick: () => setCreating(true),
                }}
                quiet={{ label: 'Close', onClick: onClose }}
                note="The words that own an account stay on this device. Fiddy keeps no copy of them."
              >
                {accounts.length === 0 ? (
                  <p className="fiddy-sheet-note" data-fiddy="accounts-empty">
                    An account you make here is held on this device. Make one
                    and it shows up in this list.
                  </p>
                ) : (
                  <ul className="fiddy-accounts" data-fiddy="account-list">
                    {accounts.map((account) => (
                      <li
                        key={account.id}
                        className={account.id === currentId ? 'current' : ''}
                        data-fiddy-account={account.id}
                      >
                        <span className="fiddy-account-name">
                          {describeLocalAccount(account)}
                        </span>
                        <span className="fiddy-account-note">
                          {withKeys[account.id] ? (
                            <>
                              <KeyRound aria-hidden="true" size={12} /> this
                              device can post
                            </>
                          ) : (
                            'no posting key on this device yet'
                          )}
                        </span>
                        {account.id === currentId ? (
                          <b data-fiddy="account-current">
                            signing in as this one
                          </b>
                        ) : (
                          <button
                            type="button"
                            className="fiddy-quiet-btn"
                            disabled={busyId === account.id}
                            onClick={() => void switchTo(account)}
                          >
                            {busyId === account.id
                              ? 'Switching…'
                              : `Sign in as ${describeLocalAccount(account)}`}
                          </button>
                        )}
                        {account.id === currentId ? null : (
                          <button
                            type="button"
                            className="fiddy-quiet-btn"
                            onClick={() => void forget(account)}
                          >
                            {removing === account.id
                              ? 'Really forget it? The words you saved are the only copy'
                              : 'Forget on this device'}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {error ? <p className="fiddy-error">{error}</p> : null}
              </FiddySheet>
            </div>
          </div>
        </DefaultModalContainer>
      </Modal>
    );
  },
);

AccountSwitcherSheet.displayName = 'AccountSwitcherSheet';

/** A one-line entry point, so the shell's chrome can mount this without owning
 *  any of its state. */
export const AccountSwitcherEntry = memo<{ className?: string }>(
  ({ className }) => {
    const [open, setOpen] = useState(false);
    const { current } = useLocalAccounts();

    return (
      <>
        <button
          type="button"
          className={className}
          data-fiddy="account-switcher-entry"
          onClick={() => setOpen(true)}
        >
          {current ? describeLocalAccount(current) : 'Your accounts'}
        </button>
        {open ? <AccountSwitcherSheet onClose={() => setOpen(false)} /> : null}
      </>
    );
  },
);

AccountSwitcherEntry.displayName = 'AccountSwitcherEntry';
