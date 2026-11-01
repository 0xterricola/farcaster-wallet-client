// Is script-src 'self' enough for the client's shell — and does the page say so
// from a browser, rather than the config saying so?
//
//   node scripts/verify-csp-script-src.mjs                     # https://fiddy.fun
//   node scripts/verify-csp-script-src.mjs --local dist --csp "<header value>"
//   node scripts/verify-csp-script-src.mjs --local dist --csp "…" --beacon
//
// WHY IT EXISTS. The client's CSP carried `script-src 'self' 'unsafe-inline'`
// for exactly two reasons, and both were inline script in index.html: the theme
// bootstrap (`user-saved-theme` -> html.dark, before first paint) and the font
// sheet's `onload="this.media='all'"`. An inline event-handler attribute is
// inline script too — a CSP that drops 'unsafe-inline' blocks it, and the font
// sheet then stays `media="print"`, i.e. no Inter at all. Removing the inline
// <script> alone is therefore not enough, and this probe measures both.
//
// MEASURED against the pre-fix production page 2026-10-21 (checks 1, 2, 3, 5
// and 6 fail there, 7/8 pass): the inline bootstrap and the inline handler,
// `script-src 'self' 'unsafe-inline'`, and a refused Cloudflare beacon.
//
// WHAT IT ASSERTS
//   1. the served HTML carries no inline <script> (an element with no src)
//   2. the served HTML carries no inline event-handler attribute (on*=…)
//   3. script-src is exactly 'self' — no beacon host, no 'unsafe-inline',
//      no 'unsafe-eval'
//   4. the browser actually fetches the shell bootstrap (a same-origin classic
//      script, 200), so the theme is the document's own to set
//   5. a real load raises no CSP violation for the page's OWN script (nothing
//      inline, nothing same-origin refused)
//   6. everything the load still refuses is on the documented pre-existing
//      list (Privy/app `eval`, one `wasm-eval`, PostHog's placeholder config;
//      the deliberately injected local beacon is expected to be refused) —
//      a refusal that is not on that list fails the check, so this cannot pass
//      by being quiet about a new one
//   7. with the app bundle blocked — so only the document itself can run — the
//      shell is still dark: html.dark, data-theme=dark, and html's own ground
//      is #161715. A bootstrap that had moved into the bundle fails this,
//      because the bundle is the thing being blocked
//   8. with `user-saved-theme=light` the same shell is light (#ffffff), so the
//      moved bootstrap still honours the reader
//
// `--beacon` appends Cloudflare's own injected tag to the HTML it serves, so
// the local gate measures the beacon allowance without waiting for the edge.
//
// Nothing here writes to the site: it reads the page, and (in --local mode)
// serves a directory off this machine.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const LOCAL_DIR = arg('local', null);
const CSP = arg('csp', null);
const WITH_BEACON = argv.includes('--beacon');
const TARGET = arg('target', LOCAL_DIR ? null : 'https://fiddy.fun');

// Cloudflare used to inject this into HTML at the edge. HTML now carries
// no-transform, so the live page must not contain or request it. --beacon
// injects it locally on purpose and requires script-src 'self' to refuse it.
const BEACON_HOST = 'https://static.cloudflareinsights.com';
const BEACON_TAG =
  '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon=\'{"version":"2024.11.0","token":"412e3d7cd3fe4c678fac4ea3306a6950","r":1,"spa":2}\' crossorigin="anonymous"></script>';

// What the client refuses on its own, with a CSP that has no 'unsafe-inline',
// no 'unsafe-eval' and no 'wasm-unsafe-eval' — measured on the live page before
// and after this card. These are NOT this card's to fix (they belong to the
// hosted-call and cryptography gaps docs/CLIENT-RELEASE.md already lists); they
// are here so that a NEW refusal cannot hide among them.
const PREEXISTING_BLOCKED = [
  {
    why: "the app's own eval (no 'unsafe-eval' in the CSP, by design)",
    match: (b) => b === 'eval',
  },
  {
    why: "a wasm compile (no 'wasm-unsafe-eval'; pre-existing, measured)",
    match: (b) => b === 'wasm-eval',
  },
  {
    why: "PostHog with the fork's REPLACE_ME key",
    match: (b) => b.includes('ph.neynar.com'),
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

const results = [];
const record = (n, ok, detail) => {
  results.push({ n, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (detail) console.log(`        ${detail}`);
};

const serve = (dir) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(dir, decodeURIComponent(url.pathname));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(dir, 'index.html');
      }
      let body = fs.readFileSync(file);
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      if (type.startsWith('text/html') && WITH_BEACON) {
        body = body.toString('utf8').replace('</body>', `${BEACON_TAG}</body>`);
      }
      const headers = {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      };
      if (CSP) headers['content-security-policy'] = CSP;
      res.writeHead(200, headers);
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });

/** Inline script the document would execute: what 'unsafe-inline' is for. */
const inlineScripts = (html) => {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of stripped.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\bsrc\s*=/i.test(m[1])) out.push(`<script${m[1]}>`);
  }
  return out;
};

/** Inline event handlers: also inline script, also blocked without it. */
const inlineHandlers = (html) => {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  return [
    ...stripped.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/gi),
  ].map((m) => `on${m[2]} on <${m[1]}>`);
};

const scriptSrcOf = (csp) => {
  const m = /(?:^|;)\s*script-src([^;]*)/i.exec(csp ?? '');
  return m ? m[1].trim() : null;
};

const load = async (ctx, url, { blockBundle = false, theme = null } = {}) => {
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const beaconRequests = [];
  const served = new Map();
  await page.addInitScript(
    ([t]) => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__cspViolations.push({
          directive: e.violatedDirective,
          blocked: e.blockedURI,
          sample: (e.sample ?? '').slice(0, 120),
          source: `${e.sourceFile ?? ''}:${e.lineNumber ?? ''}`,
        }),
      );
      if (t) {
        try {
          localStorage.setItem('user-saved-theme', t);
        } catch {
          /* about:blank and friends */
        }
      }
    },
    [theme],
  );
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(
        `${m.text().replace(/\s+/g, ' ').slice(0, 200)}${
          m.location()?.url ? `  [${m.location().url.slice(0, 120)}]` : ''
        }`,
      );
    }
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('request', (r) => {
    if (r.url().startsWith(BEACON_HOST)) beaconRequests.push(r.url());
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === new URL(origin).origin) served.set(u.pathname, r.status());
  });
  if (blockBundle) {
    // The document only: whatever paints the shell before the app does must be
    // the document's own, and a bootstrap moved into the bundle would vanish.
    await page.route('**/assets/*.js', (route) => route.abort());
  }
  await page.goto(url, { waitUntil: 'load' }).catch((e) => {
    pageErrors.push(`navigation: ${e}`);
  });
  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  return {
    page,
    violations,
    consoleErrors,
    pageErrors,
    beaconRequests,
    served,
  };
};

let origin = TARGET;

const run = async () => {
  let server = null;
  let servedHtml;
  let servedCsp;

  if (LOCAL_DIR) {
    const s = await serve(LOCAL_DIR);
    server = s.server;
    origin = s.origin;
    const res = await fetch(origin);
    servedHtml = await res.text();
    servedCsp = res.headers.get('content-security-policy');
  } else {
    // Browser-like headers: Cloudflare only injects its beacon for a request
    // that looks like a document load, and the beacon is one of the two things
    // this card is about.
    const res = await fetch(origin, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    servedHtml = await res.text();
    servedCsp = res.headers.get('content-security-policy');
    console.log(`\nsource: ${origin} (${res.status})`);
    console.log(`csp:    ${servedCsp}`);
  }

  console.log('\n── the page a browser is handed ──');
  const inl = inlineScripts(servedHtml);
  record(
    '1. no inline <script> in the served shell',
    inl.length === 0,
    inl.length
      ? `found ${inl.length}: ${inl.join(' ').slice(0, 120)}`
      : 'every script carries src=',
  );
  const handlers = inlineHandlers(servedHtml);
  record(
    '2. no inline event-handler attribute in the served shell',
    handlers.length === 0,
    handlers.length
      ? `found ${handlers.length}: ${handlers.slice(0, 4).join(', ')}`
      : 'none',
  );
  const scriptSrc = scriptSrcOf(servedCsp);
  const tokens = (scriptSrc ?? '').split(/\s+/).filter(Boolean);
  record(
    "3. script-src is exactly 'self', with no beacon host or unsafe-inline/unsafe-eval",
    tokens.length === 1 && tokens[0] === "'self'",
    `script-src${scriptSrc ?? ' (absent)'}`,
  );

  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  console.log('\n── a real load of it, in a real browser ──');
  const full = await load(ctx, origin);
  const status = full.served.get('/shell-bootstrap.js');
  record(
    '4. the browser fetches the shell bootstrap itself (same-origin, 200)',
    status === 200,
    `/shell-bootstrap.js -> ${status ?? 'never requested'}`,
  );

  const ownOrigin = new URL(origin).origin;
  const refusedOurScript = full.violations.filter(
    (v) =>
      v.blocked === 'inline' ||
      v.blocked.startsWith(ownOrigin) ||
      v.blocked.startsWith('about:'),
  );
  const refusedBeacon = full.violations.filter((v) =>
    v.blocked.startsWith(BEACON_HOST),
  );
  record(
    "5. nothing the page does itself is refused ('unsafe-inline' is gone, and the shell still runs)",
    refusedOurScript.length === 0,
    refusedOurScript.length
      ? refusedOurScript
          .map((v) => `${v.directive} <- ${v.blocked}`)
          .join(' | ')
          .slice(0, 240)
      : 'no inline or same-origin refusal',
  );

  const unexplained = full.violations.filter(
    (v) =>
      !PREEXISTING_BLOCKED.some((p) => p.match(v.blocked)) &&
      !(WITH_BEACON && v.blocked.startsWith(BEACON_HOST)),
  );
  const counts = {};
  for (const v of full.violations) {
    const k = `${v.directive} <- ${v.blocked.slice(0, 60)}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  record(
    '6. every remaining refusal is a documented pre-existing one',
    unexplained.length === 0,
    Object.entries(counts)
      .map(([k, n]) => `${n}x ${k}`)
      .join(' | ')
      .slice(0, 300) || 'none',
  );
  const beaconProof = WITH_BEACON
    ? refusedBeacon.length > 0
    : !servedHtml.includes(BEACON_HOST) &&
      full.beaconRequests.length === 0 &&
      refusedBeacon.length === 0;
  record(
    "6b. Cloudflare's beacon is absent, or refused when injected locally",
    beaconProof,
    `${full.beaconRequests.length} request(s), ${refusedBeacon.length} refusal(s), in served HTML: ${servedHtml.includes(BEACON_HOST)}`,
  );
  const cspConsole = full.consoleErrors.filter((c) =>
    /Content Security Policy/.test(c),
  );
  const cspConsoleUnexplained = cspConsole.filter(
    (c) =>
      !/ph\.neynar\.com/.test(c) &&
      !c.startsWith(`Loading the script '${BEACON_HOST}`),
  );
  if (cspConsoleUnexplained.length || full.pageErrors.length) {
    record(
      '6c. no NEW console error from a refusal',
      false,
      [...cspConsoleUnexplained, ...full.pageErrors]
        .slice(0, 3)
        .join(' | ')
        .slice(0, 240),
    );
  } else {
    record(
      '6c. no NEW console error from a refusal',
      true,
      `${cspConsole.length} CSP console error(s), all pre-existing (${
        full.consoleErrors.length
      } console errors total, ${full.pageErrors.length} page errors)`,
    );
  }

  console.log('\n── the shell, with the app bundle blocked ──');
  const groundOf = (p) =>
    p.evaluate(() => ({
      cls: document.documentElement.className,
      theme: document.documentElement.getAttribute('data-theme'),
      ground: getComputedStyle(document.documentElement).backgroundColor,
    }));
  const dark = await load(ctx, origin, { blockBundle: true });
  const d = await groundOf(dark.page);
  record(
    "7. the document alone paints the dark shell (no flash of the fork's light ground)",
    d.cls.split(/\s+/).includes('dark') && d.ground === 'rgb(22, 23, 21)',
    `html.class="${d.cls}" data-theme=${d.theme} ground=${d.ground}`,
  );
  const light = await load(ctx, origin, { blockBundle: true, theme: 'light' });
  const l = await groundOf(light.page);
  record(
    '8. a reader who saved `light` still gets a light shell',
    l.cls.split(/\s+/).includes('light') && l.ground === 'rgb(255, 255, 255)',
    `html.class="${l.cls}" data-theme=${l.theme} ground=${l.ground}`,
  );

  await browser.close();
  if (server) server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks pass against ${origin}`,
  );
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.n).join(', ')}`);
    process.exitCode = 1;
  }
};

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
