// Post-release check for the looks feature, run by hand from a client checkout
// (playwright resolves from the repo's ROOT node_modules):
//
//   node apps/farcaster-web/scripts/verify-looks-live.mjs
//
// READ-ONLY against the live origin, except for two POSTs to /look that store
// one small checked look each — idempotent by content: the same body is the same
// id, so a re-run stores nothing new.
//
// What it asks of the deployed app:
//
//   * the shared-look service answers on our own origin: `POST /look` -> `{ id }`,
//     the same body answers the SAME id, `GET /look/<id>.json` is the look, the
//     page `/look/<id>` carries that look's own tags, and its card is a real
//     1200x630 PNG;
//   * a body that is not a checked look is refused in one sentence — empty,
//     oversized, carrying a picture, carrying CSS text — and an id is never a
//     path;
//   * the link opens AS THE LOOK for a signed-out visitor (the page says what it
//     is and offers "Put this look on");
//   * a worn look survives a reload of fiddy.fun itself, written on the document
//     before it paints.
//
// Env:
//   LOOKS_ORIGIN     the origin to measure       (default https://fiddy.fun)
//   LOOKS_SHOT_DIR   where the screenshot lands  (default: the system temp dir —
//                    never a directory inside the repo, whose files eslint walks
//                    on every lint run)
import { Buffer } from 'node:buffer';
import os from 'node:os';

import { chromium } from 'playwright';

const ORIGIN = process.env.LOOKS_ORIGIN ?? 'https://fiddy.fun';
const SHOT_DIR = process.env.LOOKS_SHOT_DIR ?? os.tmpdir();

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
};

// The look this probe hands over: every field a look may carry, so what comes
// back is held to the model rather than to a two-key stub.
const LOOK = {
  name: 'Probe',
  base: 'light',
  bg: '#f4f3ec',
  card: '#ffffff',
  ink: '#1b1c17',
  muted: '#66685d',
  line: '#e0ded2',
  soft: '#eceae0',
  accent: '#3f6cff',
  onAccent: '#ffffff',
  like: '#d6295c',
  recast: '#1a8f6a',
  border: '#e0ded2',
  round: 12,
  borderWidth: 1,
  font: 'inter',
};

const postLook = (body) =>
  fetch(`${ORIGIN}/look`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

console.log(`\n== a look is stored once, on our own origin (${ORIGIN})`);
const first = await postLook(LOOK);
const firstBody = await first.json().catch(() => null);
check('POST /look answers 200', first.status === 200, `status ${first.status}`);
const id = firstBody?.id;
check(
  'POST /look answers an id',
  typeof id === 'string' && /^[0-9a-f]{10}$/.test(id),
  String(id),
);

const second = await postLook({ ...LOOK, zzz: 'an unknown key' });
const secondBody = await second.json().catch(() => null);
check(
  'the same look is the same id (stored once)',
  second.status === 200 && secondBody?.id === id,
  `${second.status} ${String(secondBody?.id)}`,
);

console.log('\n== the stored look reads back as what was stored');
const stored = await fetch(`${ORIGIN}/look/${id}.json`);
const storedBody = await stored.json().catch(() => null);
check(
  'GET /look/<id>.json answers 200 json',
  stored.status === 200 && !!storedBody,
  `status ${stored.status}`,
);
check(
  'the look is the palette that was handed over',
  storedBody?.look?.bg === LOOK.bg &&
    storedBody?.look?.accent === LOOK.accent &&
    storedBody?.look?.round === LOOK.round &&
    storedBody?.look?.font === LOOK.font,
  JSON.stringify(storedBody?.look ?? null).slice(0, 160),
);
check('unknown keys never came back', !('zzz' in (storedBody?.look ?? {})));

console.log('\n== the link is a page a person can open, and a card');
const page = await fetch(`${ORIGIN}/look/${id}`);
const html = await page.text();
check(
  'GET /look/<id> answers the app shell',
  page.status === 200 && html.includes('<!doctype html'),
  `status ${page.status}`,
);
check(
  'the page names the look it is',
  new RegExp('<title>[^<]*Probe', 'i').test(html),
  (html.match(/<title>[^<]*<\/title>/i) ?? [''])[0],
);
check(
  'the page carries the look card as its preview',
  html.includes(`/unfurl/cards/look/${id}.png`),
);
const card = await fetch(`${ORIGIN}/unfurl/cards/look/${id}.png`);
const cardBytes = Buffer.from(await card.arrayBuffer());
check(
  'the card is drawn',
  card.status === 200 &&
    cardBytes.subarray(0, 4).toString('hex') === '89504e47',
  `status ${card.status} ${cardBytes.length}B`,
);
check(
  'the card is 1200x630',
  cardBytes.length > 24 &&
    cardBytes.readUInt32BE(16) === 1200 &&
    cardBytes.readUInt32BE(20) === 630,
  cardBytes.length > 24
    ? `${cardBytes.readUInt32BE(16)}x${cardBytes.readUInt32BE(20)}`
    : 'no header',
);

console.log('\n== anything that is not a checked look is refused');
const empty = await postLook('');
check('an empty body is refused', empty.status === 400, `status ${empty.status}`);
// A body of 4 KB to 8 KB used to answer `405 Not Allowed` from nginx: the reader
// destroyed the request the moment the cap was crossed (see
// `server/unfurl/lookBody.mjs`), so no sentence was ever written. Card
// t_d85d8520 measured it on fiddy.fun and this is the check that keeps it fixed.
const oversized = await postLook({ ...LOOK, name: 'x'.repeat(5000) });
const oversizedBody = await oversized.json().catch(() => null);
check(
  'a body past the look cap is refused in one sentence',
  oversized.status === 413 &&
    oversizedBody?.error === 'That look is too big to share.',
  `status ${oversized.status} ${JSON.stringify(oversizedBody?.error ?? null)}`,
);
const withPicture = await postLook({
  ...LOOK,
  bgImg: 'data:image/png;base64,iVBORw0KGgo=',
});
check(
  'a look carrying a picture is refused',
  withPicture.status === 400,
  `status ${withPicture.status}`,
);
const withCss = await postLook({
  bg: 'url(javascript:alert(1))',
  accent: 'red',
});
check(
  'CSS text is not a colour, so nothing but an empty look survives',
  withCss.status === 400,
  `status ${withCss.status}`,
);
// An id is never a path. The traversal is sent ENCODED, because a fetch would
// normalise `../../` away before it left this machine — and then measure the
// app's own fallback instead of the service.
const traversal = await fetch(
  `${ORIGIN}/look/%2e%2e%2f%2e%2e%2fetc%2fpasswd.json`,
);
const traversalText = await traversal.text();
check(
  'an encoded traversal is refused, never read',
  traversal.status !== 200 && !traversalText.includes('root:'),
  `status ${traversal.status}`,
);
const dead = await fetch(`${ORIGIN}/look/0000000000.json`);
check(
  'an unknown id is a 404, not a blank look',
  dead.status === 404,
  `status ${dead.status}`,
);

console.log('\n== the link opens as the look, and a worn look survives a reload');
const browser = await chromium.launch();
try {
  // A FRESH context: signed out, wearing nothing — which is what a person who
  // was handed the link has. The whole card is walked here: the look as itself,
  // the one press that wears it, the reload, and undo.
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${ORIGIN}/look/${id}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const cardShown = await tab
    .locator('[data-fiddy="shared-look"]')
    .first()
    .waitFor({ timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  const beforeWearing = await tab.evaluate(() => ({
    url: window.location.pathname,
    text: document.body.innerText.replace(/\s+/g, ' '),
  }));
  check(
    'the link stays on the look and the look is drawn as itself',
    cardShown &&
      beforeWearing.url === `/look/${id}` &&
      beforeWearing.text.includes('A look someone shared') &&
      beforeWearing.text.includes('Probe'),
    `${beforeWearing.url || 'no path'} :: ${beforeWearing.text.slice(0, 160)}`,
  );
  check(
    'a signed-out visitor is offered the one press that wears it',
    /Put this look on/.test(beforeWearing.text),
  );

  await tab.locator('[data-fiddy="shared-look-put-on"]').first().click();
  const afterWearing = await tab
    .locator('[data-fiddy="shared-look-saved"]')
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const wornNow = await tab.evaluate(() => ({
    accent: getComputedStyle(document.documentElement)
      .getPropertyValue('--fiddy-accent')
      .trim(),
    saved: window.localStorage.getItem('fiddy-look') ?? '',
    library: window.localStorage.getItem('fiddy-looks') ?? '',
  }));
  check(
    'wearing it says so, applies the palette, and keeps a copy',
    afterWearing &&
      wornNow.accent.toLowerCase() === LOOK.accent &&
      wornNow.saved.includes(LOOK.accent) &&
      wornNow.library.includes(LOOK.accent),
    `accent ${wornNow.accent} saved ${wornNow.saved.slice(0, 40)}`,
  );

  // The reload: the palette has to be on the document as soon as it is parsed,
  // or the first frame is the previous look. Read at `domcontentloaded`, which
  // is before anything in the bundle can run.
  await tab.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const onReload = await tab.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue('--fiddy-accent').trim(),
      ground: style.getPropertyValue('--fiddy-bg').trim(),
      htmlClass: document.documentElement.className,
      inline: document.documentElement.getAttribute('style') ?? '',
    };
  });
  check(
    'the palette is on the document before the bundle paints',
    onReload.accent.toLowerCase() === LOOK.accent &&
      onReload.ground.toLowerCase() === LOOK.bg &&
      onReload.inline.includes('--fiddy-accent'),
    JSON.stringify(onReload).slice(0, 200),
  );

  await tab.locator('[data-fiddy="shared-look-undo"]').first().click();
  const undone = await tab
    .locator('[data-fiddy="shared-look-put-on"]')
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const afterUndo = await tab.evaluate(() => ({
    stored: window.localStorage.getItem('fiddy-look'),
    accent: getComputedStyle(document.documentElement)
      .getPropertyValue('--fiddy-accent')
      .trim(),
  }));
  check(
    'undo brings the previous look back and takes the variables off',
    undone && !afterUndo.stored && afterUndo.accent.toLowerCase() !== LOOK.accent,
    `stored ${String(afterUndo.stored)} accent ${afterUndo.accent}`,
  );

  await tab.goto(`${ORIGIN}/look/0000000000`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // Waited for as TEXT, in the page, rather than located as an element and then
  // read: the card mounts through `loading` → `missing`, so a locator resolved
  // on one render can be detached by the next before `innerText` is called, and
  // that read throws — which a probe would report as "no sentence at all"
  // (measured 2026-10-23, card t_d85d8520: the element WAS there and the run
  // still said "").
  const deadShown = await tab
    .waitForFunction(
      () =>
        /That look link doesn't work any more\./.test(document.body.innerText),
      { timeout: 45_000 },
    )
    .then(() => true)
    .catch(() => false);
  const deadText = await tab.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  );
  check(
    'a dead link refuses in one plain sentence, never a blank card',
    deadShown &&
      /That look link doesn't work any more\./.test(deadText) &&
      !/Put this look on/.test(deadText),
    JSON.stringify(deadText),
  );

  await tab
    .screenshot({ path: `${SHOT_DIR}/fiddy-look-live.png` })
    .catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const failure of failures) {
  console.log(`  FAIL ${failure}`);
}
console.log(`  screenshot: ${SHOT_DIR}/fiddy-look-live.png`);
process.exit(failures.length ? 1 : 0);