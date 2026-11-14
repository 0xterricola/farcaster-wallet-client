/**
 * Making an account, on this device, in plain words.
 *
 * The flow is the onboarding's own voice: one idea per screen, no infrastructure
 * words, and nothing that sounds like a promise the client cannot keep. What it
 * does NOT do is soften the two things a person genuinely has to decide:
 *
 *   1. the words are theirs and only theirs — they are shown once, they are
 *      written down by the person, and Fiddy cannot recover them; and
 *   2. it costs a small fee in ETH, paid from the account they are making.
 *
 * Every quantity on these screens is read, never typed in by us: the network
 * price comes from the contract, the balance comes from the account, and the
 * progress list is driven by what has actually finished. A step that failed says
 * which step and why, in the same voice as the rest.
 *
 * TWO WAYS IN, ONE SET OF SCREENS. When a person already has an account here
 * whose words are held for them — a Google or X sign-up (`~/lib/socialAccount`)
 * — this sheet is handed that account and its own signing (`~/lib/heldWallet`),
 * and the flow is the same one minus the phrase step: there are no words for
 * the person to write down, because the sign-up is holding them. Everything
 * else is identical on purpose, including which address the fee is sent to —
 * the difference is that the address is the account they already have rather
 * than a second one this sheet would have made. The number is registered by
 * that account, so `IdRegistry.idOf(its wallet)` is the FID: one account on
 * this device, and it holds the number.
 *
 * THE ATTEMPT IS WRITTEN DOWN BEFORE THE MONEY MOVES. The moment somebody
 * confirms they saved their twelve words — or, for a held account, the moment
 * the funding screen opens — this device stores an entry for the account it is
 * about to make (`AccountSetupAttempt`): the address the fee must reach, the
 * words, and the one signing key this attempt will ever install. That is what
 * makes the funding screen honest. It asks somebody to send ETH on Optimism to
 * an address, and until this entry existed that address lived in a component's
 * state: closing the tab, a reload, or a crash lost an address somebody had
 * already paid.
 *
 * Everything after that point RESUMES rather than restarts, and the step is read
 * from the chain, never from a progress flag: a FID means the fee already bought
 * the account, so the setup finishes it instead of registering a second one.
 *
 * AND EVERY STEP CAN BE LEFT. Two ways out, and they are different things:
 *
 *   - set aside (the front door, `~/snapchain/accounts/setupAside`): this device
 *     stops treating the unfinished account as the thing in progress, without
 *     deleting it. It stays selected, it stays in the list, and a "Finish
 *     setting up …" line brings it back.
 *   - start over (here, at every step): the account leaves this device. If it
 *     was already registered on the network, only the twelve words bring it
 *     back.
 *
 * A setup that is abandoned stops WRITING, not just drawing: every await below
 * is followed by `here()`, and the flow itself is handed the same question, so
 * an attempt somebody walked away from cannot register or install a key minutes
 * later. A device key that landed just as the person pressed start over is taken
 * back off the node rather than left live with nobody holding it.
 *
 * The recovery phrase lives on this device and nowhere else. It is never
 * rendered into a URL, never logged, and never sent anywhere.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';
import { useAuth } from '~/contexts/AuthProvider';
import { postSignInLocation } from '~/lib/postSignInLanding';
import {
  AccountCreationAborted,
  createOrResumeAccountSetup,
  type FundingState,
  type InstalledSigner,
  readFundingState,
} from '~/snapchain/accounts/createAccount';
import {
  attemptWasStartedOver,
  markAttemptStartedOver,
  newAttemptId,
  startedSetupAccount,
} from '~/snapchain/accounts/createAttempt';
import {
  accountIdFor,
  describeLocalAccount,
  isSettingUp,
  type LocalAccount,
  removeLocalAccount,
  saveLocalAccount,
} from '~/snapchain/accounts/localAccounts';
import { createNodeAccountOps } from '~/snapchain/accounts/nodeAccountOps';
import {
  DEFAULT_OPTIMISM_RPC_URL,
  ID_GATEWAY_ADDRESS,
} from '~/snapchain/accounts/optimism';
import {
  type CustodyAccount,
  custodyAccountFromPhrase,
  generateDeviceSigningKey,
  generateRecoveryPhrase,
} from '~/snapchain/accounts/phrase';
import { signInAsLocalAccount } from '~/snapchain/accounts/session';
import {
  checkNameAvailability,
  type NameAvailability,
} from '~/snapchain/accounts/username';
import { useNodeClient } from '~/snapchain/useNodeClient';

/** How often the balance is re-read while somebody is sending funds. */
const FUNDING_POLL_MS = 5_000;

/** How long we wait after a keystroke before asking about a name. */
const NAME_CHECK_DEBOUNCE_MS = 400;

/** The shortest a display name may be; an empty one just uses the handle. */
const displayNameFor = (display: string, username: string): string =>
  display.trim() || username;

const eth = (wei: bigint): string => {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/, '')
    .slice(0, 6);

  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
};

type Step = 'name' | 'phrase' | 'fund' | 'working' | 'done';

const PROGRESS_ROWS = [
  { key: 'registering', label: 'Your account is being made on the network' },
  { key: 'signer', label: 'This device is allowed to post for you' },
  { key: 'name', label: 'Your @name is being claimed' },
  { key: 'profile', label: 'Your profile is being filled in' },
] as const;

/** The one sentence a person needs before they stop mid-way. */
const KEPT_LINE =
  'This is written down on this device, so you can close this and come back later - the address and the words wait for you.';

/** What starting over actually costs, in Fiddy's voice, with no jargon. */
const START_OVER_QUESTION =
  'Start over? This device forgets this account. If it is already registered on the network, only the twelve words bring it back.';

/**
 * An account that already exists here, whose words are held for it.
 *
 * Passing this is what makes the FID belong to the account the person signed up
 * with: the registration is signed by `custody`, so the registrar mints the FID
 * to its address, and the record that is saved is that same account (same id)
 * with its number filled in. No second account, and nothing to write down.
 */
export interface HeldAccountSetup {
  /** The account that will own the FID. */
  account: LocalAccount;
  /** Its own signing: the sign-up provider's window. */
  custody: CustodyAccount;
  /** How that sign-up is named on these screens ('Google', 'X'). */
  providerName?: string;
}

/**
 * The record to keep once the network has given this account its number.
 *
 * WHY IT IS A FUNCTION OF ITS OWN, AND WHY IT IS THE WHOLE POINT. For an account
 * whose words are held for it, this must be the SAME record, by id, that the
 * sign-up already put in the book — the number is added to the account the
 * person signed up with, and a second account with a second id is precisely the
 * defect this replaces (`describeLocalAccount` then reads it as their email, or
 * their @name, and the switcher shows one row either way). So the held branch
 * spreads that record and fills in what the network answered; the identity
 * fields, the custody marker and the id are carried over untouched, and no
 * phrase is attached, because none was ever here to attach.
 *
 * `setup: undefined` is what ends the attempt: the entry stays, unfinished no
 * longer (see `AccountSetupAttempt`).
 */
export const accountAfterRegistration = ({
  held,
  custodyAddress,
  phrase,
  fid,
  username,
  displayName,
  now = Date.now(),
}: {
  held?: HeldAccountSetup;
  custodyAddress: string;
  phrase?: string;
  fid: number;
  username?: string;
  displayName?: string;
  now?: number;
}): LocalAccount =>
  held
    ? {
        ...held.account,
        fid,
        ...(username ? { username } : {}),
        ...(displayName ? { displayName } : {}),
        signedInAt: now,
        setup: undefined,
      }
    : {
        id: accountIdFor(custodyAddress),
        custodyAddress,
        ...(phrase ? { phrase } : {}),
        fid,
        ...(username ? { username } : {}),
        ...(displayName ? { displayName } : {}),
        createdAt: now,
        signedInAt: now,
        setup: undefined,
      };

export interface CreateAccountSheetProps {
  onClose: () => void;
  /** Called once the account exists on this device, before sign-in. */
  onCreated?: (account: LocalAccount) => void;
  /** Set when the number is being claimed by an account this device already
   *  holds (a Google or X sign-up) rather than by one this sheet makes. */
  held?: HeldAccountSetup;
  /**
   * An attempt this device already started, opened where the person left it.
   * The words and the device key come from the stored entry, so a resume never
   * mints a second signing key on the node.
   */
  resume?: LocalAccount;
}

export const CreateAccountSheet = memo<CreateAccountSheetProps>(
  ({ onClose, onCreated, held, resume }) => {
    const node = useNodeClient();
    const { signIn } = useAuth();

    /** Only an attempt whose words this device kept can be picked back up:
     *  without them there is no custody key to finish the account with. */
    const resuming =
      isSettingUp(resume) && Boolean(resume?.phrase) ? resume : undefined;

    const [step, setStep] = useState<Step>(resuming ? 'fund' : 'name');
    const [username, setUsername] = useState(resuming?.username ?? '');
    const [displayName, setDisplayName] = useState(resuming?.displayName ?? '');
    const [availability, setAvailability] = useState<
      NameAvailability | 'checking'
    >('invalid');
    // No words are made when the account already has words: a held account's
    // phrase lives in the sign-up provider's own window, and generating a second
    // one here would be a second key that owns nothing.
    const [phrase] = useState(() =>
      held ? undefined : (resuming?.phrase ?? generateRecoveryPhrase()),
    );
    const [saved, setSaved] = useState(Boolean(resuming?.phrase));
    /** Has this attempt been written down on this device yet? */
    const [attemptSaved, setAttemptSaved] = useState(Boolean(resuming?.setup));
    const [confirmingStartOver, setConfirmingStartOver] = useState(false);
    const [funding, setFunding] = useState<FundingState | undefined>();
    const [progressIndex, setProgressIndex] = useState(-1);
    const [error, setError] = useState<string | undefined>();
    const [created, setCreated] = useState<LocalAccount | undefined>();

    const custody = useMemo<CustodyAccount | undefined>(
      () =>
        held?.custody ??
        (phrase ? custodyAccountFromPhrase(phrase) : undefined),
      [held, phrase],
    );
    /** The address the fee has to reach: the account that will own the FID. */
    const custodyAddress = custody?.address ?? '';
    /** Which entry in this device's book this attempt is. */
    const accountId = held?.account.id ?? accountIdFor(custodyAddress);
    const rpcUrl = DEFAULT_OPTIMISM_RPC_URL;

    /** Which attempt this is. A step carrying a stale id is refused. */
    const attemptIdRef = useRef(resuming?.setup?.attemptId ?? newAttemptId());
    const startedAtRef = useRef(resuming?.setup?.startedAt ?? Date.now());
    /**
     * The one device key this attempt will ever install: generated at the start
     * and reused by every retry, because minting one per retry is how a node
     * ends up holding a pile of live posting keys nobody is using.
     */
    const signingKeyRef = useRef<string | undefined>(
      resuming?.setup?.signingKeyHex,
    );
    /** Still on screen, and still the attempt somebody wants. */
    const liveRef = useRef(true);
    const abandonedRef = useRef(false);
    /** A key that made it onto the node, so start over can take it back off. */
    const installedRef = useRef<InstalledSigner | undefined>(undefined);
    const opsRef = useRef<ReturnType<typeof createNodeAccountOps> | undefined>(
      undefined,
    );

    useEffect(
      () => () => {
        liveRef.current = false;
      },
      [],
    );

    /**
     * Is this attempt still the one on screen? Asked after every await.
     *
     * False once the sheet is gone, once the person started over, and for a step
     * that lands after its attempt was replaced — which is the whole point: a
     * signature or a registration that arrives late must not resurrect an
     * account somebody already walked away from.
     */
    const here = useCallback(
      () =>
        liveRef.current &&
        !abandonedRef.current &&
        !attemptWasStartedOver(attemptIdRef.current),
      [],
    );

    // Ask the name registry, but not on every keystroke.
    useEffect(() => {
      if (step !== 'name') {
        return undefined;
      }

      let live = true;
      setAvailability('checking');
      const timer = setTimeout(async () => {
        const answer = await checkNameAvailability({ name: username });

        if (live) {
          setAvailability(answer);
        }
      }, NAME_CHECK_DEBOUNCE_MS);

      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [username, step]);

    // While the funding screen is up, read the account back every few seconds.
    // Nothing here writes: the screen is honest about what has arrived.
    useEffect(() => {
      if (step !== 'fund') {
        return undefined;
      }

      let live = true;

      const read = async () => {
        const state = await readFundingState({
          rpcUrl,
          address: custodyAddress,
        });

        if (live) {
          setFunding(state);
        }
      };

      void read();
      const timer = setInterval(() => void read(), FUNDING_POLL_MS);

      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [step, custodyAddress, rpcUrl]);

    /**
     * Write the attempt down, before any money moves.
     *
     * This is the line the whole screen hangs on: after it the address on the
     * funding screen is on disk, and the next visit finds it. If this device
     * refuses to store it, say so and stay put — asking somebody to send ETH to
     * an address the browser cannot remember is the defect this replaces.
     */
    const keepAttempt = useCallback(async () => {
      setError(undefined);

      let signingKeyHex = signingKeyRef.current;

      try {
        signingKeyHex ??= await generateDeviceSigningKey();
        signingKeyRef.current = signingKeyHex;

        const base = held
          ? held.account
          : {
              id: accountId,
              custodyAddress,
              ...(phrase ? { phrase } : {}),
              createdAt: resuming?.createdAt ?? startedAtRef.current,
            };

        await saveLocalAccount(
          startedSetupAccount({
            account: {
              ...base,
              username,
              displayName: displayNameFor(displayName, username),
            },
            attemptId: attemptIdRef.current,
            signingKeyHex,
            startedAt: startedAtRef.current,
          }),
        );
      } catch {
        setError(
          "Fiddy couldn't write this setup down on this device, so nothing has been sent. Check that this browser allows storing data for fiddy.fun, then try again.",
        );
        return;
      }

      setAttemptSaved(true);
      setStep('fund');
    }, [
      accountId,
      custodyAddress,
      displayName,
      held,
      phrase,
      resuming?.createdAt,
      username,
    ]);

    // A held account has no phrase step to hang the write on, so the funding
    // screen writes it the first time it appears instead.
    useEffect(() => {
      if (step !== 'fund' || held === undefined || attemptSaved) {
        return;
      }

      void keepAttempt();
    }, [step, held, attemptSaved, keepAttempt]);

    /**
     * Register (or, when the fee already bought an account, finish) and keep the
     * result on this device.
     *
     * `createOrResumeAccountSetup` reads the chain first and takes the honest
     * half: an existing FID is never registered again, because that spends
     * somebody's money twice.
     */
    const start = useCallback(async () => {
      setStep('working');
      setError(undefined);
      setProgressIndex(0);
      abandonedRef.current = false;

      if (!node) {
        setError(
          'Fiddy needs a server to read Farcaster from, and none is set up yet - open Advanced and pick one, then try again',
        );
        return;
      }

      if (!custody) {
        setError(
          'There is no key here that can sign for this account - open your account screen and start again from there',
        );
        return;
      }

      try {
        const signingKeyHex =
          signingKeyRef.current ?? (await generateDeviceSigningKey());
        signingKeyRef.current = signingKeyHex;

        if (!here()) {
          return;
        }

        const ops = createNodeAccountOps({
          node,
          onStep: (issueStep) => {
            if (here()) {
              setProgressIndex(issueStep === 'done' ? 2 : 1);
            }
          },
        });
        opsRef.current = ops;

        const { result } = await createOrResumeAccountSetup({
          rpcUrl,
          custody,
          node: ops,
          signingKeyHex,
          username,
          displayName: displayNameFor(displayName, username),
          shouldContinue: here,
          onSignerInstalled: (installed) => {
            installedRef.current = installed;
          },
        });

        if (!here()) {
          return;
        }

        const account = accountAfterRegistration({
          ...(held ? { held } : {}),
          custodyAddress,
          ...(phrase ? { phrase } : {}),
          fid: result.fid,
          username,
          displayName: displayNameFor(displayName, username),
        });

        await saveLocalAccount(account);

        if (!here()) {
          return;
        }

        onCreated?.(account);
        setCreated(account);
        setProgressIndex(PROGRESS_ROWS.length);
        setError(result.warning);
        setStep('done');
      } catch (thrown) {
        // An abandoned attempt says nothing: there is nobody on this screen to
        // tell, and "your setup failed" would be a lie about what happened.
        if (thrown instanceof AccountCreationAborted || !here()) {
          return;
        }

        setError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : 'that did not finish - nothing was lost, and you can try the last step again',
        );
      }
    }, [
      node,
      rpcUrl,
      custody,
      custodyAddress,
      username,
      displayName,
      phrase,
      held,
      here,
      onCreated,
    ]);

    // Registration starts by itself as soon as the fee has arrived: the person
    // who just sent the money should not have to also press the button. An
    // account that already has a number skips straight to finishing.
    useEffect(() => {
      if (step !== 'fund' || !funding || funding.kind !== 'ready') {
        return;
      }

      if (funding.fid > 0 || funding.enough) {
        void start();
      }
    }, [step, funding, start]);

    /**
     * Leave the attempt behind for good.
     *
     * Order matters: the entry leaves this device first, so nothing that lands
     * afterwards can write it back; then a key that made it onto the node is
     * taken back off, because nobody here holds its private half anymore.
     */
    const startOver = useCallback(async () => {
      abandonedRef.current = true;
      markAttemptStartedOver(attemptIdRef.current);

      const installed = installedRef.current;
      const removeSigner = opsRef.current?.removeSigner;

      if (held) {
        // A held account is somebody's Google or X sign-up, not a second entry
        // this sheet made: starting over stops claiming the number, it does not
        // throw the sign-up itself away.
        await saveLocalAccount(
          { ...held.account, setup: undefined },
          { select: false },
        ).catch(() => undefined);
      } else if (accountId) {
        await removeLocalAccount(accountId).catch(() => undefined);
      }

      if (installed && removeSigner) {
        await removeSigner(installed).catch(() => undefined);
      }

      onClose();
    }, [accountId, held, onClose]);

    const openFiddy = useCallback(async () => {
      if (!created) {
        return;
      }

      try {
        await signInAsLocalAccount({ account: created, signIn });
      } catch (thrown) {
        setError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : "we couldn't sign you in - try opening Fiddy again",
        );
        return;
      }

      window.location.replace(
        postSignInLocation({
          pathname: window.location.pathname,
          href: window.location.href,
        }),
      );
    }, [created, signIn]);

    const copy = (value: string) => {
      void navigator.clipboard?.writeText(value);
    };

    const availabilityLine = () => {
      if (username.length === 0) {
        return 'Lowercase letters, numbers and dashes. This is the name people will type to find you.';
      }

      switch (availability) {
        case 'checking':
          return 'Checking…';
        case 'free':
          return `@${username} is free.`;
        case 'taken':
          return `@${username} is already taken - try another.`;
        case 'invalid':
          return 'Use lowercase letters, numbers and dashes, starting with a letter or number.';
        default:
          return "We couldn't reach the name list just now - you can carry on and claim it later.";
      }
    };

    /**
     * "Start over", at every step that has something to leave behind. The name
     * step has nothing stored and nothing paid, so its way out is just Back.
     */
    const startOverBlock = () => {
      if (!attemptSaved) {
        return null;
      }

      if (confirmingStartOver) {
        return (
          <div className="fiddy-confirm" data-fiddy="create-start-over-confirm">
            <p className="fiddy-sheet-note">{START_OVER_QUESTION}</p>
            <button
              type="button"
              className="fiddy-primary-btn"
              data-fiddy="create-start-over-yes"
              onClick={() => void startOver()}
            >
              Yes, start over
            </button>
            <button
              type="button"
              className="fiddy-quiet-btn"
              data-fiddy="create-start-over-keep"
              onClick={() => setConfirmingStartOver(false)}
            >
              Keep setting up
            </button>
          </div>
        );
      }

      return (
        <button
          type="button"
          className="fiddy-quiet-btn"
          data-fiddy="create-start-over"
          onClick={() => setConfirmingStartOver(true)}
        >
          Start over
        </button>
      );
    };

    const renderStep = () => {
      if (step === 'name') {
        return (
          <FiddySheet
            name="create-name"
            egg="small"
            title="Pick your name"
            sub="This is the @name people will see. You can change it later."
            primary={{
              label: 'Continue',
              onClick: () => {
                if (held) {
                  void keepAttempt();
                  return;
                }

                setStep('phrase');
              },
              disabled: availability !== 'free',
            }}
            quiet={{ label: 'Back', onClick: onClose }}
            note="Nothing is bought or posted on this screen."
          >
            <label className="fiddy-field">
              <span className="fiddy-field-label">Your @name</span>
              <input
                className="fiddy-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                placeholder="yourname"
                value={username}
                onChange={(event) =>
                  setUsername(
                    event.target.value.toLowerCase().replace(/[^0-9a-z-]/g, ''),
                  )
                }
              />
              <small data-fiddy="name-availability">{availabilityLine()}</small>
            </label>

            <label className="fiddy-field">
              <span className="fiddy-field-label">Your display name</span>
              <input
                className="fiddy-input"
                type="text"
                autoComplete="off"
                maxLength={32}
                placeholder="Your Name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          </FiddySheet>
        );
      }

      // Never reached for a held account: those words are not here to show.
      if (step === 'phrase' && !held) {
        return (
          <FiddySheet
            name="create-phrase"
            egg="small"
            title="Write these twelve words down"
            sub="They are the only way back into this account. Fiddy never keeps a copy, and neither does anyone else."
            primary={{
              label: 'I saved them - continue',
              onClick: () => void keepAttempt(),
              disabled: !saved,
            }}
            quiet={{ label: 'Back', onClick: () => setStep('name') }}
            note="Anyone who has these words owns the account. Keep them somewhere private."
          >
            <code className="fiddy-phrase" data-fiddy="recovery-phrase">
              {phrase}
            </code>
            <button
              type="button"
              className="fiddy-quiet-btn"
              onClick={() => {
                if (phrase) {
                  copy(phrase);
                }
              }}
            >
              Copy the words
            </button>
            <label className="fiddy-check">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have written them down somewhere safe
            </label>
            {error ? <p className="fiddy-error">{error}</p> : null}
          </FiddySheet>
        );
      }

      if (step === 'fund') {
        const ready = funding?.kind === 'ready' ? funding : undefined;
        /** The fee already bought this account: nothing more to send. */
        const alreadyMade = Boolean(ready && ready.fid > 0);

        return (
          <FiddySheet
            name="create-fund"
            egg="small"
            title={held ? 'Claim your Farcaster number' : `Fund @${username}`}
            sub={
              held
                ? 'Making a Farcaster account costs a small fee in ETH, paid on the network it lives on. Send it to your own account, the one you signed up with, from any wallet or exchange that supports Optimism.'
                : 'Making the account costs a small fee in ETH, paid on the network it lives on. Send it from any wallet or exchange that supports Optimism.'
            }
            primary={{
              label: alreadyMade
                ? 'Finish setting up'
                : ready?.enough
                  ? 'Start now'
                  : 'Waiting for the ETH…',
              onClick: () => void start(),
              disabled: !(alreadyMade || ready?.enough),
            }}
            quiet={{
              label: 'Back',
              onClick: () => setStep(held ? 'name' : 'phrase'),
            }}
            note={
              held
                ? `Fiddy never holds your money: the fee goes straight from you to the network. ${held.providerName ?? 'Your sign-up'} will ask you to approve the registration before it is sent.`
                : 'Fiddy never holds your money: the fee goes straight from you to the network.'
            }
          >
            {held ? (
              <p className="fiddy-sheet-note" data-fiddy="held-account-note">
                This number is for the account you already have here. Nothing
                new is made, and there is nothing to write down.
              </p>
            ) : null}
            <div className="fiddy-kv">
              <span>Amount</span>
              <b>{ready ? `${eth(ready.needed)} ETH` : '…'}</b>
              {ready ? (
                <button
                  type="button"
                  className="fiddy-quiet-btn"
                  onClick={() => copy(eth(ready.needed))}
                >
                  Copy
                </button>
              ) : null}
            </div>
            <div className="fiddy-kv">
              <span>Send to</span>
              <code data-fiddy="custody-address">{custodyAddress}</code>
              <button
                type="button"
                className="fiddy-quiet-btn"
                onClick={() => copy(custodyAddress)}
              >
                Copy
              </button>
            </div>
            <a
              className="fiddy-quiet-btn"
              href={`ethereum:${custodyAddress}@10?value=${
                ready ? ready.needed : 0n
              }`}
            >
              Open in a wallet app
            </a>
            <p className="fiddy-waiting" data-fiddy="funding-state">
              {funding === undefined
                ? 'Checking the account…'
                : funding.kind === 'wrong-chain'
                  ? `That endpoint is on a different network (${funding.chainId}) - open Advanced and pick one for Optimism.`
                  : funding.kind === 'unavailable'
                    ? funding.reason
                    : funding.fid > 0
                      ? 'This account already exists on the network. Nothing more to send - there is only the rest of the setup left.'
                      : `In the account: ${eth(funding.balance)} ETH. ${
                          funding.enough
                            ? 'That is enough - starting.'
                            : 'Waiting for funds…'
                        }`}
            </p>
            {ready && ready.fid === 0 ? (
              <p className="fiddy-sheet-note">
                The fee today is {eth(ready.price)} ETH, read from the network a
                moment ago.
              </p>
            ) : null}
            {held ? null : (
              <p className="fiddy-sheet-note" data-fiddy="attempt-kept">
                {KEPT_LINE}
              </p>
            )}
            {error ? <p className="fiddy-error">{error}</p> : null}
            {startOverBlock()}
          </FiddySheet>
        );
      }

      if (step === 'working') {
        return (
          <FiddySheet
            name="create-working"
            egg="small"
            title={`Setting up @${username}`}
            sub="This usually takes under a minute. You can close this and come back later - Fiddy keeps this setup on this device and picks up where it stopped."
            note="Nothing is posted yet."
          >
            <ol className="fiddy-steps" data-fiddy="create-progress">
              {PROGRESS_ROWS.map((row, index) => (
                <li
                  key={row.key}
                  className={
                    index < progressIndex
                      ? 'done'
                      : index === progressIndex
                        ? 'now'
                        : ''
                  }
                >
                  {row.label}
                </li>
              ))}
            </ol>
            {error ? <p className="fiddy-error">{error}</p> : null}
            {error ? (
              <button
                type="button"
                className="fiddy-primary-btn"
                onClick={() => void start()}
              >
                Try the last step again
              </button>
            ) : null}
            {startOverBlock()}
          </FiddySheet>
        );
      }

      return (
        <FiddySheet
          name="create-done"
          egg="small"
          title={`You're in as @${created?.username ?? username}`}
          sub={
            held
              ? 'The Farcaster account is part of the account you signed up with now, and this device can post for you.'
              : 'Your account exists and this device can post for you. Now go and say hello.'
          }
          primary={{ label: 'Open Fiddy', onClick: () => void openFiddy() }}
          quiet={{ label: 'Later', onClick: onClose }}
          note="Posting to the network is the next step - Fiddy always asks first."
        >
          {error ? <p className="fiddy-error">{error}</p> : null}
          <p className="fiddy-sheet-note">
            {held
              ? `The words behind this account stay with your ${held.providerName ?? 'sign-up'}. Fiddy never holds them, and you can take your own copy from your account screen.`
              : 'Your words are saved on this device only. If you lose them, this account cannot be recovered by Fiddy.'}
          </p>
        </FiddySheet>
      );
    };

    return (
      <Modal>
        <DefaultModalContainer onClose={() => onClose()}>
          <div className="flex size-full flex-col items-center justify-center p-4">
            <div
              className="relative flex w-full max-w-md flex-col items-start justify-center rounded-[12px] p-4"
              data-fiddy="create-account"
              data-fiddy-resume={
                resuming ? describeLocalAccount(resuming) : undefined
              }
              onClick={(event) => event.stopPropagation()}
            >
              {renderStep()}
            </div>
          </div>
        </DefaultModalContainer>
      </Modal>
    );
  },
);

CreateAccountSheet.displayName = 'CreateAccountSheet';

/** The registrar the sheet signs against, exported for the doc and for tests. */
export { ID_GATEWAY_ADDRESS };
