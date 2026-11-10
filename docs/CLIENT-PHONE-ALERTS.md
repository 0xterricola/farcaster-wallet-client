# Tell my phone (`/api/alerts`)

Notifications for your own activity — replies, mentions, likes, follows —
delivered to the phone while the tab is closed. The reader half of this already
existed: the app derives these groups from the node in
`snapchain/nodeApi/reads.ts` (a cast mentioning you, a reply on your own cast,
a like, a follow). What did not exist was the delivery: the browser cannot be
reached when it is closed, so every notification only ever existed while
somebody was looking at the app.

Design borrowed from backmeupplz/quilcast (MIT, commit `f2eedb9a7264`, 0.78.0)
— the burst-grouping shape, the dedupe window, the per-reader subscription
store and the "sign a short claim with the key you already hold" subscribe
shape are its, re-derived for this repo's server. Deliberately not borrowed:
its hosted-shaped `/v2/farcaster/notifications` polling (our derivation is
the one `reads.ts` already does, run server-side against the node the instance
is configured with), its server-side key storage, and its server-side mute
filtering.

## The kinds, and only the kinds

Mentions, replies, likes, follows — the four groups the protocol reads can
derive today. No recasts and no quotes: the read does not derive them, and copy
that promised them would be inventing a notification nobody sends.

## The two halves, one release

- **Browser:** `src/snapchain/alerts/phoneAlerts.ts` + the lazy
  `PhoneAlertsSetting` in Notifications settings, and `public/sw.js`. The
  worker is push-only: **no `fetch` handler, no cache** — a worker that
  answered fetches would serve yesterday's bundle past both the release
  ritual's byte-comparison and `init/initReloadOnStaleChunks.ts`. The settings
  section is behind a lazy import, so the entry chunk does not pay for the
  browser's alert machinery.
- **Server:** `server/alerts/` on the unfurl service. `GET /api/alerts` says
  what this host can do; `POST /api/alerts` subscribes; `POST
  /api/alerts/off` unsubscribes. The loop (`service.mjs`) runs once a minute,
  derives each subscribed reader's own groups, folds them (`group.mjs`), and
  sends at most four pushes per reader per minute — the rest becomes one
  "N more" line that opens Notifications.

`release-client.sh` refuses to cut over unless both halves are in place: the
vhost carries `location = /api/alerts` and `location = /api/alerts/off`, and
`/etc/fiddy-unfurl/unfurl.env` names a `FIDDY_ALERTS_DIR`.

## The reader proves who they are without giving up the key

The browser already holds an on-chain app key for the FID
(`snapchain/appKeyStorage.ts`). It signs a short claim — `fiddy-alerts-v1`,
the FID, a hash of *the phone's own push address*, the time — and sends the
signature, never the key. The server (`subscribe.mjs`) checks the claim's shape
and verifies the signer against the node's `/v1/signer?fid&signer` read. The
endpoint hash binds the subscription to the phone that made it, so a witnessed
claim cannot re-point anybody's notifications. Nothing resembling a key or a
phrase is ever stored server-side.

## The three states of a host, each honest

1. `FIDDY_ALERTS_DIR` absent — the host does not run alerts. `GET /api/alerts`
   answers `not-configured` and the browser draws no toggle at all.
2. The directory without `vapid.json` — the host opted in but never made a
   push identity. `GET /api/alerts` answers `no-keys` and the settings copy
   says the one a self-hoster needs. Fiddy ships no key and never points a
   self-hosted install at fiddy.fun's identity: a push under somebody else's
   identity is refused by the reader's browser.
3. Both — alerts are on. Generate the identity once, on the host, from its
   own release tree (a setup command, never a request):

   ```sh
   cd /var/www/fiddy.fun/current/server && node -e "
     import('./alerts/vapid.mjs').then(async (m) => {
       const vapid = m.createVapidStore({ dir: process.env.FIDDY_ALERTS_DIR });
       const keys = await vapid.ensure({ subject: 'https://fiddy.fun' });
       console.log('publicKey', keys.publicKey);
     });
   "
   ```

   The file is mode 600, written tmp-then-rename; rotating it invalidates every
   subscription, which is why rotation is explicit (`ensure({ rotate: true })`)
   and never something a restart decides.

## Mutes: people go up, words never do

Mutes in this client are device-local (`snapchain/mutePreferences.ts`). Only
the hidden PEOPLE are uploaded, as plain FIDs, re-sent whenever the list
changes — so a hidden person cannot reach the lock screen. Muted WORDS never
leave the device, and the settings copy says so. (Upstream filters mutes
server-side because its mutes are server state; copying that would mean
uploading the words.)

## The loop's own rules (`service.mjs`)

- One pass a minute over every subscriber, not a timer per reader; a reader
  consulted within the last `FIDDY_ALERTS_INTERVAL_MS` is skipped.
- The derivation reads the last 10 of the reader's own casts for replies —
  the ceiling is in the file, and it is a ceiling.
- A new subscriber hears nothing about the past: everything older than the
  moment they switched on is dropped, not recorded.
- A push service answering 404/410 deletes the subscription — the phone said
  it is gone.
- Dedupe: an id in the window is never sent twice, and what was folded into a
  group counts as sent. Store: one JSON file per FID in
  `FIDDY_ALERTS_DIR`, tmp-then-rename, mode 600; a missing file is "no
  subscription", never an error.
- `notification.tag` + `renotify` make a burst one moving line ("Maya and 4
  others liked your cast") instead of a stack.

## The honest paths in the browser

iOS only delivers web push to a Home Screen app: a reader on iOS in the
browser is told to add Fiddy to their Home Screen first — one sentence, not a
switch that does nothing. A denied permission is the reader's own answer and is
respected. A browser without a service worker/PushManager paints the reason,
not a broken switch.

## Tests

`src/__tests__/phoneAlerts.test.ts` (grouping, dedupe, the store round-trip,
the RFC 8188 envelope, the VAPID token — decrypts byte-for-byte),
`phoneAlertsService.test.ts` (the loop, the fresh-subscriber rule, GONE
deletes, kinds, the stubbed push endpoint — no test ever sends a real push),
`phoneAlertsRoute.test.ts` (the routes through the unfurl handler, rate
limits, `not-configured`/`no-keys`), `phoneAlertsClient.test.ts` (the two
claims agree byte-for-byte, the iOS/unsupported sentences). The settings
round-trip (on → off → gone from disk) is in the store and service files.
