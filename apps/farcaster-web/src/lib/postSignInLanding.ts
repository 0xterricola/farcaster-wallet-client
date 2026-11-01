/**
 * Where a completed sign-in puts the browser.
 *
 * WHY THIS EXISTS
 * The sign-in modal reboots the app once the handshake completes, so the new
 * session is picked up from a clean boot. Reloading *in place* is right for a
 * deep link — someone who signs in from a notification or a cast permalink
 * should end up back there. It is wrong for the setup flow: the setup screens
 * are reachable signed out by design, and one of them is where "Go social"
 * lives, so an in-place reload re-renders that very screen and the person who
 * just signed in never reaches the client. Measured (see the card this shipped
 * with): the reload after a successful sign-in left the browser on
 * `/welcome/ready` showing "Fiddy is ready." — before and after a second
 * reload.
 *
 * So the answer is a function of where the sign-in was started: from a setup
 * screen, the app's own entry point; from anywhere else, exactly where you
 * already are.
 *
 * This is one half of the fix, and the half that removes the flash.
 * `FiddyOnboardingPage` carries the other half — a signed-in session that
 * arrives on a setup screen by any route (a typed URL, a history entry, a
 * reload) is sent on to the client instead of being shown the setup again.
 */

import { defaultRoute, routes } from '~/constants/routes';

/** The setup flow's screens. Every one of them is reachable signed out. */
const setupPaths: ReadonlySet<string> = new Set<string>([
  routes.fiddyWelcome.path,
  routes.fiddyWelcomeName.path,
  routes.fiddyWelcomeBrain.path,
  routes.fiddyWelcomeApps.path,
  routes.fiddyWelcomeReady.path,
]);

/**
 * The URL to hand to `window.location.replace` when a sign-in completes.
 *
 * `href` is passed in rather than read from `window` so this stays a plain
 * function — it is the one part of the post-sign-in transition that can be
 * pinned by a unit test instead of only by a browser.
 */
const postSignInLocation = ({
  pathname,
  href,
}: {
  pathname: string;
  href: string;
}): string => (setupPaths.has(pathname) ? defaultRoute.path : href);

export { postSignInLocation, setupPaths };
