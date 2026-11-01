// Does the host's own mini app wire serve the frame it opened, and only it?
//
//   cd apps/farcaster-web
//   npx vite --config scripts/probe.vite.config.mjs --port 5311 --strictPort --host
//   PROBE_SERVER=https://localhost:5311 PROBE_APP_ORIGIN=https://127.0.0.1:5311 \
//     node scripts/verify-miniapp-wire.mjs
//
// The two names are not decoration: `localhost` and `127.0.0.1` are different
// origins, which is what makes the frames in this probe real cross-origin
// frames. Pick a port nothing else is listening on — several cards run dev
// servers on this machine, and one that has `[::1]` bound answers `localhost`
// before this one does.
// What this measures, in a real browser, with the real packages — this repo's
// own `@farcaster/miniapp-host` exposing the SDK, the client's own
// `@farcaster/miniapp-sdk` calling it across comlink, over two real
// cross-origin frames (the page is served from one origin, the frames from
// another, which is the shape a real Mini App has):
//
//   A. THE HOLE, as it was: with the wire built the way card t_c39bf6da found it
//      (no gate, `miniAppOrigin: '*'`), a frame that is NOT the mini app drives
//      the host's own members — `ready()` fires and that frame gets an answer.
//   B. THE FIX: with this repo's wire (the frame's window object AND the origin
//      it was launched with), the same call from the same frame drives nothing
//      and comes back with nothing at all — no error, no refusal, no reply.
//   C. THE FRAME THAT MATTERS: the mini app's own frame still reads `context`
//      from the host, still calls `ready` and `composeCast`, and gets its
//      answers — so the pin is not a wire that stopped working.
//   D. A DIFFERENT ORIGIN: the mini app's own frame, against a wire pinned to
//      an origin that is not its own, drives nothing.
//   E. A PIN THAT IS NOT AN ORIGIN (`'*'`): nothing is answered, not even for
//      the mini app's own frame — a blank check is not a check.
//
// The two frames are the same page on purpose: B and D differ only in what the
// host pinned, so what refuses them is the pin and not the frame.
//
// Nothing here touches a network service, spends a credit, or signs anything.

import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const SERVER = process.env.PROBE_SERVER ?? 'https://localhost:5311';
const APP_ORIGIN = process.env.PROBE_APP_ORIGIN ?? 'https://127.0.0.1:5311';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

const sleep = (ms) => delay(ms);

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});

const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text().slice(0, 200));
  }
});
page.on('pageerror', (error) =>
  consoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`),
);

/** The two frames are cross-origin to the page, so they are reached by URL. */
const frameFor = (role) =>
  page.frames().find((frame) => frame.url().includes(`role=${role}`));

const url = new URL('/scripts/probe-miniapp-wire.html', SERVER);
url.searchParams.set('app', APP_ORIGIN);

await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });

/** Both frames loaded, and the page really is another origin than they are. */
const awaitFrames = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const host = await page.evaluate(() => window.__wireProbe.frames());
    const miniapp = frameFor('miniapp');
    const foreign = frameFor('foreign');
    if (host.miniAppReady && host.foreignReady && miniapp && foreign) {
      try {
        await miniapp.evaluate(() => true);
        await foreign.evaluate(() => true);
        return { ...host, miniapp, foreign };
      } catch {
        // The frame document is still coming up.
      }
    }
    await sleep(500);
  }
  return undefined;
};

const mount = (mode, pin) =>
  page.evaluate(
    ([m, p]) => window.__wireProbe.mount(m, p ?? undefined),
    [mode, pin ?? null],
  );

const resetCalls = () => page.evaluate(() => window.__wireProbe.resetCalls());

const hostCalls = () => page.evaluate(() => window.__wireProbe.readCalls());

/** Every message that reached the host window, with both identity answers. */
const hostMessages = () =>
  page.evaluate(() => window.__wireProbe.readMessages());

const appCall = async (role, name) => {
  const frame = frameFor(role);
  // Fire and forget: a refused call never settles, so awaiting it here would
  // hang the probe instead of measuring the silence.
  await frame.evaluate((n) => {
    void window.__appCall(n);
    return true;
  }, name);
};

const appState = (role) =>
  frameFor(role).evaluate(() => ({
    state: window.__appState(),
    log: window.__appLog(),
  }));

// ---------------------------------------------------------------------------
console.log('\n0. the probe is up, both frames are up');
// ---------------------------------------------------------------------------
const frames = await awaitFrames();

check('0a both frames have a window', Boolean(frames));
check(
  '0b the frames really are another origin than the page',
  Boolean(frames) && frames.hostOrigin !== frames.appOrigin,
  frames ? `page=${frames.hostOrigin} frames=${frames.appOrigin}` : '',
);

// ---------------------------------------------------------------------------
console.log('\nA. the wire as it was (no gate, miniAppOrigin: "*")');
// ---------------------------------------------------------------------------
await mount('legacy');
await resetCalls();
await appCall('foreign', 'ready');
await sleep(1500);

const legacyCalls = await hostCalls();
const legacyForeign = await appState('foreign');

check(
  'A1 a frame that is NOT the mini app drove the host’s own ready()',
  legacyCalls.includes('ready'),
  `host calls: ${JSON.stringify(legacyCalls)}`,
);
check(
  'A2 …and the answer went to the mini app’s window, so that frame got nothing back',
  // The documented limit of the hole: a foreign frame can *drive* the host's
  // members, but the reply is posted to `iframe.contentWindow`, which it does
  // not own. This is why the hole is an action-primitive and not a read.
  legacyForeign.state.ready === 'pending' && legacyForeign.log.length === 0,
  `foreign frame state: ${JSON.stringify(legacyForeign.state)}`,
);

// ---------------------------------------------------------------------------
console.log('\nB. the wire this card ships (frame window + launched origin)');
// ---------------------------------------------------------------------------
await mount('gated');
await resetCalls();
await appCall('foreign', 'ready');
await sleep(1500);

const gatedCalls = await hostCalls();
const gatedForeign = await appState('foreign');
const gatedMessages = await hostMessages();

check(
  'B1 the message arrived at the host window, from that very frame, and drove nothing',
  // Both halves, so a refusal cannot be mistaken for a message that never made
  // it: the browser says `event.source` is that frame's window and the origin
  // is the app's own, and the gate still refuses it — because the frame is not
  // the one the host opened.
  gatedCalls.length === 0 &&
    gatedMessages.some(
      (message) => message.fromForeign && message.origin === APP_ORIGIN,
    ),
  `host calls: ${JSON.stringify(gatedCalls)} messages: ${JSON.stringify(gatedMessages)}`,
);
check(
  'B2 and got no reply — not an error, not a refusal, nothing',
  gatedForeign.state.ready === 'pending' && gatedForeign.log.length === 0,
  `foreign frame state: ${JSON.stringify(gatedForeign.state)}`,
);

// ---------------------------------------------------------------------------
console.log('\nC. the mini app’s own frame still works');
// ---------------------------------------------------------------------------
await resetCalls();
await appCall('miniapp', 'context');
await appCall('miniapp', 'ready');
await appCall('miniapp', 'composeCast');
await sleep(1500);

const appCalls = await hostCalls();
const miniApp = await appState('miniapp');

check(
  'C1 the host read out the context the app asked for',
  miniApp.state.context === 'answered' &&
    miniApp.log.some((line) => line.startsWith('context fid=191554')),
  `app log: ${JSON.stringify(miniApp.log)}`,
);
check(
  'C2 ready() and composeCast() reached the host from the right frame',
  appCalls.includes('ready') && appCalls.includes('composeCast'),
  `host calls: ${JSON.stringify(appCalls)}`,
);
check(
  'C3 composeCast came back to the frame with the host’s answer',
  miniApp.state.composeCast === 'answered' &&
    miniApp.log.some((line) => line.includes('0xprobe')),
  `app log: ${JSON.stringify(miniApp.log)}`,
);

// ---------------------------------------------------------------------------
console.log('\nD. the same frame, against a pin that is not its origin');
// ---------------------------------------------------------------------------
await mount('gated', 'https://not-this-frame.example');
await resetCalls();
await appCall('miniapp', 'ready');
await sleep(1500);

const wrongPinCalls = await hostCalls();
const wrongPinApp = await appState('miniapp');

check(
  'D1 the mini app’s own frame was refused for its origin',
  wrongPinCalls.length === 0 && wrongPinApp.state.ready === 'pending',
  `host calls: ${JSON.stringify(wrongPinCalls)} state=${wrongPinApp.state.ready}`,
);

// ---------------------------------------------------------------------------
console.log('\nE. a pin that is not an origin is not a check');
// ---------------------------------------------------------------------------
await mount('gated', '*');
await resetCalls();
await appCall('miniapp', 'ready');
await sleep(1500);

const wildcardCalls = await hostCalls();

check(
  'E1 nothing is answered when the pin is "*"',
  wildcardCalls.length === 0,
  `host calls: ${JSON.stringify(wildcardCalls)}`,
);

await context.close();
await browser.close();

const failed = checks.filter((entry) => !entry.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed`,
);
if (consoleErrors.length) {
  console.log(`page errors seen: ${JSON.stringify(consoleErrors.slice(0, 5))}`);
}

if (failed.length) {
  console.log('\nFAILED:');
  for (const entry of failed) {
    console.log(`  - ${entry.name}: ${entry.detail}`);
  }
  process.exit(1);
}
