/**
 * The setup this browser holds for Fiddy: what your agent is called, which
 * brain it uses (and which model of that brain), and which apps you have let it
 * touch.
 *
 * Deliberately local. There is no Fiddy account to create and no server this is
 * sent to; it is a preference file, so someone can leave a step and come back
 * without re-answering. It is also the only reason the onboarding can offer
 * "skip for now" honestly.
 *
 * What must NOT live here: any AI service's key. The one credential this client
 * can hold — the session key for an agent service you run yourself — belongs to
 * `~/lib/agentService` and is stored by that module alone. This file keeps the
 * service *address* and the *model name* and nothing else, so someone can leave
 * the step and come back to it without their key being kept anywhere.
 */

import { useEffect, useState } from 'react';

import type { WalletChoiceId } from '~/lib/surp/walletChoice';

export type BrainId =
  | 'fiddy'
  | 'surp'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'nous'
  | 'custom';

/**
 * Every id a stored setup may hold. 'surp' is a service like the others — its
 * address lives with the provider presets on the agent service, not here — so
 * it belongs in this list rather than in LEGACY_BRAINS: a build that offered it
 * under its own name is a build that offered the same choice.
 */
export const BRAIN_IDS: BrainId[] = [
  'fiddy',
  'surp',
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'nous',
  'custom',
];

export type ChannelId =
  | 'farcaster'
  | 'whatsapp'
  | 'discord'
  | 'telegram'
  | 'imessage'
  | 'email';

export type OnboardingStep = 'setup' | 'funds' | 'ready';

export interface FiddySetup {
  /** What the owner called their agent. */
  agentName: string;
  /** Which brain is selected. Everything but 'fiddy' needs the owner's own service. */
  brain: BrainId;
  /** Address of the owner's own AI service, for 'custom'. Never a key. */
  brainServiceUrl: string | null;
  /** Which model of that service, for everything but 'fiddy'. Never a key. */
  brainModel: string | null;
  /** Tool-server address, for builders. Saved, not used yet. */
  toolServerUrl: string | null;
  /** Per-app permission, as the owner last set it. */
  channels: Record<ChannelId, boolean>;
  /** Which wallet the owner chose to pay from. A preference, not a credential. */
  walletChoice: WalletChoiceId;
  /** Set when the last onboarding step was reached; null until then. */
  completedAt: number | null;
  /** The numbered step to offer when the visitor returns. */
  onboardingStep: OnboardingStep | null;
}

export const DEFAULT_AGENT_NAME = 'Fiddy';

const STORAGE_KEY = 'fiddy.setup';

/** Fired on every write so mounted surfaces stay in step with each other. */
export const FIDDY_SETUP_EVENT = 'fiddy:setup';

const CHANNEL_IDS: ChannelId[] = [
  'farcaster',
  'whatsapp',
  'discord',
  'telegram',
  'imessage',
  'email',
];

export const defaultFiddySetup = (): FiddySetup => ({
  agentName: DEFAULT_AGENT_NAME,
  brain: 'fiddy',
  brainServiceUrl: null,
  brainModel: null,
  toolServerUrl: null,
  channels: {
    // Farcaster is the app you are already in, so it starts allowed. The rest
    // start off: a permission nobody asked for is not a permission.
    farcaster: true,
    whatsapp: false,
    discord: false,
    telegram: false,
    imessage: false,
    email: false,
  },
  walletChoice: 'farcaster',
  completedAt: null,
  onboardingStep: null,
});

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Older builds offered 'claude', 'gemini' and 'other'. They are the same
 * choices, named differently, so they are carried over rather than reset: the
 * person who picked Claude meant Claude, and Claude is now a card that works.
 */
const LEGACY_BRAINS: Record<string, BrainId> = {
  claude: 'anthropic',
  gemini: 'google',
  other: 'custom',
};

const asBrain = (value: unknown): BrainId =>
  typeof value === 'string' && (BRAIN_IDS as string[]).includes(value)
    ? (value as BrainId)
    : typeof value === 'string' && LEGACY_BRAINS[value]
      ? LEGACY_BRAINS[value]
      : 'fiddy';

/** A model name we would put back in a field: short, single line, printable. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const asModel = (value: unknown): string | null =>
  typeof value === 'string' && MODEL_NAME.test(value.trim())
    ? value.trim()
    : null;

/**
 * The wallet choice is a preference between two named options; anything else
 * stored by an older build resolves to the default rather than to a third state
 * no surface knows how to render.
 */
const asWalletChoice = (value: unknown): WalletChoiceId =>
  value === 'fresh' ? 'fresh' : 'farcaster';

const asOnboardingStep = (value: unknown): OnboardingStep | null =>
  value === 'setup' || value === 'funds' || value === 'ready' ? value : null;

/**
 * Read, never throw. Stored state from an older build, a half-written value or
 * a disabled storage API all resolve to the defaults rather than an error the
 * owner cannot act on.
 */
/** Only real channels, only booleans: a permission nobody granted is not one. */
const sanitiseChannels = (
  value: unknown,
  fallback: Record<ChannelId, boolean>,
): Record<ChannelId, boolean> => {
  const channels = { ...fallback };
  if (value && typeof value === 'object') {
    for (const id of CHANNEL_IDS) {
      const stored = (value as Record<string, unknown>)[id];
      if (typeof stored === 'boolean') {
        channels[id] = stored;
      }
    }
  }
  return channels;
};

export const loadFiddySetup = (): FiddySetup => {
  const base = defaultFiddySetup();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return base;
    }
    const parsed = JSON.parse(raw) as Partial<FiddySetup> | null;
    if (!parsed || typeof parsed !== 'object') {
      return base;
    }
    return {
      agentName: asString(parsed.agentName) ?? base.agentName,
      brain: asBrain(parsed.brain),
      brainServiceUrl: asString(parsed.brainServiceUrl),
      brainModel: asModel(parsed.brainModel),
      toolServerUrl: asString(parsed.toolServerUrl),
      channels: sanitiseChannels(parsed.channels, base.channels),
      walletChoice: asWalletChoice(parsed.walletChoice),
      completedAt:
        typeof parsed.completedAt === 'number' ? parsed.completedAt : null,
      onboardingStep: asOnboardingStep(parsed.onboardingStep),
    };
  } catch {
    return base;
  }
};

/**
 * Only the fields this file owns are written. A patch is not spread blindly,
 * because that is how a key would end up in local storage the first time a
 * caller passed one by mistake: the setup holds a choice and an address, never a
 * credential.
 */
export const saveFiddySetup = (patch: Partial<FiddySetup>): FiddySetup => {
  const current = loadFiddySetup();
  const next: FiddySetup = {
    agentName:
      typeof patch.agentName === 'string' && patch.agentName.trim()
        ? patch.agentName.trim().slice(0, 24)
        : current.agentName,
    brain: patch.brain === undefined ? current.brain : asBrain(patch.brain),
    brainServiceUrl:
      patch.brainServiceUrl === undefined
        ? current.brainServiceUrl
        : asString(patch.brainServiceUrl),
    brainModel:
      patch.brainModel === undefined
        ? current.brainModel
        : asModel(patch.brainModel),
    toolServerUrl:
      patch.toolServerUrl === undefined
        ? current.toolServerUrl
        : asString(patch.toolServerUrl),
    channels: sanitiseChannels(patch.channels, current.channels),
    walletChoice:
      patch.walletChoice === undefined
        ? current.walletChoice
        : asWalletChoice(patch.walletChoice),
    completedAt:
      typeof patch.completedAt === 'number'
        ? patch.completedAt
        : current.completedAt,
    onboardingStep:
      patch.onboardingStep === undefined
        ? current.onboardingStep
        : asOnboardingStep(patch.onboardingStep),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A browser that refuses to store is not a reason to lose the step.
  }
  window.dispatchEvent(new Event(FIDDY_SETUP_EVENT));
  return next;
};

export const resetFiddySetup = (): FiddySetup => {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to clean up
  }
  window.dispatchEvent(new Event(FIDDY_SETUP_EVENT));
  return defaultFiddySetup();
};

/** Live view of the setup file, kept in sync across mounted surfaces. */
export const useFiddySetup = (): FiddySetup => {
  const [setup, setSetup] = useState<FiddySetup>(() => loadFiddySetup());

  useEffect(() => {
    const read = () => {
      setSetup(loadFiddySetup());
    };
    window.addEventListener(FIDDY_SETUP_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(FIDDY_SETUP_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, []);

  return setup;
};

/** How many apps the owner has turned on, for summary lines. */
export const allowedChannelCount = (setup: FiddySetup): number =>
  CHANNEL_IDS.filter((id) => setup.channels[id]).length;
