/**
 * The copy set for a profile page's user lookup (the i18n set for this
 * surface — both sentences live here, never inline in a component).
 *
 * Two different facts, two different sentences:
 *
 *   - a 404: the node answered and said nobody holds that handle —
 *     "No one goes by that name.";
 *   - anything else (5xx, a node that never answered, no network): the
 *     account is fine, the server is not — "Farcaster's server is having a
 *     moment, not you." with a retry.
 *
 * Ported in spirit from quilcast 0.61.1 (backmeupplz/quilcast 27c1253, MIT):
 * "a node that is down no longer says your account doesn't exist".
 */
export const PROFILE_LOOKUP_COPY = {
  /** The 404 title, naming the handle that was asked for. */
  notFoundTitle: (username: string) => `@${username} not found on Farcaster`,
  /** The 404 sentence: the node answered, and nobody goes by that name. */
  notFound: 'No one goes by that name.',
  /** The outage title: the reader's account is not the thing that failed. */
  nodeDownTitle: 'Farcaster’s server is having a moment, not you.',
  /**
   * The outage body: what is actually true. The profile is still theirs and
   * still on Farcaster; only the reading of it failed.
   */
  nodeDownBody:
    'Your account is fine. The server that reads it did not answer, so this profile could not be loaded.',
  /** The one action that can change an outage answer. */
  retry: 'Try again',
} as const;
