/**
 * "Let Fiddy post for you" — the primary way to give Fiddy a posting key.
 *
 * WHAT THIS REPLACED, AND WHY
 *
 * MEASURED (2026-10-21, the live client): the app-key card's one button was
 * "Issue app key", and pressing it opened a blocking security warning that asks
 * the person to type their account's twelve-word recovery phrase into a web
 * page. That is a reasonable screen for a test account and a *developer* — the
 * card calls it Advanced, and it says so — but it was the first thing a normal
 * reader met when they wanted Fiddy to post for them.
 *
 * So the phone approval is the primary flow now (`ConnectSheet`, the same screen
 * `/connect-farcaster` shows: one tap in their own Farcaster app, no fee, no
 * passphrase, revocable), and the recovery-phrase path is demoted behind a
 * collapsed disclosure on the Advanced screen (`SettingsNodePage`) where a
 * developer can still find it.
 *
 * WHAT IT SAYS, AND WHAT IT WILL NOT SAY
 *
 * The state shown here is the service's own answer and nothing else: an answer
 * this card does not recognise reads as "not connected", never as success. A
 * service that cannot be reached says so in one sentence, and the reader is
 * still able to read Farcaster and post in their own app. No protocol words
 * ("signer", "scope", "TTL", "gasless") appear on this card.
 */

import React, { memo, useCallback, useEffect, useState } from 'react';

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';
import {
  type ConnectStatus,
  connectStatus,
  rememberConnectStatus,
  stopConnect,
} from '~/snapchain/accounts/managedConnect';

interface PostingKeyCardProps {
  /** The signed-in account, when there is one. */
  fid?: number;
  /**
   * Opens this device's own app-key control (the disclosure below this card on
   * the same screen). The card asks for it only when the one-tap approval has no
   * service to talk to at this address — on a copy of Fiddy somebody runs
   * themselves that is the ONLY way to post, so a card that said "post in your
   * Farcaster app instead" would be leaving out the one that works.
   */
  onUseOwnAppKey?: () => void;
  /**
   * Told when the service cannot be reached at this address, so the screen can
   * show the control that does work without the person having to find it.
   */
  onServiceUnreachable?: () => void;
}

type Load =
  | { name: 'loading' }
  | { name: 'known'; status: ConnectStatus }
  | { name: 'unreachable'; message: string };

const PostingKeyCard = memo<PostingKeyCardProps>(
  ({ fid, onUseOwnAppKey, onServiceUnreachable }) => {
    const [load, setLoad] = useState<Load>({ name: 'loading' });
    const [sheetOpen, setSheetOpen] = useState(false);
    const [working, setWorking] = useState(false);

    const refresh = useCallback(async () => {
      try {
        const status = await connectStatus();
        rememberConnectStatus(status);
        setLoad({ name: 'known', status });
      } catch (error) {
        setLoad({ name: 'unreachable', message: (error as Error).message });
        onServiceUnreachable?.();
      }
    }, [onServiceUnreachable]);

    useEffect(() => {
      void refresh();
    }, [refresh, fid]);

    const turnOff = useCallback(async () => {
      setWorking(true);
      try {
        const status = await stopConnect();
        rememberConnectStatus(status);
        setLoad({ name: 'known', status });
      } catch (error) {
        setLoad({ name: 'unreachable', message: (error as Error).message });
      } finally {
        setWorking(false);
      }
    }, []);

    const closeSheet = useCallback(() => {
      setSheetOpen(false);
      void refresh();
    }, [refresh]);

    const status = load.name === 'known' ? load.status : null;
    const connected = status?.state === 'connected';
    const waiting = status?.state === 'waiting';
    const handle = status?.username ? `@${status.username}` : null;

    return (
      <div
        className="solid-glass-pane rounded-lg border p-4 border-default"
        data-fiddy="posting-key-card"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">
            Let Fiddy post for you
          </span>
          <span className="text-xs text-muted">no fee, no passphrase</span>
        </div>

        <div className="flex flex-col gap-3 text-sm">
          <div className="text-xs text-muted">
            Approving takes one tap in your own Farcaster app, on your phone.
            Fiddy then posts, replies, likes and follows as you — and you can
            take that back here at any time. Your account, its key and its
            recovery phrase stay where they are.
          </div>

          {load.name === 'loading' && (
            <div className="text-xs text-muted" data-fiddy="posting-key-state">
              Checking whether Fiddy can post for you…
            </div>
          )}

          {load.name === 'unreachable' && (
            <div
              className="rounded border p-2 text-xs bg-tertiary border-default text-danger"
              data-fiddy="posting-key-state"
            >
              {load.message} You can keep reading Farcaster here, and post in
              your Farcaster app as usual.
              {onUseOwnAppKey === undefined ? null : (
                <>
                  {' '}
                  This copy of Fiddy can still post for you with this
                  device&rsquo;s own app key:
                  <button
                    type="button"
                    onClick={onUseOwnAppKey}
                    data-fiddy="posting-key-use-own-app-key"
                    className="mt-2 block w-max rounded border px-3 py-1.5 font-medium text-primary border-default hover:bg-secondary"
                  >
                    Show the app key setup
                  </button>
                </>
              )}
            </div>
          )}

          {status !== null && (
            <div
              className="text-xs"
              data-fiddy="posting-key-state"
              data-posting-key={status.state}
            >
              {connected ? (
                <span className="text-action-primary">
                  {handle === null
                    ? 'Connected — Fiddy can post for you.'
                    : `Connected as ${handle} — Fiddy can post for you.`}
                </span>
              ) : waiting ? (
                'A request is waiting for you in your Farcaster app.'
              ) : status.state === 'revoked' ? (
                'Fiddy’s access is off. Turn it back on whenever you like.'
              ) : (
                'Not connected yet. Until it is, posting has to happen in your own Farcaster app.'
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {!connected && (
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                disabled={fid === undefined}
                data-fiddy="posting-key-approve"
                className="w-max rounded px-4 py-2 font-medium text-[#1a1c10] bg-action-primary hover:opacity-90 disabled:opacity-50"
              >
                {fid === undefined
                  ? 'Sign in first'
                  : waiting
                    ? 'Show the approval link again'
                    : 'Approve on my phone'}
              </button>
            )}

            {connected && (
              <button
                type="button"
                onClick={() => void turnOff()}
                disabled={working}
                data-fiddy="posting-key-off"
                className="w-max rounded border px-4 py-2 border-default text-danger hover:bg-tertiary disabled:opacity-50"
              >
                {working ? 'Turning it off…' : 'Turn it off'}
              </button>
            )}
          </div>
        </div>

        {/* The approval itself: the same sheet `/connect-farcaster` renders,
          opened asking — the person came here to do exactly this. */}
        {sheetOpen && (
          <div
            className="fixed inset-0 z-50 overflow-y-auto bg-app"
            data-fiddy="posting-key-sheet"
          >
            <ConnectSheet autoStart onClose={closeSheet} />
          </div>
        )}
      </div>
    );
  },
);

PostingKeyCard.displayName = 'PostingKeyCard';

export { PostingKeyCard };
