/**
 * The browser's half of "tell my phone".
 *
 * WHAT THIS DOES NOT DO, first, because those rules shape every line below:
 *
 *   * it never says a plumbing word to the person. The copy is "When someone
 *     replies to you" and "Tell my phone", never push, subscription, endpoint,
 *     VAPID or service worker. A reader who has to learn a word to press a
 *     switch was failed by the switch.
 *   * it never sends the app key. The browser signs a short claim with the key
 *     it already holds (`~/snapchain/appKeyStorage.ts`) and sends the SIGNATURE;
 *     the host checks it against the node. Turning it off is the same proof.
 *   * muted WORDS never leave this device. Only the hidden PEOPLE go up, as
 *     plain numbers, re-sent when the list changes — so a person the reader
 *     hid cannot reach their lock screen. The settings copy says this in one
 *     sentence, because it is the difference between a promise and a surprise.
 *
 * THE CLAIM, byte for byte (it must match `server/alerts/subscribe.mjs`, and a
 * test holds both sides to the same string):
 *
 *     fiddy-alerts-v1
 *     <fid>
 *     <sha256 of the phone's own address, hex>
 *     <when it was made, ms>
 *
 * THE HONEST PATHS: every state a browser can be in gets a sentence, never a
 * silent failure. iOS only delivers to the Home Screen app, so a person on iOS
 * in the browser is told to add it to their Home Screen first (one sentence,
 * not a switch that does nothing); a host that never set itself up answers
 * `not-configured`, and the toggle is simply absent with the reason; a denied
 * permission is the reader's own answer and is respected.
 */

import {
  appKeyFromPrivateKeyHex,
  signBytesWithAppKey,
} from 'farcaster-node-client';

import { loadAppKey } from '~/snapchain/appKeyStorage';
import { getActiveMutes, muteIsLive } from '~/snapchain/mutePreferences';

/** The claim's first line. A new version is a new string, so old claims die. */
export const CLAIM_VERSION = 'fiddy-alerts-v1';

/** The kinds the host derives, in the store's own plural spelling. */
export const ALERT_KINDS = ['mentions', 'replies', 'likes', 'follows'] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertKinds = Record<AlertKind, boolean>;

/** What the host said it can do (or why it cannot). */
export interface AlertsCapability {
  on: boolean;
  reason?: 'not-configured' | 'no-keys';
  publicKey?: string;
  kinds?: string[];
}

/** Why the switch cannot be pressed right now, in the reader's own words. */
export interface AlertsBlock {
  reason:
    | 'unsupported'
    | 'no-permission'
    | 'ios-home-screen'
    | 'no-app-key'
    | 'offered';
  sentence: string;
}

const sha256Hex = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * The exact bytes an app key signs. Mirrored in
 * `server/alerts/subscribe.mjs` `canonicalClaim`, and a unit test holds the two
 * to the same string — a claim the host cannot read is a switch that does
 * nothing, and the reader would never know which side drifted.
 */
export const canonicalClaim = async ({
  fid,
  endpoint,
  issuedAt,
}: {
  fid: number;
  endpoint: string;
  issuedAt: number;
}): Promise<string> =>
  [CLAIM_VERSION, fid, await sha256Hex(endpoint), issuedAt].join('\n');

const isIos = (): boolean =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  // navigator.platform is the honest one on iPadOS (it claims to be Mac).
  (/iPad|iPhone|iPod/.test(navigator.platform ?? '') ||
    (navigator.maxTouchPoints ?? 0) > 1);

const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true);

/** Is Web Push reachable from THIS browser at all? */
const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window;

/**
 * The people this reader has hidden, as numbers, live right now.
 *
 * A person hidden yesterday and a person hidden for an hour both count: the
 * phone is the one surface where a hidden person could reach the reader
 * unlooked-for, so the list sent up is the list in force.
 */
export const mutedFidsInUse = (): number[] => {
  const active = getActiveMutes();
  if (active === null) {
    return [];
  }
  const now = Date.now();
  const fids = new Set<number>();
  for (const group of [active.users, active.blocks]) {
    for (const entry of group) {
      if (muteIsLive(entry, now) && Number.isSafeInteger(entry.v)) {
        fids.add(entry.v);
      }
    }
  }
  return [...fids].slice(0, 5000);
};

/** The host's answer to "can you tell my phone?", or `null` when unreachable. */
export const fetchAlertsCapability = async (
  fetchImpl: typeof fetch = fetch,
): Promise<AlertsCapability | null> => {
  try {
    const response = await fetchImpl('/api/alerts', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const parsed = (await response.json()) as AlertsCapability;
    if (parsed && typeof parsed.on === 'boolean') {
      return parsed;
    }
    return null;
  } catch {
    // Unreachable is not "off": the host may be restarting, and a reader who
    // reloads Settings gets the truth then.
    return null;
  }
};

/** The switch's own sentence for each way it cannot be pressed yet. */
export const blockFor = (kind: AlertsBlock['reason']): AlertsBlock => {
  const sentences: Record<AlertsBlock['reason'], string> = {
    unsupported:
      'This browser cannot be reached when its tab is closed, so it cannot be told anything.',
    'no-permission':
      'You said no to notifications from Fiddy before. Your phone Settings can change that.',
    'ios-home-screen':
      'On iPhone, Fiddy can reach you only from the Home Screen: share this page, choose “Add to Home Screen”, then open Fiddy from there and come back to this switch.',
    'no-app-key':
      'This device holds no key for your account yet. Open “Your own setup”, press “Issue app key” once, then come back here.',
    offered: 'Fiddy will ask your phone for permission when you turn this on.',
  };
  return { reason: kind, sentence: sentences[kind] };
};

/** Which honest state is the browser in, given the host's answer? */
export const assessPhone = async (
  capability: AlertsCapability | null,
  options: { hasAppKey: boolean; permission?: NotificationPermission },
): Promise<AlertsBlock | { ok: true }> => {
  if (!pushSupported()) {
    return blockFor('unsupported');
  }
  // iOS delivers web alerts only to the installed app, and it fails in
  // silence otherwise — so the sentence comes first, not after a dead switch.
  if (isIos() && !isStandalone()) {
    return blockFor('ios-home-screen');
  }
  if (!options.hasAppKey) {
    return blockFor('no-app-key');
  }
  if (options.permission === 'denied') {
    return blockFor('no-permission');
  }
  if (capability === null) {
    // The host did not answer: the switch waits rather than guessing.
    return blockFor('offered');
  }
  if (!capability.on) {
    return capability.reason === 'no-keys'
      ? blockFor('unsupported')
      : blockFor('unsupported');
  }
  return { ok: true };
};

/** A base64url string to the Uint8Array `applicationServerKey` wants. */
export const applicationServerKey = (publicKey: string): BufferSource =>
  Uint8Array.from(
    atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
    (character) => character.charCodeAt(0),
  ) as unknown as BufferSource;

/**
 * Turn it on: the phone's address, signed, to the host that asked for it.
 *
 * @returns the reason sentence instead of throwing — a settings screen shows a
 * sentence, never a stack.
 */
export const turnOnPhoneAlerts = async ({
  fid,
  kinds,
  language,
}: {
  fid: number;
  kinds: AlertKinds;
  language: string;
}): Promise<{ ok: boolean; sentence?: string }> => {
  if (!pushSupported()) {
    return { ok: false, sentence: blockFor('unsupported').sentence };
  }
  const appKeyHex = await loadAppKey(fid);
  if (appKeyHex === null) {
    return { ok: false, sentence: blockFor('no-app-key').sentence };
  }
  if (
    typeof Notification === 'undefined' ||
    Notification.permission === 'denied'
  ) {
    return { ok: false, sentence: blockFor('no-permission').sentence };
  }
  if (Notification.permission !== 'granted') {
    const asked = await Notification.requestPermission();
    if (asked !== 'granted') {
      // The reader's own answer, asked once, in the place the browser chose.
      return { ok: false, sentence: blockFor('no-permission').sentence };
    }
  }
  const capability = await fetchAlertsCapability();
  if (capability === null || !capability.on || !capability.publicKey) {
    return { ok: false, sentence: blockFor('unsupported').sentence };
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(capability.publicKey),
    });
    const endpoint = subscription.endpoint;
    const issuedAt = Date.now();
    const signature = await signBytesWithAppKey(
      appKeyHex,
      new TextEncoder().encode(
        await canonicalClaim({ fid, endpoint, issuedAt }),
      ),
    );
    const { publicKeyHex: signer } = await appKeyFromPrivateKeyHex(appKeyHex);
    const response = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fid,
        signer,
        signature,
        issuedAt,
        subscription: {
          endpoint: subscription.endpoint,
          keys: subscription.toJSON().keys,
        },
        kinds,
        language,
        mutedFids: mutedFidsInUse(),
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        sentence: 'Fiddy could not turn this on. Try again in a minute.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      sentence: 'Fiddy could not turn this on. Try again in a minute.',
    };
  }
};

/**
 * Turn it off: the same proof, the file gone, and the phone's own address
 * retired by the browser so the host cannot reach it again.
 */
export const turnOffPhoneAlerts = async ({
  fid,
}: {
  fid: number;
}): Promise<{ ok: boolean; sentence?: string }> => {
  const appKeyHex = await loadAppKey(fid);
  if (appKeyHex === null) {
    return { ok: false, sentence: blockFor('no-app-key').sentence };
  }
  try {
    const registration =
      await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
  } catch {
    // The phone's half is best-effort here; the host's half is the switch.
  }
  try {
    const issuedAt = Date.now();
    const signature = await signBytesWithAppKey(
      appKeyHex,
      new TextEncoder().encode(
        await canonicalClaim({ fid, endpoint: 'off', issuedAt }),
      ),
    );
    const { publicKeyHex: signer } = await appKeyFromPrivateKeyHex(appKeyHex);
    const response = await fetch('/api/alerts/off', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fid, signer, signature, issuedAt }),
    });
    if (!response.ok) {
      return {
        ok: false,
        sentence: 'Fiddy could not turn this off. Try again in a minute.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      sentence: 'Fiddy could not turn this off. Try again in a minute.',
    };
  }
};

/** Is there a live subscription for this browser right now? */
export const phoneAlertsOn = async (): Promise<boolean> => {
  try {
    const registration =
      await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    return subscription !== undefined && subscription !== null;
  } catch {
    return false;
  }
};
