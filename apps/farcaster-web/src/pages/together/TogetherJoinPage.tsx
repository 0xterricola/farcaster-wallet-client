/**
 * The other end of an invite link: `/~together/join/<token>`.
 *
 * Someone sent a link. This page says whose space it is and what is in it, then
 * gets out of the way: sign in with Farcaster, and you are on the board. There
 * is no account to create — the whole point of the product is that the identity
 * you already have is the membership.
 *
 * A dead or spent link is a normal thing to meet here, so it reads as a plain
 * sentence rather than an error page.
 */

import { ArrowRight, Users } from 'lucide-react';
import React from 'react';

import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';
import { useParams } from '~/hooks/navigation/useParams';
import { LoginQRCode } from '~/lazy/components';
import {
  joinInvite,
  pollTogetherSignIn,
  previewInvite,
  readTogetherSession,
  startTogetherSignIn,
  storeTogetherSession,
  TOGETHER_POLL_INTERVAL_MS,
  TogetherError,
  TogetherInvitePreview,
  TogetherSignInChallenge,
} from '~/lib/together';

export const TogetherJoinPage = () => {
  useFiddyBrandGround();

  const { token } = useParams('togetherJoin');
  const [preview, setPreview] = React.useState<TogetherInvitePreview | null>(
    null,
  );
  const [missing, setMissing] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [challenge, setChallenge] =
    React.useState<TogetherSignInChallenge | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [joined, setJoined] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      if (!token) {
        setMissing(true);
        setReady(true);
        return;
      }

      try {
        const found = await previewInvite(token);

        setPreview(found);
        setMissing(found === null);
      } catch (problem) {
        setError(
          problem instanceof TogetherError
            ? problem.message
            : 'That link could not be read.',
        );
      }

      setReady(true);
    })();
  }, [token]);

  const join = React.useCallback(
    async (sessionToken: string) => {
      if (!token) {
        return;
      }

      try {
        setBusy(true);
        const result = await joinInvite(token, sessionToken);

        await storeTogetherSession({
          token: result.session_token,
          fid: 0,
          username: null,
          pfp_url: null,
          space_id: result.space.id,
        });
        setJoined(result.already_member ? 'already' : 'joined');
      } catch (problem) {
        setError(
          problem instanceof TogetherError
            ? problem.message
            : 'We could not add you to that space.',
        );
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  const signInAndJoin = React.useCallback(async () => {
    setError(null);

    try {
      // An existing Together session can join straight away — no second QR.
      const stored = await readTogetherSession();

      if (stored) {
        await join(stored.token);
        return;
      }

      setChallenge(await startTogetherSignIn());
    } catch (problem) {
      setError(
        problem instanceof TogetherError
          ? problem.message
          : 'We could not start the sign-in.',
      );
    }
  }, [join]);

  React.useEffect(() => {
    if (!challenge) {
      return undefined;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await pollTogetherSignIn(challenge.request_id);

        if (result.state === 'completed' && !cancelled) {
          cancelled = true;
          await join(result.session_token);
        }
      } catch {
        // Keep waiting; the QR is still on screen.
      }
    }, TOGETHER_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [challenge, join]);

  return (
    <Page className="fiddy-surface fiddy-page" meta={{ title: 'Join a space' }}>
      <div className="fiddy-page-inner">
        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">
            {joined ? 'You are on the board' : 'Work with your people'}
          </h1>
          <p className="fiddy-page-sub">
            Someone brought you into their project. Sign in with Farcaster and
            you land on the same board as everyone else — no new account.
          </p>
        </header>

        {!ready && (
          <p className="text-[13px] text-[#8c9187]">Reading the invite…</p>
        )}

        {ready && missing && (
          <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
            <p className="text-[14px] font-bold">
              That invite is spent or expired.
            </p>
            <p className="mt-2 text-[13.5px] text-[#a8ada2]">
              Invite links are single-use and last a week. Ask whoever invited
              you for a fresh one.
            </p>
          </section>
        )}

        {ready && preview && !joined && (
          <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[19px] font-extrabold">
                {preview.space.name}
              </h2>
              <span className="fiddy-tag fiddy-tag-live">
                #{preview.space.channel}
              </span>
            </div>
            <p className="mt-2 flex items-center gap-2 text-[13px] text-[#a8ada2]">
              <Users aria-hidden="true" className="h-4 w-4" />
              {preview.invited_by_username
                ? '@' + preview.invited_by_username + ' invited you'
                : 'You were invited'}{' '}
              · {preview.uses_left} use{preview.uses_left === 1 ? '' : 's'} left
            </p>

            {challenge ? (
              <div className="mt-4 flex flex-col items-start gap-2">
                <div className="rounded-lg bg-[#141414] p-1">
                  <LoginQRCode url={challenge.url} />
                </div>
                <p className="text-[13px] text-[#a8ada2]">
                  Approve in the Farcaster app and this page will bring you in.
                </p>
              </div>
            ) : (
              <button
                className="fiddy-primary-btn mt-4"
                disabled={busy}
                onClick={() => void signInAndJoin()}
                type="button"
              >
                {busy ? 'Joining…' : 'Sign in with Farcaster and join'}
                <ArrowRight
                  aria-hidden="true"
                  className="ml-2 inline h-4 w-4"
                />
              </button>
            )}

            {error && (
              <p className="mt-3 text-[12.5px] text-[#ff9b8a]">{error}</p>
            )}
          </section>
        )}

        {joined && (
          <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
            <p className="text-[14px] font-bold">
              {joined === 'already'
                ? 'You were already a member.'
                : 'You joined the space.'}
            </p>
            <p className="mt-2 text-[13.5px] text-[#a8ada2]">
              The board is where the work is. Talk in #{preview?.space.channel}.
            </p>
            <Link
              className="fiddy-primary-btn mt-4 inline-flex items-center justify-center"
              params={{}}
              searchParams={{}}
              title="Open Together"
              to="together"
            >
              Open the board
            </Link>
          </section>
        )}

        {error && !preview && (
          <p className="text-[12.5px] text-[#ff9b8a]">{error}</p>
        )}

        <p className="fiddy-honest-note">
          <Users aria-hidden="true" />
          <span>
            Joining adds your Farcaster identity to this space only. It asks for
            nothing else: no email, no password, no keys. Each member works the
            cards in their own Hermes.
          </span>
        </p>
      </div>
    </Page>
  );
};
