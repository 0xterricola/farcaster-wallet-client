// @vitest-environment jsdom

/**
 * The way in, measured as a walk rather than as prose: three numbered steps, the
 * middle one optional, and the apps screen none of them.
 *
 * WHY THIS FILE EXISTS
 * The flow used to be four numbered steps (`name` → `brain` → `apps` → `ready`)
 * and the third one asked an unauthenticated visitor to allow six apps, five of
 * them dead "soon" switches, before they had seen the app or said one word to
 * their agent. That screen was cut, leaving two steps. The funding card then
 * asked for the balance to be offered after the brain pick, so the middle step
 * is now "add funds, or add them later": the file was renamed from
 * `wizardHasTwoSteps.test.tsx` because it no longer measures two.
 *
 * The assertions that matter:
 *
 *   1. naming and picking a brain are ONE screen (step 1), and it can be
 *      finished with a single press — Fiddy's own brain is already picked;
 *   2. the balance comes after it (step 2 of 3) and is skippable: one press
 *      leaves it for the last screen, and the account is complete regardless —
 *      the funding step must never be a gate on making an account;
 *   3. nothing on the way in renders the apps sheet, and `/welcome/apps` is not
 *      a dead address — it lands on the last step of the flow that does exist.
 *
 * The apps sheet itself is not deleted: it is what `/~/agent/apps` renders for
 * a signed-in owner (`deviceOnlySession.test.tsx` holds that door open) and what
 * `AppsSheet.test.tsx` still measures row by row.
 *
 * The funding panel is stood in for here. Its own sheet, its own refusal to send
 * without a session, and its wallet choices are measured in
 * `AddFundsSheet.test.tsx` and `fiddyCredit.test.ts`; what this file measures is
 * the walk, and that the step hands the panel the one press that skips it.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAIN_CARDS } from '~/components/fiddy/BrainSheet';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import {
  loadFiddySetup,
  resetFiddySetup,
  saveFiddySetup,
} from '~/lib/fiddySetup';

const state = vi.hoisted(() => ({ signedIn: false }));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => state.signedIn,
}));

// There is no agent service to talk to in a test, and this screen does not ask
// it anything until a card is opened.
vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: 'unpaired',
    session: null,
    pair: vi.fn(),
    forget: vi.fn(),
  }),
}));

// The funding panel's own chunk: see the docstring. Its job in this file is
// only to hold the way out the step gives it.
vi.mock('~/lazy/funding', () => ({
  LazyFiddyFundingPanel: ({
    quiet,
  }: {
    quiet?: { label: string; onClick: () => void } | null;
  }) =>
    quiet ? (
      <button type="button" data-fiddy="funding-break" onClick={quiet.onClick}>
        {quiet.label}
      </button>
    ) : null,
}));

vi.mock('~/lib/agentService', () => ({
  AgentServiceError: class AgentServiceError extends Error {
    code: string;

    status: number;

    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  },
  probeBrain: vi.fn(),
  applyBrain: vi.fn(),
  listAgents: vi.fn().mockResolvedValue([]),
}));

// The page chrome and the brand plumbing are not what this file measures.
vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { FiddyOnboardingPage } =
  await import('~/pages/fiddyOnboarding/FiddyOnboardingPage');

/**
 * The wizard exactly as the router wires it: one element per step, and the two
 * addresses that lead into step 1.
 */
const renderWizard = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/welcome" element={<FiddyOnboardingPage step="hi" />} />
        <Route
          path="/welcome/name"
          element={<FiddyOnboardingPage step="setup" />}
        />
        <Route
          path="/welcome/brain"
          element={<FiddyOnboardingPage step="setup" />}
        />
        <Route
          path="/welcome/apps"
          element={<FiddyOnboardingPage step="apps" />}
        />
        <Route
          path="/welcome/funds"
          element={<FiddyOnboardingPage step="funds" />}
        />
        <Route
          path="/welcome/ready"
          element={<FiddyOnboardingPage step="ready" />}
        />
        <Route path="/" element={<div>the client</div>} />
      </Routes>
    </MemoryRouter>,
  );

const stepCount = () =>
  document.querySelector('[data-fiddy="step-count"]')?.textContent ?? '';

describe('the way in, as a three-step walk', () => {
  beforeEach(() => {
    state.signedIn = false;
    installFakeStorage();
  });

  afterEach(() => {
    cleanup();
    resetFiddySetup();
  });

  it('does the naming and the brain on one screen, as Step 1 of 3', () => {
    renderWizard('/welcome/name');

    expect(document.querySelector('[data-fiddy-step="setup"]')).toBeTruthy();
    expect(stepCount()).toBe('Step 1 of 3');

    // Both halves of the decision, on this one screen.
    expect(screen.getByLabelText("Your agent's name")).toBeTruthy();
    expect(document.querySelector('[data-fiddy="brains"]')).toBeTruthy();
    for (const card of BRAIN_CARDS) {
      expect(
        document.querySelector(`[data-fiddy-brain="${card.id}"]`),
      ).toBeTruthy();
    }

    // And the built-in brain is already picked, which is what makes the step
    // finishable in one press.
    const builtIn = document.querySelector('[data-fiddy-brain="fiddy"]');
    expect(builtIn?.getAttribute('data-state')).toBe('selected');
    expect(loadFiddySetup().brain).toBe('fiddy');
  });

  it('is finished in one press: Continue lands on Step 2 of 3, the balance', () => {
    renderWizard('/welcome/name');

    fireEvent.change(screen.getByLabelText("Your agent's name"), {
      target: { value: 'Pip' },
    });
    fireEvent.click(screen.getByText('Continue'));

    expect(stepCount()).toBe('Step 2 of 3');
    expect(screen.getByText('Add funds, or add them later.')).toBeTruthy();
    // The name survives the step it was given on.
    expect(loadFiddySetup().agentName).toBe('Pip');
  });

  it('lets the balance step be skipped in one press, and never gates the account', () => {
    renderWizard('/welcome/funds');

    fireEvent.click(screen.getByText('Add this later'));

    expect(stepCount()).toBe('Step 3 of 3');
    expect(screen.getByText('Fiddy is ready.')).toBeTruthy();
    const saved = loadFiddySetup();
    expect(saved.agentName).toBe('Fiddy');
    expect(saved.brain).toBe('fiddy');
    // Reaching the last screen is what "done" means, funding or not.
    expect(saved.completedAt).not.toBeNull();
  });

  it('says out loud that the funding step is optional', () => {
    renderWizard('/welcome/funds');

    expect(screen.getByText(/never holds up your account/)).toBeTruthy();
    expect(screen.getByText(/Smallest top-up is \$1/)).toBeTruthy();
  });

  it('keeps the default name when it is left alone', () => {
    renderWizard('/welcome/name');

    fireEvent.click(screen.getByText('Continue'));
    fireEvent.click(screen.getByText('Add this later'));

    expect(screen.getByText('Fiddy is ready.')).toBeTruthy();
  });

  it('never renders the apps sheet on the way in', () => {
    for (const entry of [
      '/welcome',
      '/welcome/name',
      '/welcome/brain',
      '/welcome/funds',
      '/welcome/ready',
    ]) {
      const { unmount } = renderWizard(entry);
      expect(document.querySelector('[data-fiddy="apps"]')).toBeNull();
      unmount();
    }
  });

  it('turns /welcome/apps into the last step instead of a dead screen', () => {
    renderWizard('/welcome/apps');

    expect(stepCount()).toBe('Step 3 of 3');
    expect(screen.getByText(/is ready\./)).toBeTruthy();
    expect(document.querySelector('[data-fiddy="apps"]')).toBeNull();
  });

  it('lands an older /welcome/brain link on step 1, not on a removed screen', () => {
    renderWizard('/welcome/brain');

    expect(stepCount()).toBe('Step 1 of 3');
    expect(document.querySelector('[data-fiddy="brains"]')).toBeTruthy();
    expect(screen.getByLabelText("Your agent's name")).toBeTruthy();
  });

  it('still opens the front door for someone who is not signed in', () => {
    renderWizard('/welcome');

    expect(screen.getByText(/Meet Fiddy/)).toBeTruthy();
    expect(stepCount()).toBe('');
  });

  it('resumes the saved step after Do this later, and starts over only on request', () => {
    renderWizard('/welcome/name');

    fireEvent.change(screen.getByLabelText("Your agent's name"), {
      target: { value: 'Pip' },
    });
    act(() => {
      saveFiddySetup({ brain: 'google' });
    });
    fireEvent.click(screen.getByText('Continue'));
    fireEvent.click(screen.getByText('Add this later'));
    expect(stepCount()).toBe('Step 3 of 3');

    fireEvent.click(screen.getByText('Do this later'));
    expect(screen.getByText(/Meet Fiddy/)).toBeTruthy();
    expect(loadFiddySetup()).toMatchObject({
      agentName: 'Pip',
      brain: 'google',
      onboardingStep: 'ready',
    });

    fireEvent.click(screen.getByText('Resume with Pip'));
    expect(stepCount()).toBe('Step 3 of 3');
    expect(screen.getByText('Pip is ready.')).toBeTruthy();

    fireEvent.click(screen.getByText('Do this later'));
    fireEvent.click(screen.getByText('Start over'));
    expect(stepCount()).toBe('Step 1 of 3');
    expect(
      (screen.getByLabelText("Your agent's name") as HTMLInputElement).value,
    ).toBe('Fiddy');
    expect(loadFiddySetup()).toMatchObject({
      agentName: 'Fiddy',
      brain: 'fiddy',
      onboardingStep: 'setup',
      completedAt: null,
    });
  });
});
