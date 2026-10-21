/**
 * The setup this browser holds for Fiddy: what your agent is called, which
 * brain it uses, and which apps you have let it touch.
 *
 * Deliberately local. There is no Fiddy account to create and no server this is
 * sent to; it is a preference file, so someone can leave a step and come back
 * without re-answering. It is also the only reason the onboarding can offer
 * "skip for now" honestly.
 *
 * What must NOT live here: any provider key. The one credential this client can
 * hold — the session key for an agent service you run yourself — belongs to
 * `~/lib/agentService` and is stored by that module alone. This file keeps the
 * service *address* and nothing else.
 */

import { useEffect, useState } from 'react';

import type { WalletChoiceId } from '~/lib/surp/walletChoice';

export type BrainId = 'fiddy' | 'claude' | 'gemini' | 'surp' | 'other';

export type ChannelId =
  | 'farcaster'
  | 'whatsapp'
  | 'discord'
  | 'telegram'
  | 'imessage'
  | 'email';

export interface FiddySetup {
  /** What the owner called their agent. */
  agentName: string;
  /** Which brain is selected. 'fiddy', 'surp' and 'other' are wired today. */
  brain: BrainId;
  /** Address of the agent service behind 'other'. Never a key. */
  brainServiceUrl: string | null;
  /** Tool-server address, for builders. Saved, not used yet. */
  toolServerUrl: string | null;
  /** Per-app permission, as the owner last set it. */
  channels: Record<ChannelId, boolean>;
  /** Which wallet the owner chose to pay from. A preference, not a credential. */
  walletChoice: WalletChoiceId;
  /** Set when the last onboarding step was reached; null until then. */
  completedAt: number | null;
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
});

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asBrain = (value: unknown): BrainId =>
  value === 'claude' || value === 'gemini' || value === 'surp' || value === 'other'
    ? value
    : 'fiddy';

/**
 * The wallet choice is a preference between two named options; anything else
 * stored by an older build resolves to the default rather than to a third state
 * no surface knows how to render.
 */
const asWalletChoice = (value: unknown): WalletChoiceId =>
  value === 'fresh' ? 'fresh' : 'farcaster';

/**
 * Read, never throw. Stored state from an older build, a half-written value or
 * a disabled storage API all resolve to the defaults rather than an error the
 * owner cannot act on.
 */
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
    const channels = { ...base.channels };
    const storedChannels = parsed.channels;
    if (storedChannels && typeof storedChannels === 'object') {
      for (const id of CHANNEL_IDS) {
        const value = (storedChannels as Record<string, unknown>)[id];
        if (typeof value === 'boolean') {
          channels[id] = value;
        }
      }
    }
    return {
      agentName: asString(parsed.agentName) ?? base.agentName,
      brain: asBrain(parsed.brain),
      brainServiceUrl: asString(parsed.brainServiceUrl),
      toolServerUrl: asString(parsed.toolServerUrl),
      channels,
      walletChoice: asWalletChoice(parsed.walletChoice),
      completedAt:
        typeof parsed.completedAt === 'number' ? parsed.completedAt : null,
    };
  } catch {
    return base;
  }
};

export const saveFiddySetup = (patch: Partial<FiddySetup>): FiddySetup => {
  const next: FiddySetup = { ...loadFiddySetup(), ...patch };
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
