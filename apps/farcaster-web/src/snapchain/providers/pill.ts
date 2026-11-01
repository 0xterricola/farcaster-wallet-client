/**
 * What the status pill says, decided in one pure function.
 *
 * The pill is the one piece of chrome that is always on screen, so its words are
 * load-bearing: it must name the server that answered, and — when the engine
 * moved the feed to a different one — say why, in the same plain words a
 * non-technical reader would use. Nothing about providers, failover or
 * measurement belongs in a component; it all lands here as a label and a
 * sentence, and the component's only job is to render them.
 *
 * Two registers, because the pill lives in two places:
 *
 *   short   a phone header, or the collapsed sidebar: one or two words
 *   long    the desktop top bar and the wide sidebar: the story, then the reason
 */

import type { NodeProvider } from './providerTypes';
import type { ProviderRuntimeSnapshot } from './runtime';

/** The visual states the pill already renders (see NodeStatusPill). */
export type ProviderPillState =
  | 'checking'
  | 'served'
  | 'unreachable'
  | 'relay'
  | 'switched';

export interface ProviderPillView {
  state: ProviderPillState;
  /** Dot + one word, for a phone header. */
  shortLabel: string;
  /** The full label for a desktop chrome. */
  label: string;
  /** The sentence a hover (or a screen reader) gets: which server, and why. */
  title: string;
}

/** The plain name of a provider, for a label. */
const nameOf = (provider: NodeProvider): string => {
  switch (provider.kind) {
    case 'neynar':
      return 'Neynar';
    case 'farcaster-public':
      return "Farcaster's own server";
    case 'snapchain':
    default:
      return provider.source === 'own' ? 'the node you run' : 'a public node';
  }
};

const shortNameOf = (provider: NodeProvider): string => {
  switch (provider.kind) {
    case 'neynar':
      return 'Neynar';
    case 'farcaster-public':
      return 'Farcaster';
    case 'snapchain':
    default:
      return provider.source === 'own' ? 'Your own' : 'Public';
  }
};

/**
 * The pill's words for one snapshot.
 *
 * `snapshot.activeId === null` means no check has landed yet, which is
 * `checking` — never a claim about a server nothing has measured.
 */
export const providerPillView = (
  snapshot: ProviderRuntimeSnapshot,
): ProviderPillView => {
  const active =
    snapshot.order.find((provider) => provider.id === snapshot.activeId) ??
    null;

  if (!active) {
    return {
      state: 'checking',
      shortLabel: 'Checking…',
      label: 'Checking your servers…',
      title: 'Asking your servers which one answers best…',
    };
  }

  const health = snapshot.health[active.id];
  const isBackup =
    snapshot.order.findIndex((provider) => provider.id === active.id) > 0;
  const switched = isBackup && snapshot.explanation.length > 0;

  if (health && health.status === 'down' && snapshot.order.length === 1) {
    return {
      state: 'unreachable',
      shortLabel: 'Offline',
      label: `${nameOf(active)} is offline`,
      title: health.detail,
    };
  }

  if (switched) {
    return {
      state: 'switched',
      shortLabel: 'Backup',
      label: snapshot.explanation,
      title: `${snapshot.explanation} Everything you read now comes from ${nameOf(active)}. Open Advanced to change your servers.`,
    };
  }

  const state: ProviderPillState =
    health && health.status !== 'live' && health.status !== 'slow'
      ? 'unreachable'
      : 'served';

  return {
    state,
    shortLabel: shortNameOf(active),
    label: `Answers come from ${nameOf(active)}`,
    title:
      health && health.status !== 'live'
        ? `${health.detail} ${nameOf(active)} is still the one answering. Open Advanced to change your servers.`
        : `Everything you read comes from ${nameOf(active)}. Open it in Advanced.`,
  };
};

/** A failed read, in the pill's register: one line, no jargon. */
export const providerProblemLine = (
  detail: string,
  provider: NodeProvider,
): string => `${detail} ${nameOf(provider)} is still the one answering.`;
