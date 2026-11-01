import { chromium } from 'playwright';

const origin = 'https://fiddy.fun';
const routes = [
  '/',
  '/~/profiles/3',
  '/~/conversations/0xec0c8a227d7f34ad3e2243ae098b46459b7d1847',
  '/look/0123456789',
  '/client',
];
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext();
let failed = false;
for (const route of routes) {
  const page = await context.newPage();
  const beacons = [];
  page.on('request', (request) => {
    if (request.url().includes('static.cloudflareinsights.com'))
      beacons.push(request.url());
  });
  const response = await page.goto(origin + route, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(1000);
  const cache = response?.headers()['cache-control'] ?? '';
  const html = await page.content();
  const ok =
    cache.includes('no-transform') &&
    beacons.length === 0 &&
    !html.includes('static.cloudflareinsights.com');
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${route} cache=${cache} beaconRequests=${beacons.length} beaconInHtml=${html.includes('static.cloudflareinsights.com')}`,
  );
  failed ||= !ok;
  await page.close();
}
await browser.close();
if (failed) process.exitCode = 1;
