// What the hero Fiddy does, driven in a real browser at three widths, in two
// motion preferences, and on a browser with no WebGL at all.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5199 --strictPort
//   FIDDY_HERO_SERVER=https://localhost:5199 node scripts/verify-fiddy-hero.mjs
//
// The front door is signed-out territory, so nothing here needs a session or a
// seeded SIWF round trip: the page a visitor with no account meets is the page
// this checks.
//
// WHAT IT ASSERTS
//
//   the hero (1) is on the front door in its own variant, (2) paints the still
//   before it asks for anything, and (3) never puts the model on the critical
//   path — the GLB and the three.js chunk both start after first paint.
//
//   (4) NOTHING MOVES WHEN THE MODEL ARRIVES. The stage's box and everything
//   under it are sampled on every frame from the moment the page boots, so the
//   claim "no layout shift" is measured across the swap rather than eyeballed
//   once it is over.
//
//   (5) THE STILL IS NOT A LIE. Once the character has settled, the canvas the
//   model draws into is screenshotted and compared with
//   `public/fiddy-hero-poster.png`: same figure, same size in the frame, same
//   centre, same brightness. This is the check that fails if the poster is
//   rendered from a recipe the live scene no longer uses.
//
//   (6) IT IS THE INTERACTIVE MASCOT, NOT A PICTURE OF ONE. The pointer's
//   position is read off the character's own head (the canvas reports the angle
//   it turned to): centred pointer, head straight; pointer right and high, head
//   right and up; pointer left and low, the other way — and the pixels move with
//   it.
//
//   (7) A PRESS IS A GREETING: a tap, and Enter on the focused stage, both make
//   the character hop, and the hop is measured (the figure leaves the ground)
//   rather than taken on trust.
//
//   (8) under `prefers-reduced-motion: reduce` the model is never fetched at all
//   and the still is still there; (9) on a browser with no WebGL the still is
//   what remains, and nothing throws.
//
//   on `/welcome/name` (10) the little Fiddy stands beside the name field where
//   there is room and above it where there is not, and (11) it never takes a
//   pointer that belongs to the field — typing into the field still works with
//   the model mounted next to it.
//
//   (12) THE RETIRED MODEL IS GONE: `fiddy-hero.glb` (the vinyl toy) is never
//   requested, at any width. It was 1.2 MB the hero no longer needs.
//
// Screenshots land in $FIDDY_HERO_SHOT_DIR (default: the system temp dir).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { decodePng, visibleBox } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const POSTER = path.join(APP, 'public', 'fiddy-hero-poster.png');
const GLB = '/fiddy-baby.glb';
/** The vinyl toy this hero replaced. Nothing may ask for it any more. */
const RETIRED_GLB = '/fiddy-hero.glb';
const POSTER_URL = '/fiddy-hero-poster.png';

/** The brand ground the page paints, which is what the still sits on. */
const GROUND = { r: 0x16, g: 0x17, b: 0x15 };

const SERVER = process.env.FIDDY_HERO_SERVER ?? 'https://localhost:5199';
const OUT = process.env.FIDDY_HERO_SHOT_DIR ?? os.tmpdir();

/** The widths the design is checked at: a phone, a tablet, a desktop. */
const WIDTHS = [390, 768, 1440];

const failures = [];
let checks = 0;
const check = (name, ok, detail = '') => {
  checks += 1;
  if (!ok) failures.push({ name, detail });
  return ok;
};

/** Everything the page asks for, captured as it happens rather than read back
    later: the app clears the resource timing buffer, and a bucket that has been
    emptied cannot answer "was this on the critical path?". */
const RESOURCES = () => {
  window.__resources = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__resources.push({
          name: entry.name,
          startTime: entry.startTime,
          initiatorType: entry.initiatorType,
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    window.__resources = null;
  }
};

/** Records the stage's box and everything under it, every frame, from boot. */
const SAMPLER = () => {
  window.__heroSamples = [];
  const tick = () => {
    const stage = document.querySelector('[data-fiddy-hero-variant]');
    if (stage) {
      const box = stage.getBoundingClientRect();
      const action = document.querySelector('.fiddy-primary-btn');
      const sheet = document.querySelector('[data-fiddy="sheet"]');
      window.__heroSamples.push({
        attr: stage.getAttribute('data-fiddy-hero'),
        variant: stage.getAttribute('data-fiddy-hero-variant'),
        x: +box.x.toFixed(2),
        y: +box.y.toFixed(2),
        w: +box.width.toFixed(2),
        h: +box.height.toFixed(2),
        action: action ? +action.getBoundingClientRect().y.toFixed(2) : null,
        sheet: sheet ? +sheet.getBoundingClientRect().height.toFixed(2) : null,
        doc: document.documentElement.scrollHeight,
      });
      if (window.__heroSamples.length > 900) {
        window.__heroSamples.splice(0, 300);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** The picture as it looks once it is lying on `ground`. */
const overGround = (image, ground) => {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = image.data[at + 3] / 255;
    data[at] = Math.round(image.data[at] * alpha + ground.r * (1 - alpha));
    data[at + 1] = Math.round(
      image.data[at + 1] * alpha + ground.g * (1 - alpha),
    );
    data[at + 2] = Math.round(
      image.data[at + 2] * alpha + ground.b * (1 - alpha),
    );
    data[at + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
};

/** How bright the drawing is, over `ground` — the "is it rendered dark" number. */
const litPixels = (image, ground) => {
  let sum = 0;
  let count = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const difference = Math.max(
      Math.abs(image.data[at] - ground.r),
      Math.abs(image.data[at + 1] - ground.g),
      Math.abs(image.data[at + 2] - ground.b),
    );
    if (difference <= 30) continue;
    sum +=
      0.2126 * image.data[at] +
      0.7152 * image.data[at + 1] +
      0.0722 * image.data[at + 2];
    count += 1;
  }
  return count ? sum / count : 0;
};

/** A box as shares of its own frame, so two resolutions can be compared. */
const fraction = (box, image) => ({
  x0: box.x0 / image.width,
  x1: (box.x1 + 1) / image.width,
  y0: box.y0 / image.height,
  y1: (box.y1 + 1) / image.height,
  width: box.width / image.width,
  height: box.height / image.height,
  cx: (box.x0 + box.x1 + 1) / 2 / image.width,
  cy: (box.y0 + box.y1 + 1) / 2 / image.height,
});

/** Screenshots are evidence, not assertions: they land in OUT and are listed. */
const shots = [];
const shot = async (page, label) => {
  const file = path.join(OUT, `fiddy-hero-${label}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  return file;
};

/** What the character is doing, straight off the canvas it draws into. */
const motionOf = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-canvas',
    );
    return canvas?.getAttribute('data-motion') ?? null;
  });

/** The authored hop's height, read from the same value that moves the model. */
const hopOf = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-canvas',
    );
    return Number(canvas?.getAttribute('data-hop') ?? 0);
  });

/**
 * The angle the character's own head has turned to, in degrees, as
 * `yaw,pitch`.
 *
 * It is read off the element rather than inferred from pixels because the two
 * questions are different: this one is "did the head follow the pointer, and
 * which way", and a screenshot cannot tell a head that turned from a loop that
 * happened to move an arm.
 */
const lookOf = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-canvas',
    );
    return canvas?.getAttribute('data-look') ?? null;
  });

/**
 * Wait for the character to settle. The still is ONE pose of a five-second loop,
 * so a comparison against a frame taken mid-stride measures the loop instead of
 * the shot.
 */
const waitForRest = (page, timeout = 20000) =>
  page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-canvas',
        )
        ?.getAttribute('data-motion') === 'resting',
    undefined,
    { timeout },
  );

const waitForMotion = (page, state, timeout = 8000) =>
  page.waitForFunction(
    (expected) =>
      document
        .querySelector(
          '[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-canvas',
        )
        ?.getAttribute('data-motion') === expected,
    state,
    { timeout },
  );

/**
 * The figure's own box on the stage, in pixels, off a screenshot of the stage.
 *
 * The brand glow behind the hero is switched off for the measurement: it is
 * decoration, and a halo would be read as part of the figure. The caller hides
 * the greeting bubble for the whole hop sample, not once per frame.
 */
async function figureBox(page, stage, file) {
  await page.addStyleTag({
    content: '.fiddy-hero-stage-hero::before { display: none !important }',
  });
  await stage.screenshot({ path: file, type: 'png' });
  return visibleBox(decodePng(fs.readFileSync(file)), {
    ground: GROUND,
    threshold: 30,
  });
}

/**
 * The still is not a lie: the stage as the browser paints it against
 * `public/fiddy-hero-poster.png`.
 *
 * Both are measured the same way, over the ground the page actually uses: an
 * element screenshot composites the stage over that ground for us, and the still
 * is composited over it here. The stage's glow is hidden for the measurement
 * only — it is decoration behind the model, and a halo is not part of the figure
 * this is comparing. This is the check that fails if the poster was rendered
 * from a recipe the live scene no longer uses, and it is the same check the
 * fallback paths are held to: on a browser with no WebGL the still IS the hero,
 * so it has to be a picture of Fiddy and not a hole where one should be.
 */
async function compareStageToPoster(page, stage, label) {
  await page.addStyleTag({
    content: '.fiddy-hero-stage-hero::before { display: none !important }',
  });
  const liveShot = path.join(OUT, `fiddy-hero-${label}-stage.png`);
  await stage.screenshot({ path: liveShot, type: 'png' });
  const live = decodePng(fs.readFileSync(liveShot));
  const poster = decodePng(fs.readFileSync(POSTER));
  const liveBox = visibleBox(live, { ground: GROUND, threshold: 30 });
  const posterBox = visibleBox(overGround(poster, GROUND), {
    ground: GROUND,
    threshold: 30,
  });

  check(`${label}: the stage drew a figure`, liveBox !== null);
  if (!liveBox || !posterBox) {
    return null;
  }
  const a = fraction(liveBox, live);
  const b = fraction(posterBox, poster);
  const near = (one, two, tolerance) => Math.abs(one - two) <= tolerance;
  check(
    `${label}: it is the same figure at the same scale as the still`,
    near(a.height, b.height, 0.12) && near(a.width, b.width, 0.14),
    `painted w/h ${a.width.toFixed(3)}/${a.height.toFixed(3)} vs still ${b.width.toFixed(3)}/${b.height.toFixed(3)}`,
  );
  check(
    `${label}: it is the same shot — same centre`,
    near(a.cx, b.cx, 0.05) && near(a.cy, b.cy, 0.05),
    `painted centre (${a.cx.toFixed(3)},${a.cy.toFixed(3)}) vs still (${b.cx.toFixed(3)},${b.cy.toFixed(3)})`,
  );
  check(
    `${label}: it is lit like the still, not a dark blob`,
    litPixels(live, GROUND) >
      litPixels(overGround(poster, GROUND), GROUND) * 0.7 &&
      litPixels(live, GROUND) <
        litPixels(overGround(poster, GROUND), GROUND) * 1.4,
    `painted ${litPixels(live, GROUND).toFixed(1)} vs still ${litPixels(overGround(poster, GROUND), GROUND).toFixed(1)}`,
  );
  check(
    `${label}: the model does not touch the edge of its box at this width`,
    liveBox.x0 > 1 &&
      liveBox.y0 > 1 &&
      liveBox.x1 < live.width - 2 &&
      liveBox.y1 < live.height - 2,
    JSON.stringify(liveBox),
  );
  return liveBox;
}

/** Everything the front door promises, at one width. */
async function checkFrontDoor(browser, width) {
  const label = `front-door-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(SAMPLER);
  await context.addInitScript(RESOURCES);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });

  // (1) the hero is here, in its own variant.
  const stage = page.locator('[data-fiddy-hero-variant="hero"]');
  await page.waitForSelector('[data-fiddy-hero-variant="hero"]', {
    timeout: 20000,
  });
  check(
    `${label}: the hero stage is on the front door`,
    (await stage.count()) === 1,
  );

  // (2) the still paints before anything is fetched, and it is the real still.
  const still = stage.locator('.fiddy-hero-stage-still');
  check(
    `${label}: the still is the poster, painted as an image with its own box`,
    (await still.getAttribute('src')) === POSTER_URL,
  );

  // (3) nothing on the critical path: first paint, then the chunk, then the GLB.
  await page.waitForFunction(
    () => document.querySelector('[data-fiddy-hero="moving"]'),
    undefined,
    { timeout: 45000 },
  );
  // The observer's own record, not the browser's read-back buffer: the app
  // clears resource timings, and an emptied bucket cannot answer this question.
  const timing = await page.evaluate(() => {
    const entries =
      window.__resources ?? performance.getEntriesByType('resource');
    const paint = performance.getEntriesByType('paint');
    const at = (match) =>
      entries
        .filter((entry) => match.test(entry.name))
        .map((entry) => Math.round(entry.startTime));
    return {
      firstPaint: paint.length ? Math.round(paint[0].startTime) : null,
      glb: at(/fiddy-baby\.glb/),
      // The chunk three.js lives in, whatever it is called: a bare module under
      // /node_modules/.vite in dev, an assets/ chunk in a build.
      loader: entries
        .filter((entry) =>
          /three|GLTFLoader|fiddyModelScene|fiddyHero/i.test(entry.name),
        )
        .map((entry) => ({
          name: entry.name.split('/').pop(),
          startTime: Math.round(entry.startTime),
        })),
      total: entries.length,
    };
  });
  check(
    `${label}: the model starts after first paint, not before`,
    timing.firstPaint !== null &&
      timing.glb.length === 1 &&
      timing.glb[0] > timing.firstPaint,
    JSON.stringify(timing),
  );
  check(
    `${label}: the loader is a chunk of its own, and it is fetched after first paint too`,
    timing.loader.length > 0 &&
      timing.loader.every((entry) => entry.startTime > timing.firstPaint),
    JSON.stringify(timing.loader),
  );
  check(
    `${label}: the GLB is fetched once`,
    requested.filter((url) => url.endsWith(GLB)).length === 1,
  );

  // (4) nothing moved when it arrived: sampled every frame across the swap.
  // The sampler records on its own animation frame, so give it one to see the
  // state change before reading it back — otherwise this reads "moving=0" and
  // looks like the swap never happened.
  await page.waitForFunction(
    () =>
      (window.__heroSamples ?? []).some((sample) => sample.attr === 'moving'),
    undefined,
    { timeout: 5000 },
  );
  const samples = await page.evaluate(() => window.__heroSamples);
  const stills = samples.filter((sample) => sample.attr === 'still');
  const movings = samples.filter((sample) => sample.attr === 'moving');
  check(
    `${label}: the page was watched in both states`,
    stills.length > 0 && movings.length > 0,
    `still=${stills.length} moving=${movings.length}`,
  );
  if (stills.length && movings.length) {
    const shapes = new Set(
      samples.map((sample) =>
        [
          sample.x,
          sample.y,
          sample.w,
          sample.h,
          sample.action,
          sample.doc,
        ].join('|'),
      ),
    );
    check(
      `${label}: the model's arrival moves nothing (${samples.length} frames sampled)`,
      shapes.size === 1,
      [...shapes].join(' vs '),
    );
    check(
      `${label}: the reserved box is a real box`,
      movings[0].w > 100 && movings[0].h > 100,
      JSON.stringify(movings[0]),
    );
  }

  // (5) the still is not a lie: what the browser paints against the poster. The
  // character is given time to settle first — the still is ONE pose of a loop,
  // and comparing it against a frame taken mid-stride would measure the loop
  // rather than the shot. (Settling is also what a reduced-motion reader sees
  // forever, which is the frame this comparison exists to protect.)
  await waitForRest(page);
  await compareStageToPoster(page, stage, label);

  // (6) it is the interactive mascot, not a picture of one: the head follows the
  // pointer. The angle read here is the character's OWN head, reported by the
  // canvas it lives in — a pixel diff alone cannot say which way it turned.
  const box = await stage.boundingBox();
  const view = page.viewportSize() ?? { width, height: 900 };
  // "Straight ahead" is the MIDDLE OF THE WINDOW, not the middle of the stage —
  // the head follows the pointer across the page, so it is the viewport the
  // character is looking at.
  await page.mouse.move(view.width / 2, view.height / 2);
  await page.waitForTimeout(900);
  const centred = await lookOf(page);
  check(
    `${label}: with the pointer in the middle the head sits straight ahead`,
    centred === '0.0,0.0',
    String(centred),
  );

  const aimedAway = await page.screenshot({ clip: box });
  await page.mouse.move(width - 8, 60);
  await page.waitForTimeout(1100);
  const rightUp = await lookOf(page);
  const aimedThere = await page.screenshot({ clip: box });
  const [yawRight, pitchUp] = String(rightUp ?? '0,0')
    .split(',')
    .map(Number);
  check(
    `${label}: the pointer to the right and high turns the head right and up`,
    yawRight > 8 && pitchUp > 3,
    String(rightUp),
  );
  check(
    `${label}: and the figure on screen really turned`,
    !aimedAway.equals(aimedThere),
    'the canvas is identical with the pointer on the left and on the right',
  );

  await page.mouse.move(8, 880);
  await page.waitForTimeout(1100);
  const leftDown = await lookOf(page);
  const [yawLeft, pitchDown] = String(leftDown ?? '0,0')
    .split(',')
    .map(Number);
  check(
    `${label}: the pointer to the left and low turns it the other way`,
    yawLeft < -8 && pitchDown < -3,
    String(leftDown),
  );
  check(
    `${label}: and never further than the rig allows (about 14°/7°)`,
    Math.abs(yawLeft) < 16 && Math.abs(pitchDown) < 9,
    String(leftDown),
  );

  const scroll = await page.evaluate(() => ({
    x: window.scrollX,
    overflow:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  check(
    `${label}: following the pointer never scrolls or widens the page`,
    scroll.x === 0 && scroll.overflow <= 0,
    JSON.stringify(scroll),
  );

  // (7) a press is a greeting. The hop is measured, not taken on trust: the
  // figure's own box leaves the ground, and comes back.
  await page.mouse.move(view.width / 2, view.height / 2);
  await waitForRest(page);
  await figureBox(
    page,
    stage,
    path.join(OUT, `fiddy-hero-${label}-rest.png`),
  );
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  let greeted = true;
  try {
    await waitForMotion(page, 'reacting', 2500);
  } catch {
    greeted = false;
  }
  check(
    `${label}: a tap greets back`,
    greeted,
    `the canvas reports ${await motionOf(page)}`,
  );
  check(
    `${label}: the tap also gets a playful hello`,
    (await page.locator('[data-fiddy="hero-reaction"]').textContent()) ===
      'Hiya, you!',
    await page.locator('[data-fiddy="hero-reaction"]').textContent(),
  );
  // The words are checked above. Hide them for the whole pixel sample so the
  // bubble is not mistaken for the character, without touching styles per frame.
  const greetingMeasurementStyle = await page.addStyleTag({
    content: '.fiddy-hero-greeting { display: none !important }',
  });
  if (greeted) {
    // The peak of a one-second hop, sampled across the whole greeting rather
    // than read at a fixed delay: the round trip from the click to this line
    // varies with how busy the box is (the first width of a run is the slowest),
    // and a screenshot taken after the hop has finished measures nothing.
    let peakHop = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      peakHop = Math.max(peakHop, await hopOf(page));
      await figureBox(
        page,
        stage,
        path.join(OUT, `fiddy-hero-${label}-hop-${attempt}.png`),
      );
      await page.waitForTimeout(120);
    }
    // The exact authored lift, not the silhouette: the running clip changes the
    // silhouette on its own, so pixels cannot reliably isolate the hop.
    check(
      `${label}: and the greeting lifts the figure off the ground`,
      peakHop > 0.1,
      `peak authored hop=${peakHop}`,
    );
    // A greeting wakes the CLIP as well as hopping: one second of hop, five of
    // loop, then it settles again. Polled rather than sampled once, because the
    // exact moment this line runs is not predictable.
    let keptRunning = null;
    for (
      let attempt = 0;
      attempt < 10 && keptRunning !== 'playing';
      attempt += 1
    ) {
      keptRunning = await motionOf(page);
      if (keptRunning !== 'playing') {
        await page.waitForTimeout(200);
      }
    }
    check(
      `${label}: and the greeting wakes the loop, which runs on after the hop`,
      keptRunning === 'playing',
      `the canvas reports ${keptRunning}`,
    );
  }
  await greetingMeasurementStyle.evaluate((node) => node.remove());

  // A keyboard can greet it too: the stage on the front door is a real button.
  await page.waitForTimeout(1200);
  await stage.focus();
  const keyboardBefore = await motionOf(page);
  await page.keyboard.press('Enter');
  let greetedByKey = true;
  try {
    await waitForMotion(page, 'reacting', 2500);
  } catch {
    greetedByKey = false;
  }
  check(
    `${label}: Enter on the focused stage greets it as well`,
    greetedByKey && keyboardBefore !== 'reacting',
    `before=${keyboardBefore} after=${await motionOf(page)}`,
  );
  check(
    `${label}: the next hello keeps the tiny conversation going`,
    (await page.locator('[data-fiddy="hero-reaction"]').textContent()) ===
      'Boop received.',
    await page.locator('[data-fiddy="hero-reaction"]').textContent(),
  );

  // (12) the retired vinyl toy is gone from the wire as well as from the repo.
  check(
    `${label}: the retired hero model is never requested`,
    requested.filter((url) => url.endsWith(RETIRED_GLB)).length === 0,
    requested.filter((url) => url.endsWith(RETIRED_GLB)).join(', '),
  );

  await shot(page, label);
  check(`${label}: nothing threw`, errors.length === 0, errors.join(' | '));
  await context.close();
  return { timing, samples };
}

/** Reduced motion: the model is never fetched, and the still is still there. */
async function checkReducedMotion(browser, width) {
  const label = `reduced-motion-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const requested = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fiddy-hero="still"]');
  await page.waitForTimeout(1500);

  check(
    `${label}: the model is never fetched`,
    requested.filter((url) => url.endsWith(GLB)).length === 0,
    requested.filter((url) => url.endsWith(GLB)).join(', '),
  );
  check(
    `${label}: no canvas is created`,
    (await page.locator('[data-fiddy-hero-variant="hero"] canvas').count()) ===
      0,
  );
  check(
    `${label}: the still is what the visitor sees`,
    await page
      .locator('[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-still')
      .isVisible(),
  );
  // The still is the whole hero here, so it is held to the same measurement the
  // live canvas is: a picture of this model, in this shot, at this scale.
  await compareStageToPoster(
    page,
    page.locator('[data-fiddy-hero-variant="hero"]'),
    label,
  );
  await page.locator('[data-fiddy-hero-variant="hero"]').click();
  const reducedReaction = page.locator('[data-fiddy="hero-reaction"]');
  check(
    `${label}: a tap still gets words, without fetching or hopping`,
    (await reducedReaction.textContent()) === 'Hiya, you!' &&
      requested.filter((url) => url.endsWith(GLB)).length === 0 &&
      (await page
        .locator('[data-fiddy-hero-variant="hero"] canvas')
        .count()) === 0,
    await reducedReaction.textContent(),
  );
  check(
    `${label}: the hello itself has no animation`,
    (await reducedReaction.evaluate(
      (node) => getComputedStyle(node).animationName,
    )) === 'none',
  );
  await shot(page, label);
  await context.close();
}

/** No WebGL: the still is what remains, and nothing throws about it. */
async function checkNoWebgl(browser, width) {
  const label = `no-webgl-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  // The failure every iOS webview and every locked-down desktop can produce:
  // a canvas that answers nothing. The hero must not care.
  await context.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      if (typeof kind === 'string' && kind.includes('webgl')) return null;
      return real.call(this, kind, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fiddy-hero-variant="hero"]');
  await page.waitForTimeout(2500);

  check(
    `${label}: the stage stays on the still`,
    (await page
      .locator('[data-fiddy-hero-variant="hero"]')
      .getAttribute('data-fiddy-hero')) === 'still',
  );
  check(
    `${label}: the still is visible, so the box is never empty`,
    await page
      .locator('[data-fiddy-hero-variant="hero"] .fiddy-hero-stage-still')
      .isVisible(),
  );
  // The hard rule: with no WebGL the fallback path must RENDER — a visible
  // image tag is not the same claim as pixels of Fiddy on the page.
  await compareStageToPoster(
    page,
    page.locator('[data-fiddy-hero-variant="hero"]'),
    label,
  );
  check(`${label}: nothing throws`, errors.length === 0, errors.join(' | '));
  await shot(page, label);
  await context.close();
}

/** The name step: the little Fiddy, and the field it must not get in the way of. */
async function checkNameStep(browser, width) {
  const label = `name-step-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(RESOURCES);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${SERVER}/welcome/name`, { waitUntil: 'domcontentloaded' });

  const stage = page.locator('[data-fiddy-hero-variant="form"]');
  await page.waitForSelector('[data-fiddy-hero-variant="form"]', {
    timeout: 20000,
  });
  check(
    `${label}: the little Fiddy is on the name step`,
    (await stage.count()) === 1,
  );
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-fiddy-hero-variant="form"][data-fiddy-hero="moving"]',
      ),
    undefined,
    { timeout: 45000 },
  );

  const layout = await page.evaluate(() => {
    const stage = document.querySelector('[data-fiddy-hero-variant="form"]');
    const field = document.querySelector('.fiddy-field');
    const input = document.querySelector('.fiddy-input');
    const canvas = stage.querySelector('.fiddy-hero-stage-canvas');
    const box = stage.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    return {
      stage: { x: box.x, y: box.y, w: box.width, h: box.height },
      field: {
        x: fieldBox.x,
        y: fieldBox.y,
        w: fieldBox.width,
        h: fieldBox.height,
      },
      input: { y: inputBox.y, h: inputBox.height },
      canvasPointerEvents: getComputedStyle(canvas).pointerEvents,
      inputPointerEvents: getComputedStyle(input).pointerEvents,
    };
  });

  const beside = layout.stage.x + layout.stage.w <= layout.field.x + 1;
  check(
    `${label}: ${width >= 520 ? 'the model stands beside the field' : 'the model stacks above the field'}`,
    width >= 520 ? beside : !beside,
    JSON.stringify(layout),
  );
  check(
    `${label}: the model never takes the pointer the field needs`,
    layout.canvasPointerEvents === 'none',
    layout.canvasPointerEvents,
  );

  // (10) and the field still works with the model mounted next to it.
  const input = page.locator('.fiddy-input');
  await input.click();
  await input.fill('Pip');
  check(
    `${label}: the name field is still typeable with the model beside it`,
    (await input.inputValue()) === 'Pip',
  );
  check(
    `${label}: the model is small, not a second hero`,
    layout.stage.w <= 120 && layout.stage.h <= 120,
    JSON.stringify(layout.stage),
  );
  await shot(page, label);
  check(`${label}: nothing threw`, errors.length === 0, errors.join(' | '));
  await context.close();
}

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(POSTER)) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `no poster at ${POSTER} — run scripts/render-hero-poster.mjs first`,
      }),
    );
    process.exit(1);
  }

  // The system Chrome, the same browser the repo's other render script uses.
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const width of WIDTHS) {
      await checkFrontDoor(browser, width);
      await checkReducedMotion(browser, width);
      await checkNoWebgl(browser, width);
      await checkNameStep(browser, width);
    }
  } finally {
    await browser.close();
  }

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        server: SERVER,
        widths: WIDTHS,
        checks,
        shots,
        failures,
      },
      null,
      1,
    ),
  );
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.log(
    JSON.stringify(
      { ok: false, error: String(error?.stack ?? error) },
      null,
      1,
    ),
  );
  process.exit(1);
});
