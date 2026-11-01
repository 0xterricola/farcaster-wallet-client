/**
 * Fiddy's front door.
 *
 * This replaces the Farcaster sign-in wall that used to be what an
 * unauthenticated visitor saw at `/`. Signing in is still required to open the
 * client — that has not changed and this page does not pretend otherwise — but
 * it is now the last step of a short, friendly setup instead of the first thing
 * anyone meets. Reading publicly needs no account, and signing in is an action
 * the visitor chooses rather than the price of entry.
 *
 * THREE STEPS, AND WHAT THE THIRD ONE IS FOR
 * Say hi, then one screen that names your agent and picks what thinks for it,
 * then one optional screen about the Fiddy balance, then "ready" — that is the
 * whole way in (the greeting is not a numbered step). The balance step is
 * second-to-last on purpose: it is the only step that can be skipped with a
 * single press, it never gates making an account, and it sits before the screen
 * that carries the sign-in because a balance needs a session behind it. The
 * flow was two steps before it, with no step between the brain and the sign-in;
 * the funding card asked for a step after the brain pick, and this is where it
 * went.
 * It used to be four numbered steps: naming and the brain were separate
 * screens, and a third one asked an unauthenticated visitor to allow six apps
 * of which five were dead "soon" switches. That screen asked for a decision
 * nobody could act on yet, before they had seen the app or said one word to
 * their agent, so it is not part of the way in any more: connecting apps lives
 * inside the client (`/~/agent/apps`), where the channels can actually work.
 *
 * Naming and brain-picking share one screen because they are one decision —
 * "who is this, and what thinks for it" — and because Fiddy's own brain is
 * already picked, so the step can be finished with a single press. Every screen
 * is still a real route, so a step can be linked, reloaded and re-entered, and
 * the answers are kept in `~/lib/fiddySetup`.
 *
 * AND ONE THING TO SAY ON THE LAST SCREEN. "No account needed for this part"
 * was true but thin: the visitor had spoken to nobody. The ready sheet now
 * carries one real message to the agent they just named (`TrialChat`), and the
 * primary action changes with it — from "Go social" to "Save <name> & sign in
 * with Farcaster" — because after a reply, keeping that agent is the obvious
 * next thing rather than a generic sign-in.
 *
 * Voice: no infrastructure words on any of these screens. No node, no protocol,
 * no keys, no scopes. If a sentence needs one of those to be true, the sentence
 * is wrong.
 *
 * AND ONE MASCOT, IN TWO SIZES. The front door wears the real 3D Fiddy as its
 * hero (`FiddyHeroStage variant="hero"`, turnable by hand); the name step wears
 * the same model at 84px beside the field it is asking you to fill in, where it
 * is alive but takes no pointer and cannot get between a thumb and the input.
 * Both are the same three.js scene the chrome's mark uses — see
 * `~/components/fiddy/FiddyHeroStage`.
 */

import { KeyRound, MessageCircle, Plug, ShieldCheck } from 'lucide-react';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { BrainSheet, brainSummary } from '~/components/fiddy/BrainSheet';
import { FiddyHeroStage } from '~/components/fiddy/FiddyHeroStage';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { TrialChat } from '~/components/fiddy/TrialChat';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { defaultRoute, routes } from '~/constants/routes';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useNavigate } from '~/hooks/navigation/useNavigate';
import { LazyFiddyFundingPanel } from '~/lazy/funding';
import {
  DEFAULT_AGENT_NAME,
  resetFiddySetup,
  saveFiddySetup,
  useFiddySetup,
} from '~/lib/fiddySetup';
import { clearTrialExchange, loadTrialExchange } from '~/lib/trialChat';

/**
 * The screens this flow renders.
 *
 *   hi     the front door: one sentence and one press, no step number
 *   setup  step 1 of 3 — name your agent, pick what thinks for it
 *   apps   step 3 of the four-step flow this used to be: redirected, see below
 *   funds  step 2 of 3 — the balance: optional, skippable, never a gate
 *   ready  step 3 of 3 — "… is ready", and the one sign-in we cannot skip
 */
export type OnboardingStep = 'hi' | 'setup' | 'apps' | 'funds' | 'ready';

/** The route names this flow walks through. Each of them is still a route. */
export type OnboardingRouteName =
  | 'fiddyWelcome'
  | 'fiddyWelcomeName'
  | 'fiddyWelcomeBrain'
  | 'fiddyWelcomeApps'
  | 'fiddyWelcomeFunds'
  | 'fiddyWelcomeReady'
  /** The public browse window, opened from the front door with no account. */
  | 'publicFeed';

export interface FiddyOnboardingPageProps {
  step: OnboardingStep;
}

/** How many steps the way in has, for "Step 2 of 3". */
const TOTAL_STEPS = 3;

/** Where a screen sits in the flow. The front door and the redirect do not. */
const stepPosition = (step: OnboardingStep): number | null => {
  switch (step) {
    case 'setup':
      return 1;
    case 'funds':
      return 2;
    case 'ready':
      return TOTAL_STEPS;
    default:
      return null;
  }
};

export const FiddyOnboardingPage = ({ step }: FiddyOnboardingPageProps) => {
  useFiddyBrandGround();

  const setup = useFiddySetup();
  const navigate = useNavigate();
  const isSignedIn = useIsSignedIn();

  const [isSigningIn, setIsSigningIn] = useState(false);
  /** Making a brand-new account, on this device, instead of signing in to one. */
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [draftName, setDraftName] = useState(setup.agentName);
  // A trial reply that is already in storage was already read on this screen:
  // the primary action stays the loud one across a reload, because the visitor
  // has already heard their agent speak.
  const [trialAnswered, setTrialAnswered] = useState(
    () => loadTrialExchange() !== null,
  );
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Every step is its own screen, so the heading takes focus and a screen
  // reader announces the new idea instead of starting over at the top.
  useEffect(() => {
    titleRef.current?.focus();
  }, [step]);

  // Leaving the wizard to browse is not cancelling it. Keep the last numbered
  // step beside the answers so the front door can offer a real resume action.
  useEffect(() => {
    if (step === 'setup' || step === 'funds' || step === 'ready') {
      saveFiddySetup({ onboardingStep: step });
    }
  }, [step]);

  // Reaching the last step is what "done" means: the answers are already saved
  // as they were given, and the front door can then offer to continue.
  useEffect(() => {
    if (step === 'ready' && setup.completedAt === null) {
      saveFiddySetup({ completedAt: Date.now() });
    }
  }, [step, setup.completedAt]);

  const position = stepPosition(step);
  const stepMeta = position ? { index: position, total: TOTAL_STEPS } : null;
  const go = (to: OnboardingRouteName) =>
    navigate({ to, params: {}, searchParams: {} });
  const hasProgress =
    setup.onboardingStep !== null || setup.completedAt !== null;
  const resumeSetup = () => {
    // A setup completed before steps were stored still resumes at its end.
    const savedStep = setup.onboardingStep ?? 'ready';
    go(
      savedStep === 'funds'
        ? 'fiddyWelcomeFunds'
        : savedStep === 'ready'
          ? 'fiddyWelcomeReady'
          : 'fiddyWelcomeName',
    );
  };
  const startOver = () => {
    resetFiddySetup();
    clearTrialExchange();
    setDraftName(DEFAULT_AGENT_NAME);
    setTrialAnswered(false);
    go('fiddyWelcomeName');
  };

  // A signed-in session does not belong on a setup screen.
  //
  // The setup flow is reachable signed out on purpose — that is the pivot — but
  // "signed in, looking at the setup" is only ever an accident: the reload that
  // follows a completed sign-in lands back on the screen the sign-in was
  // started from, and one of these screens is where "Go social" lives. Measured
  // before this: a completed SIWF sign-in left the browser on `/welcome/ready`
  // showing "Fiddy is ready." — before and after a reload. So anyone who
  // arrives here holding a session is sent on to the client instead, which is
  // what makes the reload keep the session rather than bounce out of it.
  if (isSignedIn) {
    return <Navigate to={defaultRoute.path} replace />;
  }

  // `/welcome/apps` used to be step 3. It is not a step any more, and it is not
  // a dead address either: a link to it lands on the last step of the flow this
  // flow really has. Connecting apps is a real screen inside the client
  // (`/~/agent/apps`), which is where a channel can actually start working.
  if (step === 'apps') {
    return <Navigate to={routes.fiddyWelcomeReady.path} replace />;
  }

  const commitSetup = () => {
    const name = draftName.trim().slice(0, 24) || DEFAULT_AGENT_NAME;
    saveFiddySetup({ agentName: name });
    setDraftName(name);
    // The brain is picked; the balance comes next, and it is the one step that
    // can be waved away with a single press.
    go('fiddyWelcomeFunds');
  };

  const renderStep = () => {
    switch (step) {
      case 'setup':
        return (
          <FiddySheet
            name="setup"
            step={stepMeta}
            wide
            title="Name your agent, and pick a brain."
            sub="Two small choices, and nothing to buy. You can change either of them whenever you like."
            primary={{ label: 'Continue', onClick: commitSetup }}
            quiet={{ label: 'Back', onClick: () => go('fiddyWelcome') }}
            note="Fiddy's own brain is already picked, so you can go straight on — or pick a service you already pay for, or bring your own."
            titleRef={titleRef}
          >
            <div className="fiddy-form-row">
              <FiddyHeroStage variant="form" />
              <label className="fiddy-field">
                <span className="fiddy-field-label">Your agent's name</span>
                <input
                  className="fiddy-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={24}
                  placeholder={DEFAULT_AGENT_NAME}
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitSetup();
                    }
                  }}
                />
              </label>
            </div>

            <BrainSheet />
          </FiddySheet>
        );

      case 'funds':
        return (
          <FiddySheet
            name="funds"
            step={stepMeta}
            egg="small"
            title="Add funds, or add them later."
            sub="Fiddy's balance is what your agent spends from. Adding to it is optional here, and it never holds up your account."
            note="A Fiddy balance is a credit you spend inside Fiddy. It is topped up by sending USDC on Base to Fiddy's own address, and Fiddy checks that transfer itself — your wallet stays yours. Smallest top-up is $1."
            titleRef={titleRef}
          >
            {/* The real flow, not a picture of one: the same sheet the wallet
                page opens. Signed out it says so and refuses the send rather
                than moving money to a balance that cannot exist — and the one
                press that leaves this screen is the one below it. */}
            <Suspense fallback={null}>
              <LazyFiddyFundingPanel
                quiet={{
                  label: 'Add this later',
                  onClick: () => go('fiddyWelcomeReady'),
                }}
              />
            </Suspense>
          </FiddySheet>
        );

      case 'ready':
        return (
          <FiddySheet
            name="ready"
            step={stepMeta}
            egg="small"
            title={`${setup.agentName} is ready.`}
            sub="That is the setup done. Nothing has been posted, and nothing is switched on behind your back."
            primary={{
              // Once the agent has answered, the action stops being "go social"
              // and becomes "keep the one you just met" — named, because the
              // name is the thing the visitor chose.
              label: trialAnswered
                ? `Save ${setup.agentName} & sign in with Farcaster`
                : 'Go social — sign in with Farcaster',
              onClick: () => setIsSigningIn(true),
            }}
            primaryHighlight={trialAnswered}
            quiet={{
              label: 'Do this later',
              onClick: () => go('fiddyWelcome'),
            }}
            note="Your Fiddy account is what keeps your agent. It lives on Farcaster, the network Fiddy posts to. Already have one? Sign in. New here? Make one right here. Fiddy does the whole thing on this device, and the words that own it never leave your browser."
            titleRef={titleRef}
          >
            <TrialChat
              agentName={setup.agentName}
              setup={setup}
              onAnswered={() => setTrialAnswered(true)}
            />

            <ul className="fiddy-summary">
              <li>
                <MessageCircle aria-hidden="true" />
                <span>
                  <b>{setup.agentName}</b>
                  <small>what you called it</small>
                </span>
              </li>
              <li>
                <Plug aria-hidden="true" />
                <span>
                  <b>{brainSummary(setup)}</b>
                  <small>its brain</small>
                </span>
              </li>
              <li>
                <KeyRound aria-hidden="true" />
                <span>
                  <b>Apps come after sign-in</b>
                  <small>
                    Only Farcaster is ready today. You will switch the rest on
                    from the Agent screen once you are in.
                  </small>
                </span>
              </li>
              <li>
                <ShieldCheck aria-hidden="true" />
                <span>
                  <b>You approve every action</b>
                  <small>pause it or take it back whenever you like</small>
                </span>
              </li>
            </ul>
            <button
              type="button"
              className="fiddy-quiet-btn"
              data-fiddy="create-account-entry"
              onClick={() => setIsCreatingAccount(true)}
            >
              New here? Make your Fiddy account
            </button>
          </FiddySheet>
        );

      case 'hi':
      default:
        return (
          <FiddySheet
            name="hi"
            model="hero"
            title="Meet Fiddy — your agent, living in your pocket."
            sub="Chat like you message a friend. Fiddy does the busywork, and asks before it acts."
            primary={{
              label: 'Look around first',
              onClick: () => go('publicFeed'),
              testId: 'browse-cta',
            }}
            // Reading is not a commitment: no name, no brain, no account. It is
            // the primary action because a visitor can see Fiddy's public posts
            // before deciding whether to set anything up.
            secondary={{
              label: hasProgress ? `Resume with ${setup.agentName}` : 'Say hi',
              onClick: hasProgress ? resumeSetup : () => go('fiddyWelcomeName'),
              testId: hasProgress ? 'resume-setup' : 'start-setup',
            }}
            quiet={{
              label: 'Already have an account? Sign in',
              onClick: () => setIsSigningIn(true),
            }}
            note="No account needed to look around or say hi. Your Fiddy account lives on Farcaster, the network Fiddy posts to. You only need one when you want to post."
            titleRef={titleRef}
          >
            <ul className="fiddy-promise">
              <li>Your agent, your choice of brain — no lock-in.</li>
              <li>It connects to the apps you already use.</li>
              <li>You stay in control: it asks first, and you can pause it.</li>
            </ul>
            {hasProgress ? (
              <button
                type="button"
                className="fiddy-quiet-btn"
                data-fiddy="start-over"
                onClick={startOver}
              >
                Start over
              </button>
            ) : null}
          </FiddySheet>
        );
    }
  };

  return (
    <Page className="fiddy-surface" meta={{ title: 'Fiddy — meet your agent' }}>
      <div data-fiddy="onboarding">
        {renderStep()}

        <footer className="fiddy-legal">
          <Link
            to="privacyPolicy"
            params={{}}
            searchParams={{}}
            title="Privacy Policy"
          >
            Privacy
          </Link>
          <Link
            to="termsOfUse"
            params={{}}
            searchParams={{}}
            title="Terms of Use"
          >
            Terms
          </Link>
          <Link
            to="developers"
            params={{}}
            searchParams={{}}
            title="Developers"
          >
            Developers
          </Link>
        </footer>
      </div>

      {isSigningIn ? (
        <LoginModal onClose={() => setIsSigningIn(false)} />
      ) : null}

      {isCreatingAccount ? (
        <CreateAccountSheet onClose={() => setIsCreatingAccount(false)} />
      ) : null}
    </Page>
  );
};
