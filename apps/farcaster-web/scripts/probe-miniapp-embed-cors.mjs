// Can a browser parse a miniapp's `fc:miniapp` meta tag itself?
//
//   node scripts/probe-miniapp-embed-cors.mjs
//
// This is the ONE question that decides between the two honest ways to show an
// in-feed miniapp card, and it is not a matter of taste:
//
//   (a) the client fetches the embed URL's HTML and parses `fc:miniapp` /
//       `fc:frame` — the shape Quilcast's unfurl produces (its
//       `server/unfurl.mjs`, its `src/compose.tsx` meta-tag shapes);
//   (b) our own same-origin endpoint fetches and parses it server-side, and the
//       browser only ever talks to us — which is what Quilcast's unfurl
//       actually IS (it is a server module, not browser code).
//
// A browser read of a third-party page is a cross-origin request, so it works
// only if that page answers `Access-Control-Allow-Origin` for our origin. This
// probe measures that in a real browser, from the client's own origin, for the
// two real `fc:miniapp` pages this card found on the node. It writes nothing and
// needs no dev server for the fetch itself (the page origin is only there so the
// request has the same origin a real client would have).
//
//   CORS_SERVER=https://localhost:5180 node scripts/probe-miniapp-embed-cors.mjs

import { chromium } from 'playwright';

const SERVER = process.env.CORS_SERVER ?? 'https://localhost:5180';
const URLS = [
  // the fresh fixture (fid 1062481, top-level, posted the day of the run)
  'https://beep.works/send/cmi8mtgn500afiolnh4qelc53',
  // the aged fixture (fid 17, in `dwr`'s follow graph)
  'https://thefirm.biz/employees/17',
];

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });

const results = [];
for (const url of URLS) {
  await page.goto(SERVER, { waitUntil: 'commit', timeout: 120_000 });
  const result = await page.evaluate(async (target) => {
    const out = { url: target, origin: window.location.origin };
    try {
      const response = await fetch(target, { mode: 'cors', credentials: 'omit' });
      const text = await response.text();
      out.status = response.status;
      out.readable = true;
      out.bytes = text.length;
      out.miniappMeta = /fc:miniapp/i.test(text);
    } catch (error) {
      out.readable = false;
      out.error = `${error?.name}: ${error?.message}`;
    }
    return out;
  }, url);
  results.push(result);
  console.log(
    `\n${url}\n  from ${result.origin}\n  readable=${result.readable}` +
      (result.readable
        ? ` status=${result.status} bytes=${result.bytes} fc:miniapp=${result.miniappMeta}`
        : ` error=${result.error}`),
  );
}

await browser.close();

const readable = results.filter((r) => r.readable && r.miniappMeta);
console.log(
  `\n${readable.length}/${results.length} miniapp pages were readable by the browser from this client's origin.`,
);
if (readable.length === 0) {
  console.log(
    'Verdict: a browser cannot parse these pages. Browser-side unfurling (a as literally written) is not available for real miniapps; only a same-origin unfurl endpoint is.',
  );
}
process.exit(0);