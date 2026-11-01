/**
 * A key someone shared in a cast, offered back to the reader.
 *
 * Keys travel in public posts (there is no key server, and we are not adding
 * one: a public key is public). This is what makes one usable — the reader sees
 * "somebody shared a key here, keep it if you want to seal things to them", and
 * one press stores it.
 *
 * If the string is *shaped* like a key but is not one (a mistyped or truncated
 * copy), this renders the text unchanged. A renderer that swallowed a few
 * hundred characters of someone's cast would be a bug, so the fallback is
 * always the text itself.
 */
import '~/styles/fiddy-sealed.css';

import { KeyRound } from 'lucide-react';
import React, { FC, useEffect, useState } from 'react';

import { loadSealedKeys } from '~/components/sealed/sealedModules';

export interface SealedKeyNoticeProps {
  /** The candidate string, exactly as it appeared in the cast. */
  token: string;
  /** Who shared it, when the cast said. */
  authorHandle?: string;
}

type NoticeState =
  | { status: 'checking' }
  | { status: 'not-a-key' }
  | { status: 'a-key'; fingerprintHex: string; alreadySaved: boolean }
  | { status: 'saved'; fingerprintHex: string };

const SealedKeyNotice: FC<SealedKeyNoticeProps> = ({ token, authorHandle }) => {
  const [state, setState] = useState<NoticeState>({ status: 'checking' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const keys = await loadSealedKeys();
        const described = await keys.describeKeyShare(token);

        if (described === null) {
          if (live) {
            setState({ status: 'not-a-key' });
          }

          return;
        }

        if (live) {
          setState({
            status: 'a-key',
            fingerprintHex: described.fingerprintHex,
            alreadySaved: keys
              .listSavedKeys()
              .some(
                (saved) => saved.fingerprintHex === described.fingerprintHex,
              ),
          });
        }
      } catch {
        if (live) {
          setState({ status: 'not-a-key' });
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [token]);

  const save = async () => {
    try {
      const keys = await loadSealedKeys();
      const saved = await keys.saveKey(token, undefined, {
        label: authorHandle,
      });

      setState({ status: 'saved', fingerprintHex: saved.fingerprintHex });
    } catch {
      setState({ status: 'not-a-key' });
    }
  };

  if (state.status === 'not-a-key') {
    return <span>{token}</span>;
  }

  if (state.status === 'checking') {
    return (
      <span className="fiddy-sealed" data-sealed="key-checking">
        <span className="fiddy-sealed__head">
          <KeyRound aria-hidden="true" /> A key was shared here
        </span>
      </span>
    );
  }

  const saved = state.status === 'saved';
  const already = state.status === 'a-key' && state.alreadySaved;

  return (
    <span className="fiddy-sealed" data-sealed="key-shared">
      <span className="fiddy-sealed__head">
        <KeyRound aria-hidden="true" />{' '}
        {authorHandle === undefined
          ? 'A key was shared here'
          : `${authorHandle} shared a key here`}
      </span>
      <span className="fiddy-sealed__line">
        Keep it and you can seal a cast that only they can open. It is a public
        key: sharing it gives away nothing but the ability to write to them.
      </span>
      <span className="fiddy-sealed__actions">
        <button
          type="button"
          className="fiddy-sealed__button"
          data-sealed="save-key-button"
          disabled={saved || already}
          onClick={() => {
            void save();
          }}
        >
          {saved
            ? 'Kept in this browser'
            : already
              ? 'Already kept'
              : 'Keep this key'}
        </button>
      </span>
    </span>
  );
};

export { SealedKeyNotice };
