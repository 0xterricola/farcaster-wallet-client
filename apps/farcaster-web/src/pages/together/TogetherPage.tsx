/**
 * Together — "work with your people".
 *
 * The surface exists so one project can be one board that a group shares. It
 * reads, in order, as three honest states:
 *
 *   1. you are not signed in  → one button, and the phone does the rest;
 *   2. you have no space yet  → name it, point it at a channel, done;
 *   3. you have a space       → the board, the people, the invite link.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * It does not run the work. Every card here is a card in a shared board; the
 * thinking happens in each member's own Hermes, with their own keys and their
 * own provider — so this page never asks for an inference key, and neither does
 * the service behind it. The channel is where talking happens; the board is
 * where work happens.
 */

import {
  Check,
  Copy,
  Link2,
  RefreshCw,
  Send,
  UserPlus,
  Zap,
} from 'lucide-react';
import React from 'react';

import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Page } from '~/components/page/Page';
import { LoginQRCode } from '~/lazy/components';
import {
  announce,
  clearTogetherSession,
  createCard,
  createInvite,
  createSpace,
  listSpaces,
  openSpace,
  pollTogetherSignIn,
  readEvents,
  readState,
  readTogetherSession,
  startTogetherSignIn,
  storeTogetherSession,
  TOGETHER_POLL_INTERVAL_MS,
  TOGETHER_SIGN_IN_TIMEOUT_MS,
  TogetherCard,
  TogetherCardStatus,
  TogetherError,
  TogetherEvent,
  TogetherInvite,
  TogetherSignInChallenge,
  TogetherSpace,
  TogetherState,
  updateCard,
} from '~/lib/together';

const COLUMNS: { id: TogetherCardStatus; label: string; hint: string }[] = [
  { id: 'todo', label: 'To do', hint: 'nobody has started' },
  { id: 'doing', label: 'Doing', hint: 'someone is on it' },
  { id: 'done', label: 'Done', hint: 'finished' },
];

const describeError = (error: unknown): string =>
  error instanceof TogetherError
    ? error.message
    : 'Something went wrong. Try again.';

/** Step 1: the Farcaster handshake, driven by the service's own challenge. */
const SignInPanel = ({
  onSession,
}: {
  onSession: (session: Awaited<ReturnType<typeof pollTogetherSignIn>>) => void;
}) => {
  const [challenge, setChallenge] =
    React.useState<TogetherSignInChallenge | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [waiting, setWaiting] = React.useState(false);
  const [slow, setSlow] = React.useState(false);

  const start = React.useCallback(async () => {
    setError(null);
    setSlow(false);

    try {
      setChallenge(await startTogetherSignIn());
      setWaiting(true);
    } catch (problem) {
      setError(describeError(problem));
    }
  }, []);

  React.useEffect(() => {
    if (!waiting || !challenge) {
      return undefined;
    }

    const startedAt = Date.now();
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) {
        return;
      }

      if (Date.now() - startedAt > TOGETHER_SIGN_IN_TIMEOUT_MS) {
        cancelled = true;
        setWaiting(false);
        setSlow(true);
        return;
      }

      try {
        const result = await pollTogetherSignIn(challenge.request_id);

        if (result.state === 'completed') {
          cancelled = true;
          setWaiting(false);
          onSession(result);
        } else if (result.state === 'expired') {
          cancelled = true;
          setWaiting(false);
          setSlow(true);
        }
      } catch {
        // A poll that fails is not fatal — the next one may succeed, and the
        // timeout above is what eventually gives up out loud.
      }
    }, TOGETHER_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [challenge, onSession, waiting]);

  return (
    <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
      <h2 className="mb-1 text-[17px] font-extrabold">
        Sign in with Farcaster
      </h2>
      <p className="mb-4 max-w-[46ch] text-[13.5px] leading-relaxed text-[#a8ada2]">
        This is the same sign-in the rest of fiddy.fun uses. There is no account
        to make and no password to remember — your Farcaster identity{' '}
        <em>is</em> your membership.
      </p>

      {challenge ? (
        <div className="flex flex-col items-start gap-3">
          <div className="rounded-lg bg-[#141414] p-1">
            <LoginQRCode url={challenge.url} />
          </div>
          <p className="text-[13px] text-[#a8ada2]">
            {waiting
              ? 'Open the Farcaster app and approve. This page is listening.'
              : 'That request is spent — start again.'}
          </p>
          <button
            type="button"
            className="fiddy-quiet-btn"
            onClick={() => void start()}
          >
            <RefreshCw aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
            Start a new request
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="fiddy-primary-btn"
          onClick={() => void start()}
        >
          Sign in with Farcaster
        </button>
      )}

      {slow && (
        <p className="mt-3 text-[12.5px] text-[#a8ada2]">
          Still nothing. Make sure the link opened the Farcaster app, then
          approve there — or start a fresh request.
        </p>
      )}
      {error && <p className="mt-3 text-[12.5px] text-[#ff9b8a]">{error}</p>}
    </section>
  );
};

/** Step 2: name it and point it at a channel. */
const CreateSpacePanel = ({
  token,
  onCreated,
}: {
  token: string;
  onCreated: (session: { token: string; space: TogetherSpace }) => void;
}) => {
  const [name, setName] = React.useState('');
  const [channel, setChannel] = React.useState('fiddy');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const created = await createSpace(token, { name, channel });
      onCreated({ token: created.session_token, space: created.space });
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="mb-1 text-[17px] font-extrabold">Start a space</h2>
      <p className="mb-4 max-w-[46ch] text-[13.5px] leading-relaxed text-[#a8ada2]">
        A space is one project: its own board, its own people, and a Farcaster
        channel to talk in.
      </p>

      <label className="mb-3 block">
        <span className="mb-1 block text-[12px] font-bold text-[#a8ada2]">
          What is it called?
        </span>
        <input
          className="fiddy-input"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="Fiddy launch"
          value={name}
        />
      </label>

      <label className="mb-4 block">
        <span className="mb-1 block text-[12px] font-bold text-[#a8ada2]">
          Which Farcaster channel?
        </span>
        <input
          className="fiddy-input"
          maxLength={40}
          onChange={(event) => setChannel(event.target.value)}
          placeholder="fiddy"
          value={channel}
        />
        <span className="mt-1 block text-[12px] text-[#8c9187]">
          The channel is the conversation; the board is the work. Finished work
          can be cast there.
        </span>
      </label>

      <button
        className="fiddy-primary-btn"
        disabled={busy || !name.trim()}
        type="submit"
      >
        {busy ? 'Creating…' : 'Create the space'}
      </button>
      {error && <p className="mt-3 text-[12.5px] text-[#ff9b8a]">{error}</p>}
    </form>
  );
};

const CardColumn = ({
  cards,
  column,
  onMove,
  onAnnounce,
  busyCardId,
}: {
  cards: TogetherCard[];
  column: (typeof COLUMNS)[number];
  onMove: (card: TogetherCard, status: TogetherCardStatus) => void;
  onAnnounce: (card: TogetherCard) => void;
  busyCardId: string | null;
}) => (
  <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-4">
    <header className="mb-3 flex items-baseline gap-2">
      <h3 className="text-[14px] font-extrabold">{column.label}</h3>
      <span className="text-[11.5px] text-[#8c9187]">{cards.length}</span>
      <span className="fiddy-soon">{column.hint}</span>
    </header>

    {cards.length === 0 ? (
      <p className="text-[12.5px] text-[#8c9187]">Nothing here.</p>
    ) : (
      <ul
        className="fiddy-card-list"
        style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
      >
        {cards.map((card) => (
          <li
            className="rounded-xl border border-[#2a2c28] bg-[#212420] p-3"
            key={card.id}
          >
            <p className="mb-1 text-[14px] font-bold">{card.title}</p>
            {card.note && <p className="fiddy-card-line">{card.note}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {column.id !== 'doing' && column.id !== 'done' && (
                <button
                  className="fiddy-quiet-btn-outline"
                  disabled={busyCardId === card.id}
                  onClick={() => onMove(card, 'doing')}
                  type="button"
                >
                  Start
                </button>
              )}
              {column.id === 'doing' && (
                <button
                  className="fiddy-quiet-btn-outline"
                  disabled={busyCardId === card.id}
                  onClick={() => onMove(card, 'done')}
                  type="button"
                >
                  <Check
                    aria-hidden="true"
                    className="mr-1 inline h-3.5 w-3.5"
                  />
                  Done
                </button>
              )}
              {column.id === 'done' && (
                <button
                  className="fiddy-quiet-btn-outline"
                  disabled={busyCardId === card.id}
                  onClick={() => onAnnounce(card)}
                  type="button"
                >
                  <Send
                    aria-hidden="true"
                    className="mr-1 inline h-3.5 w-3.5"
                  />
                  Cast it to the channel
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const BoardPanel = ({
  state,
  token,
  onState,
}: {
  state: TogetherState;
  token: string;
  onState: (next: TogetherState) => void;
}) => {
  const [invite, setInvite] = React.useState<TogetherInvite | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [busyCardId, setBusyCardId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<TogetherEvent[]>([]);
  const [refreshedAt, setRefreshedAt] = React.useState<number>(Date.now());

  const refresh = React.useCallback(async () => {
    try {
      onState(await readState(token));
      setRefreshedAt(Date.now());
    } catch (problem) {
      setError(describeError(problem));
    }
  }, [onState, token]);

  // Polling, not websockets. Every tick asks what changed since the cursor we
  // last saw, and only re-reads the board when something did.
  React.useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const update = await readEvents(token, state.cursor);

        if (!cancelled && update.events.length > 0) {
          setActivity(update.events.slice(-6));
          onState(await readState(token));
          setRefreshedAt(Date.now());
        }
      } catch {
        // Stay quiet on a failed tick; the next one usually works.
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onState, state.cursor, token]);

  const move = async (card: TogetherCard, status: TogetherCardStatus) => {
    setBusyCardId(card.id);
    setError(null);

    try {
      await updateCard(token, card.id, { status, version: card.version });
      await refresh();
    } catch (problem) {
      setError(describeError(problem));
      await refresh();
    } finally {
      setBusyCardId(null);
    }
  };

  const addCard = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!title.trim()) {
      return;
    }

    try {
      await createCard(token, { title: title.trim() });
      setTitle('');
      await refresh();
    } catch (problem) {
      setError(describeError(problem));
    }
  };

  const inviteSomeone = async () => {
    try {
      setInvite(await createInvite(token));
      setCopied(false);
    } catch (problem) {
      setError(describeError(problem));
    }
  };

  const copy = async () => {
    if (!invite) {
      return;
    }

    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
    } catch {
      setError('Copying needs permission here — select the link instead.');
    }
  };

  const cast = async (card: TogetherCard) => {
    setBusyCardId(card.id);

    try {
      await announce(token, { card_id: card.id });
      await refresh();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusyCardId(null);
    }
  };

  const mine = state.members.find((member) => member.fid === state.me.fid);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[20px] font-extrabold tracking-tight">
            {state.space.name}
          </h2>
          <span className="fiddy-tag fiddy-tag-live">
            #{state.space.channel}
          </span>
          {state.identity === 'unverified-dev' && (
            <span className="fiddy-tag">offline verifier</span>
          )}
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#a8ada2]">
          {state.members.length === 1
            ? 'You are the only one here so far. Send someone the link below.'
            : `${state.members.length} people on this board. Everyone sees the same cards.`}
        </p>

        <ul className="mt-3 flex flex-wrap gap-2">
          {state.members.map((member) => (
            <li
              className="fiddy-tag"
              key={member.fid}
              style={{ marginLeft: 0 }}
              title={`fid ${member.fid}`}
            >
              {member.username ? '@' + member.username : 'fid ' + member.fid}
              {member.role === 'owner' ? ' · owner' : ''}
            </li>
          ))}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mine?.role === 'owner' && (
            <button
              type="button"
              className="fiddy-secondary-btn"
              onClick={() => void inviteSomeone()}
            >
              <UserPlus aria-hidden="true" className="mr-1 inline h-4 w-4" />
              Invite someone
            </button>
          )}
          <button
            type="button"
            className="fiddy-quiet-btn"
            onClick={() => void clearTogetherSession()}
          >
            Sign out of Together
          </button>
        </div>

        {mine?.role !== 'owner' && (
          <p className="mt-3 text-[12.5px] text-[#8c9187]">
            Only the space owner hands out invite links.
          </p>
        )}

        {invite && (
          <div className="mt-3 rounded-xl border border-[#2a2c28] bg-[#212420] p-3">
            <p className="mb-2 flex items-center gap-2 text-[12.5px] font-bold">
              <Link2 aria-hidden="true" className="h-4 w-4" />
              Send this to whoever is working with you
            </p>
            <code className="block break-all text-[12px] text-[#c8ff4d]">
              {invite.url}
            </code>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="fiddy-quiet-btn-outline"
                onClick={() => void copy()}
              >
                <Copy aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <span className="text-[12px] text-[#8c9187]">
                {invite.max_uses === 1 ? 'One use' : `${invite.max_uses} uses`},
                good for a week. They sign in with Farcaster — no account to
                make.
              </span>
            </div>
          </div>
        )}

        {state.pending_announcements > 0 && (
          <p className="mt-3 text-[12.5px] text-[#a8ada2]">
            {state.pending_announcements} update
            {state.pending_announcements === 1 ? '' : 's'} waiting to be cast —
            the Hermes running for a member of this space will send it.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-5">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => void addCard(event)}
        >
          <label className="min-w-[220px] flex-1">
            <span className="mb-1 block text-[12px] font-bold text-[#a8ada2]">
              Add a card to the board
            </span>
            <input
              className="fiddy-input"
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Write the release note"
              value={title}
            />
          </label>
          <button
            className="fiddy-primary-btn self-end sm:w-auto"
            disabled={!title.trim()}
            style={{ width: 'auto', padding: '0 22px' }}
            type="submit"
          >
            Add card
          </button>
        </form>

        <p className="mt-3 flex items-center gap-2 text-[12px] text-[#8c9187]">
          <Zap aria-hidden="true" className="h-3.5 w-3.5" />
          Each card is worked by whoever picks it up — in their own Hermes, with
          their own keys. Updated {new Date(refreshedAt).toLocaleTimeString()}.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {COLUMNS.map((column) => (
          <CardColumn
            busyCardId={busyCardId}
            cards={state.cards.filter((card) => card.status === column.id)}
            column={column}
            key={column.id}
            onAnnounce={(card) => void cast(card)}
            onMove={(card, status) => void move(card, status)}
          />
        ))}
      </div>

      {activity.length > 0 && (
        <section className="rounded-2xl border border-[#2a2c28] bg-[#1b1d19] p-4">
          <h3 className="mb-2 text-[13px] font-extrabold">
            What just happened
          </h3>
          <ul
            className="fiddy-card-list"
            style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
          >
            {activity.map((event) => (
              <li className="fiddy-card-line" key={event.seq}>
                {event.actor_name ? '@' + event.actor_name : 'someone'}{' '}
                {event.kind === 'card.created' ? 'added' : 'moved'}{' '}
                <strong>{event.title ?? 'a card'}</strong>
                {event.status ? ` → ${event.status}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="rounded-xl border border-[#5a2b22] bg-[#2a1a16] p-3 text-[12.5px] text-[#ff9b8a]">
          {error}
        </p>
      )}
    </div>
  );
};

export const TogetherPage = () => {
  useFiddyBrandGround();

  const [session, setSession] = React.useState<{
    token: string;
    fid: number;
    username: string | null;
  } | null>(null);
  const [space, setSpace] = React.useState<TogetherSpace | null>(null);
  const [state, setState] = React.useState<TogetherState | null>(null);
  const [spaceCount, setSpaceCount] = React.useState(0);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const adopt = React.useCallback(
    async (token: string, fid: number, username: string | null) => {
      setSession({ token, fid, username });

      try {
        const mine = await listSpaces(token);
        setSpaceCount(mine.spaces.length);

        if (mine.space_id) {
          const current = mine.spaces.find(
            (entry) => entry.id === mine.space_id,
          );

          if (current) {
            setSpace(current);
            setState(await readState(token));
          }
        } else if (mine.spaces.length > 0) {
          // A signed-in account that belongs to a space but has no active one:
          // open the first, and keep the token that says which space we mean.
          const opened = await openSpace(token, mine.spaces[0].id);

          setSpace(opened.space);
          setSession({ token: opened.session_token, fid, username });
          await storeTogetherSession({
            token: opened.session_token,
            fid,
            username,
            pfp_url: null,
            space_id: opened.space.id,
          });
          setState(await readState(opened.session_token));
        }
      } catch (problem) {
        // A stored session the service no longer honours is not worth shouting
        // about: fall back to the sign-in door.
        if (problem instanceof TogetherError && problem.status === 401) {
          await clearTogetherSession();
          setSession(null);
        } else {
          setError(describeError(problem));
        }
      }
    },
    [],
  );

  React.useEffect(() => {
    (async () => {
      const stored = await readTogetherSession();

      if (stored) {
        await adopt(stored.token, stored.fid, stored.username);
      }

      setReady(true);
    })();
  }, [adopt]);

  return (
    <Page className="fiddy-surface fiddy-page" meta={{ title: 'Together' }}>
      <div className="fiddy-page-inner">
        <header className="fiddy-page-head">
          <h1 className="fiddy-page-title">Work with your people</h1>
          <p className="fiddy-page-sub">
            One project, one board, everyone on the same page. You bring your
            Farcaster identity; the people you invite bring theirs. Each of you
            works the cards in your own Hermes — nobody shares a key.
          </p>
        </header>

        {!ready && (
          <p className="text-[13px] text-[#8c9187]">Loading your spaces…</p>
        )}

        {ready && !session && (
          <SignInPanel
            onSession={async (result) => {
              if (result.state !== 'completed') {
                return;
              }

              await storeTogetherSession({
                token: result.session_token,
                fid: result.fid,
                username: result.username,
                pfp_url: result.pfp_url,
                space_id: result.space_id,
                identity: result.identity,
              });
              await adopt(result.session_token, result.fid, result.username);
            }}
          />
        )}

        {ready && session && !space && (
          <CreateSpacePanel
            onCreated={async (created) => {
              // The token that created the space is the one that SAYS which
              // space it is: the sign-in token carries no space, so every write
              // made with it answers "join a space first". Swap the session's
              // token before the board mounts, and persist it so a reload does
              // not fall back to the space-less one.
              setSession((current) =>
                current ? { ...current, token: created.token } : current,
              );
              setSpace(created.space);
              setState(await readState(created.token));
              setSpaceCount((count) => count + 1);
              await storeTogetherSession({
                token: created.token,
                fid: session.fid,
                username: session.username,
                pfp_url: null,
                space_id: created.space.id,
              });
            }}
            token={session.token}
          />
        )}

        {ready && session && space && state && (
          <BoardPanel onState={setState} state={state} token={session.token} />
        )}

        {error && <p className="text-[12.5px] text-[#ff9b8a]">{error}</p>}

        <p className="fiddy-honest-note">
          <Zap aria-hidden="true" />
          <span>
            Boards refresh by asking the space service what changed every few
            seconds. Live typing and websockets are <strong>soon</strong>.
            Spaces are an alpha: they hold FIDs, handles, boards and cast
            intents — never keys, never seed phrases.
            {spaceCount > 1 ? ` You are in ${spaceCount} spaces.` : ''}
          </span>
        </p>
      </div>
    </Page>
  );
};
