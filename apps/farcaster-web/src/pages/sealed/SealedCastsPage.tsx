/**
 * "Sealed casts" — the surface for a cast only the people it names can read.
 *
 * One screen, in the order a person actually does it: their key (made here), who
 * the cast is for (one person, and the screen says why), the message (with the
 * room left shown in bytes, because that is what a cast is measured in), and then
 * the sealed text — previewed the way a reader will see it in a feed, posted
 * through the client's ordinary signed path, or copied out.
 *
 * Every sentence here is load-bearing and honest: the key lives in this browser
 * and cannot be recovered; anyone can see that a sealed cast exists; other apps
 * will show the sealed bytes as a line they cannot read. `docs/MASK-FEATURES.md`
 * has the measured numbers behind "one person".
 */
import '~/styles/fiddy-sealed.css';

import { useCreateCast } from 'farcaster-client-hooks';
import { ChevronLeft, Copy, KeyRound, Lock } from 'lucide-react';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';
import { SealedCastView } from '~/components/sealed/SealedCastView';
import {
  loadSealedCasts,
  loadSealedEnvelope,
  loadSealedKeys,
} from '~/components/sealed/sealedModules';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import type { SavedKey, SealedIdentity } from '~/lib/sealed/keys';
import type { SealedCast } from '~/lib/sealed/sealedCast';

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

const shortFingerprint = (hex: string): string =>
  `${hex.slice(0, 4)}…${hex.slice(-4)}`;

/** The post button: only rendered when signed in, because it needs an account. */
const PostSealedCast: FC<{
  sealed: SealedCast;
  onProblem: (problem: string) => void;
}> = ({ sealed, onProblem }) => {
  const currentUser = useCurrentUser();
  const createCast = useCreateCast();
  const [state, setState] = useState<'idle' | 'posting' | 'posted'>('idle');

  const post = useCallback(async () => {
    setState('posting');

    try {
      await createCast({ fid: currentUser.fid, castText: sealed.text });
      setState('posted');
    } catch (error) {
      setState('idle');
      onProblem(
        `the post did not go through: ${
          error instanceof Error ? error.message : 'no answer from the server'
        }`,
      );
    }
  }, [createCast, currentUser.fid, onProblem, sealed.text]);

  return (
    <button
      type="button"
      className="fiddy-sealed__button fiddy-sealed__button--loud"
      data-sealed="post"
      disabled={state !== 'idle'}
      onClick={() => {
        void post();
      }}
    >
      {state === 'posting'
        ? 'Posting…'
        : state === 'posted'
          ? 'Posted'
          : 'Post it'}
    </button>
  );
};

const SealedCastsSurface: FC = () => {
  const isSignedIn = useIsSignedIn();

  const [cryptoHere, setCryptoHere] = useState<boolean | null>(null);
  const [identity, setIdentity] = useState<SealedIdentity | null>(null);
  const [saved, setSaved] = useState<SavedKey[]>([]);
  const [room, setRoom] = useState<number | null>(null);
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState('');
  const [sealed, setSealed] = useState<SealedCast | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<'key' | 'sealed' | null>(null);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const keys = await loadSealedKeys();

        if (!keys.sealedCryptoAvailable()) {
          setCryptoHere(false);

          return;
        }

        setCryptoHere(true);
        setSaved(keys.listSavedKeys());

        const identityNow = await keys.loadIdentity();
        const envelope = await loadSealedEnvelope();

        if (live) {
          setIdentity(identityNow);
          setRoom(envelope.plaintextBudgetBytes(1));
        }
      } catch {
        if (live) {
          setCryptoHere(false);
        }
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  const used = byteLength(message);
  const left = room === null ? null : room - used;

  const makeKey = useCallback(async () => {
    try {
      const keys = await loadSealedKeys();

      setIdentity(await keys.getOrCreateKey());
      setProblem(null);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'a key could not be made here',
      );
    }
  }, []);

  const forgetKey = useCallback(async () => {
    const keys = await loadSealedKeys();

    keys.forgetIdentity();
    setIdentity(null);
    setSealed(null);
  }, []);

  const seal = useCallback(async () => {
    setSealed(null);
    setProblem(null);

    try {
      const casts = await loadSealedCasts();

      setSealed(
        await casts.sealCast({
          plaintext: message,
          recipientShares: [recipient.trim()],
        }),
      );
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'this cast could not be sealed',
      );
    }
  }, [message, recipient]);

  const copy = useCallback(async (what: 'key' | 'sealed', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }, []);

  const keySection = useMemo(() => {
    if (cryptoHere === false) {
      return (
        <p className="fiddy-sealed__line" data-sealed="no-crypto">
          This browser cannot make a key that only you hold. Sealed casts need
          one, and a page served over plain http does not have it.
        </p>
      );
    }

    if (identity === null) {
      return (
        <>
          <p className="fiddy-sealed__line">
            A key is made on this device, stays on this device, and is what
            makes a sealed cast openable by you and nobody else.
          </p>
          <div className="fiddy-sealed__row">
            <button
              type="button"
              className="fiddy-sealed__button fiddy-sealed__button--loud"
              data-sealed="make-key"
              onClick={() => {
                void makeKey();
              }}
            >
              Make my key
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <p className="fiddy-sealed__line">
          This is your key’s public half. Post it, paste it, hand it out —
          anyone with it can write you something only you can read. The private
          half stays here.
        </p>
        <code className="fiddy-sealed__key" data-sealed="share">
          {identity.share}
        </code>
        <div className="fiddy-sealed__row">
          <button
            type="button"
            className="fiddy-sealed__button"
            data-sealed="copy-key"
            onClick={() => {
              void copy('key', identity.share);
            }}
          >
            <Copy aria-hidden="true" />{' '}
            {copied === 'key' ? 'Copied' : 'Copy it'}
          </button>
          <span className="fiddy-sealed__line">
            Fingerprint {shortFingerprint(identity.fingerprintHex)}
          </span>
          <button
            type="button"
            className="fiddy-sealed__button"
            data-sealed="forget-key"
            onClick={() => {
              void forgetKey();
            }}
          >
            Forget this key
          </button>
        </div>
        <p className="fiddy-sealed__line">
          The key that opens sealed casts lives in this browser only. Clearing
          this browser’s data loses it, and casts sealed to it stop opening
          here.
        </p>
      </>
    );
  }, [copied, copy, cryptoHere, forgetKey, identity, makeKey]);

  return (
    <>
      <section className="fiddy-sealed__block" data-sealed="your-key">
        <span className="fiddy-sealed__label">Your key</span>
        {keySection}
      </section>

      <section className="fiddy-sealed__block" data-sealed="who">
        <span className="fiddy-sealed__label">Who it is for</span>
        <p className="fiddy-sealed__line">
          One person per sealed cast. At an ordinary post’s size there is only
          room for one — paste their key here.
        </p>
        <input
          className="fiddy-sealed__field"
          data-sealed="recipient"
          placeholder="fdy-key-1:…"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
        />
        {saved.length > 0 ? (
          <ul className="fiddy-sealed__saved">
            {saved.map((entry) => (
              <li key={entry.fingerprintHex}>
                <button
                  type="button"
                  className="fiddy-sealed__button"
                  onClick={() => setRecipient(entry.share)}
                >
                  <KeyRound aria-hidden="true" /> {entry.label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fiddy-sealed__line">
            Keys you keep from a cast show up here, so you do not have to paste
            them twice.
          </p>
        )}
      </section>

      <section className="fiddy-sealed__block" data-sealed="message-block">
        <span className="fiddy-sealed__label">Your message</span>
        <textarea
          className="fiddy-sealed__field"
          data-sealed="message"
          rows={3}
          placeholder="What only they should read…"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <p className="fiddy-sealed__counter" data-sealed="room">
          {left === null
            ? 'Checking how much room a sealed cast has…'
            : left >= 0
              ? `${left} bytes of room left (a sealed cast fits an ordinary post)`
              : `${-left} bytes too long — sealed casts cannot be trimmed for you`}
        </p>
        <div className="fiddy-sealed__row">
          <button
            type="button"
            className="fiddy-sealed__button fiddy-sealed__button--loud"
            data-sealed="seal"
            disabled={identity === null}
            onClick={() => {
              void seal();
            }}
          >
            Seal this cast
          </button>
          {identity === null ? (
            <span className="fiddy-sealed__line">
              Make your key first — sealing needs one.
            </span>
          ) : null}
        </div>
      </section>

      {problem !== null ? (
        <p className="fiddy-sealed__problem" data-sealed="problem">
          {problem}
        </p>
      ) : null}

      {sealed !== null ? (
        <section className="fiddy-sealed__block" data-sealed="result">
          <span className="fiddy-sealed__label">Ready to post</span>
          <p className="fiddy-sealed__line">
            {sealed.textBytes} of 320 bytes used. This is how it will look in
            the feed:
          </p>
          <SealedCastView body={sealed.text} openPlaintext={message} />
          <div className="fiddy-sealed__row">
            {isSignedIn ? (
              <PostSealedCast sealed={sealed} onProblem={setProblem} />
            ) : (
              <span className="fiddy-sealed__line">
                Sign in to post it — the sealed text is ready either way.
              </span>
            )}
            <button
              type="button"
              className="fiddy-sealed__button"
              data-sealed="copy-sealed"
              onClick={() => {
                void copy('sealed', sealed.text);
              }}
            >
              <Copy aria-hidden="true" />{' '}
              {copied === 'sealed' ? 'Copied' : 'Copy the sealed text'}
            </button>
          </div>
          <p className="fiddy-sealed__line">
            Anyone can see that a sealed cast exists, and that it is sealed.
            Nobody without the key can read it — and in an app that has never
            heard of sealed casts it will look like a line of nonsense, because
            that is what the bytes are.
          </p>
        </section>
      ) : null}
    </>
  );
};

export const SealedCastsPage = () => {
  useFiddyBrandGround();

  return (
    <Page meta={{ title: 'Sealed casts' }} className="fiddy-surface fiddy-page">
      <div className="fiddy-page-inner" data-sealed="page">
        <Link
          to="agent"
          params={{}}
          searchParams={{}}
          title="Your agent"
          className="fiddy-back"
        >
          <ChevronLeft aria-hidden="true" />
          Your agent
        </Link>

        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">
            <Lock aria-hidden="true" /> Sealed casts
          </h1>
          <p className="fiddy-page-sub">
            Write something only the person you name can read. The lock is made
            here, on your device, and the key that opens it never leaves theirs.
          </p>
        </header>

        <SealedCastsSurface />
      </div>
    </Page>
  );
};
