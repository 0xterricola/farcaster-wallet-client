// Does the shell we just built still need 'unsafe-inline' in script-src?
//
//   node scripts/check-shell-has-no-inline-script.mjs dist/index.html
//
// The host serves the client with `script-src 'self'` (see
// docs/CLIENT-RELEASE.md). An inline <script> in index.html, or an inline
// event-handler attribute like the font sheet's old
// `onload="this.media='all'"`, is inline script: the browser refuses it.
//
// The shell bootstrap that sets the saved theme before first paint therefore
// lives at public/shell-bootstrap.js (`<script src="/shell-bootstrap.js">`), and
// this check is what keeps it from creeping back inline. It runs inside the
// release ritual (scripts/release-client.sh, step 3) so a release that would
// need 'unsafe-inline' never ships.
//
// Measured, not assumed: scripts/verify-csp-script-src.mjs loads the served
// page in a browser and counts the refusals; this check is the cheap half of
// the same fact and can run without one.

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'dist/index.html';
const name = path.basename(file);
const html = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)]
  .filter((m) => !/\bsrc\s*=/i.test(m[1]))
  .map((m) => `<script${m[1]}>`);
const inlineHandlers = [
  ...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/gi),
].map((m) => `on${m[2]} on <${m[1]}>`);

if (inlineScripts.length === 0 && inlineHandlers.length === 0) {
  console.log(`  ${name}: no inline script, no inline handler — script-src 'self' is enough`);
  process.exit(0);
}

console.error(`  ${name} would be refused by script-src 'self':`);
for (const s of inlineScripts) console.error(`    inline <script>: ${s.slice(0, 120)}`);
for (const h of inlineHandlers) console.error(`    inline handler:  ${h}`);
console.error(
  '    Move it to a same-origin file under public/ and reference it with src=.',
);
process.exit(1);