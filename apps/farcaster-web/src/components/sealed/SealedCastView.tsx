/**
 * A sealed cast, as it looks in a feed.
 *
 * The card reads *nothing* it cannot read without a key: it counts the
 * recipients from the envelope (a pure parse) and checks whether this browser
 * holds a key that was addressed — that is what tells a reader "you can open
 * this one" versus "this is for someone else". The message itself is only
 * touched when the reader presses Open, which is the moment the crypto module is
 * `import()`ed.
 *
 * Nothing here ever renders a name for a recipient. The envelope carries
 * fingerprints, not handles, so the card promises exactly what the bytes
 * promise: *someone specific can open this*, and it tells you whether this
 * browser is one of them.
 */
import '~/styles/fiddy-sealed.css';

import { Lock, LockOpen } from 'lucide-react';
import React, { FC, useEffect, useState } from 'react';

import { Link } from '~/components/links/Link';
import {
  loadSealedCasts,
  loadSealedEnvelope,
  loadSealedKeys,
} from '~/components/sealed/sealedModules';

export interface SealedCastViewProps {
  /** The cast body, exactly as it was posted. */
  body: string;
  /**
   * The message, when the caller already has it — the surface that just sealed
   * this shows the sender their own preview rather than making them open their
   * own cast.
   */
  openPlaintext?: string;
}

type ViewState =
  | { status: 'reading' }
  | {
      status: 'sealed';
      recipients: number;
      canOpen: boolean;
      holdsKey: boolean;
    }
  | { status: 'unreadable'; reason: string }
  | { status: 'open'; plaintext: string }
  | { status: 'failed'; reason: string };

const personCount = (recipients: number): string =>
  recipients === 1 ? 'one person' : `${recipients} people`;

const SealedCastView: FC<SealedCastViewProps> = ({ body, openPlaintext }) => {
  const [state, setState] = useState<ViewState>(
    openPlaintext !== undefined
      ? { status: 'open', plaintext: openPlaintext }
      : { status: 'reading' },
  );

  useEffect(() => {
    if (openPlaintext !== undefined) {
      return undefined;
    }

    let live = true;

    void (async () => {
      try {
        const { decodeEnvelope } = await loadSealedEnvelope();
        const envelope = decodeEnvelope(body);

        if (!live) {
          return;
        }

        let holdsKey = false;
        let canOpen = false;

        try {
          const keys = await loadSealedKeys();
          const identity = await keys.loadIdentity();

          if (identity !== null) {
            holdsKey = true;
            canOpen = envelope.recipients.some((recipient) =>
              keys.sameFingerprint(recipient.fingerprint, identity.fingerprint),
            );
          }
        } catch {
          /* A browser with no WebCrypto simply cannot open anything. */
        }

        if (!live) {
          return;
        }

        setState({
          status: 'sealed',
          recipients: envelope.recipients.length,
          canOpen,
          holdsKey,
        });
      } catch (error) {
        if (live) {
          setState({
            status: 'unreadable',
            reason:
              error instanceof Error
                ? error.message
                : 'this sealed cast could not be read',
          });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [body, openPlaintext]);

  const open = async () => {
    try {
      const keys = await loadSealedKeys();
      const identity = await keys.loadIdentity();

      if (identity === null) {
        setState({
          status: 'failed',
          reason:
            'this browser has no key yet, and this cast was sealed for a key it does not hold',
        });

        return;
      }

      const casts = await loadSealedCasts();
      const result = await casts.openSealedCast({ text: body, identity });

      if (result.status === 'opened') {
        setState({ status: 'open', plaintext: result.plaintext });

        return;
      }

      setState({ status: 'failed', reason: result.reason });
    } catch (error) {
      setState({
        status: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'this sealed cast could not be opened',
      });
    }
  };

  if (state.status === 'reading') {
    return (
      <span className="fiddy-sealed" data-sealed="reading">
        <span className="fiddy-sealed__head">
          <Lock aria-hidden="true" /> Sealed cast
        </span>
        <span className="fiddy-sealed__line">Reading who it is for…</span>
      </span>
    );
  }

  if (state.status === 'unreadable' || state.status === 'failed') {
    return (
      <span className="fiddy-sealed" data-sealed="failed">
        <span className="fiddy-sealed__head">
          <Lock aria-hidden="true" /> Sealed cast
        </span>
        <span className="fiddy-sealed__line">{state.reason}</span>
        <span className="fiddy-sealed__actions">
          <Link
            to="sealed"
            params={{}}
            searchParams={{}}
            title="Sealed casts"
            className="fiddy-sealed__button"
          >
            Your own key
          </Link>
        </span>
      </span>
    );
  }

  if (state.status === 'open') {
    return (
      <span className="fiddy-sealed" data-sealed="open">
        <span className="fiddy-sealed__head">
          <LockOpen aria-hidden="true" /> Sealed cast — opened here
        </span>
        <span className="fiddy-sealed__body" data-sealed="plaintext">
          {state.plaintext}
        </span>
        <span className="fiddy-sealed__line">
          It was sealed on the sender’s device and opened on this one. Nobody in
          between — not this app, not any server — held a key that could read
          it.
        </span>
      </span>
    );
  }

  return (
    <span className="fiddy-sealed" data-sealed="sealed">
      <span className="fiddy-sealed__head">
        <Lock aria-hidden="true" /> Sealed cast
      </span>
      <span className="fiddy-sealed__line">
        Sealed for {personCount(state.recipients)}.{' '}
        {state.canOpen
          ? 'This browser holds the key that opens it.'
          : 'The key that opens it is not in this browser.'}
      </span>
      <span className="fiddy-sealed__actions">
        <button
          type="button"
          className={
            state.canOpen
              ? 'fiddy-sealed__button fiddy-sealed__button--loud'
              : 'fiddy-sealed__button'
          }
          data-sealed="open-button"
          onClick={() => {
            void open();
          }}
          disabled={!state.canOpen}
        >
          {state.canOpen ? 'Open it' : 'Not for this browser'}
        </button>
        {!state.holdsKey ? (
          <Link
            to="sealed"
            params={{}}
            searchParams={{}}
            title="Sealed casts"
            className="fiddy-sealed__button"
          >
            Make a key
          </Link>
        ) : null}
      </span>
    </span>
  );
};

export { SealedCastView };
