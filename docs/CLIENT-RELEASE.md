# Releasing the client to fiddy.fun

Status 2026-10-21. The node-backed client (`apps/farcaster-web`) is live at
**https://fiddy.fun**, release `692377dac34664232a11ffd36715c394dc2d0f62`. The
release before it (`88cf2ba…`) is still on disk, so a rollback is one command.
Everything below was run, not reasoned about — and every table row says which
release it was run against. The tables below were measured on `a0e53d5…`, the
release that introduced the surfaces they describe; the release after it
(`88cf2ba…`) and this one (`692377d…`, see the last section) changed what a cast's
embed renders as and the provider the client reads through, neither of which the
`a0e53d5` rows measure.

## What fiddy.fun serves now

| URL | What answers | Where it comes from |
| --- | --- | --- |
| `/` | the node-backed client | `releases/a0e53d5…/web/` (this release) |
| `/assets/*` | the client's hashed bundle | same |
| `/shell-bootstrap.js` | the shell's theme bootstrap — a same-origin classic script | same; this file is why `script-src` can be `'self'` (see the CSP section) |
| `/preview/` | the read-only preview, byte-identical to what used to be at `/` | `releases/a0e53d5…/web/preview/` |
| `/farcaster` | the same preview page (the miniapp's launch URL is unchanged) | `releases/a0e53d5…/web/preview/index.html` |
| `/snapchain-api/*` | the Snapchain node, relayed | nginx → `https://haatz.quilibrium.com` |
| `/api/fiddy/media`, `/api/fiddy/media/<sha256>.<ext>` | our media host | nginx → `:3219` (`fiddy-auth`) |
| `/api/farcaster/status`, `/api/farcaster/poidh/bounties` | the preview's read API | nginx → `:3218` (`fiddy-preview.service`) |
| `/client`, `/client/`, `/FSSC/`, `/start` | unchanged | elsewhere, untouched |
| `/.well-known/farcaster.json` | the signed app-list manifest — Fiddy's listing identity (name, icon, description, splash, webhook) | nginx `alias /var/www/fiddy-well-known/farcaster.json`; the release installs it from `releases/<sha>/web/.well-known/farcaster.json`, i.e. from the repo's `apps/farcaster-web/public/.well-known/farcaster.json` |
| `/fiddy-splash.png` | the 200×200 splash the manifest and the shell's `fc:miniapp` embed both paint | `releases/<sha>/web/fiddy-splash.png` (a file in this repo, drawn by `apps/farcaster-web/scripts/render-share-card.mjs`) |
| `/fiddy-embed.png` | the 1200×800 (3:2) embed card the manifest's `imageUrl` and the shell's `fc:miniapp` tag both name | `releases/<sha>/web/fiddy-embed.png` (a file in this repo, drawn by `apps/farcaster-web/scripts/render-share-card.mjs`) |
| `/brand/fiddy-app-icon.png` | the 1024×1024 icon the manifest's `iconUrl` names — the app's own icon (the same PNG the shell serves as `apple-touch-icon` and the Expo app declares in `apps/fiddy-mobile/app.json`) | `releases/<sha>/web/brand/fiddy-app-icon.png` (a file in this repo) |
| `/icon.png`, `/image.png`, `/splash.png` | 301s to `/brand/fiddy-app-icon.png`, `/fiddy-embed.png`, `/fiddy-splash.png` — the listing URLs as they stood before 2026-10-22, still answering for anything that cached them | nginx `location = … { return 301 …; }`; see *The listing's pictures* below |

The release tree keeps three things the vhost and systemd depend on:

- `web/` — the client bundle;
- `server/server.mjs` — `fiddy-preview.service` runs
  `/var/www/fiddy.fun/current/server/server.mjs`, so a release without it kills
  that service the next time it restarts. The release copies the previous
  release's file verbatim (sha256 `493e1637…`, unchanged in this release);
- `web/preview/` — the previous release's page and assets, with its
  `/assets/…` references made relative so it resolves inside its own directory.

## Where the live 501 came from

The reported string was:

```
Image upload failed — generateImageUploadUrl 501 - no node-backed reader has been written
for this endpoint yet … Request: POST /v1/generate-image-upload-url Response: 501
```

It could not have come from fiddy.fun, and it did not: it came from the user's
own dev client on this machine, **`https://localhost:5173/`**.

Evidence, all measured:

1. The two halves of that message exist only in the node-backed adapter:
   `why: 'no node-backed reader has been written for this endpoint yet'`
   (`src/snapchain/nodeApi/hostedRoutes.ts:311`, returned as a 501 by
   `nodeBackedFetch.ts:371`) and the `Response: <status>` footer
   (`packages/farcaster-client-data/src/types/errors.ts:136`). Neither string is
   in any build on the VPS: `grep -r` over `/var/www`, `/opt` and `/srv` finds
   nothing.
2. What the VPS was serving at `/` was the **read-only preview** built by
   `legitmate-farcaster/scripts/build-fiddy-preview.mjs` (`mode:
   read-only-preview`, Privy stubbed out). Its three served chunks contain no
   composer at all — `grep -ci` for `composer`, `upload` and `warpcast` over
   `index-BVixwEz_.js`, `dist-DGLX_Xlr.js` and `fiddy-scene-BAcdTRgI.js` is 0 —
   so that surface had no code path to that error either.
3. The dev server on this machine is a node-backed client and says so: its
   transformed module carries
   `import.meta.env = {… "VITE_SNAPCHAIN_HTTP_URL": "https://haatz.quilibrium.com" …}`
   (`curl -k https://localhost:5173/src/snapchain/nodeApi/nodeBackedFetch.ts`),
   and it serves `src/snapchain/nodeApi/mediaUpload.ts` (which names
   `/api/fiddy/media`) and `src/constants/api.ts` (the fork's own hosted-API
   base).
4. The user reported the error at 2026-10-21 01:26 IST in the desktop session
   and was told, in the same thread, "refresh `https://localhost:5173/`" — the
   surface they were testing on.

So: the composer that failed was a locally served node-backed build; the fix in
`t_54ee6c54` was already live in that surface after a refresh, and nothing of it
was reachable at fiddy.fun until the first client release.

## The ritual

```bash
cd /Users/lc/Projects/fiddy
scripts/release-client.sh                    # build origin/main, upload, cut over, verify
scripts/release-client.sh <sha> --no-cutover # stage a release without switching
scripts/release-client.sh --rollback         # point current at the previous release
```

What it does, and why each step is not optional:

1. **Frozen tree.** `git archive <sha>` into a scratch tree with `node_modules`
   symlinked from the working clone — a release is a commit, not whatever the
   checkout holds.
2. **The build must carry the env.** `VITE_SNAPCHAIN_HTTP_URL` (the node the
   client reads through — without it `isNodeConfigured()` is false and a
   signed-in session lands on the device-only landing), `VITE_FIDDY_MEDIA_URL`
   (the media host, named even though `https://fiddy.fun` is the default) and
   `VITE_TOGETHER_API_URL` (the Together surface's collaboration service; the
   empty string means "same origin", which is what production is). Current
   release: node `https://haatz.quilibrium.com`, media `https://fiddy.fun`,
   together `''`.
   **`VITE_TOGETHER_API_URL` is not optional.** `src/lib/together.ts` falls back
   to `http://127.0.0.1:8766` when the variable is *undefined*, so a build that
   merely omits it ships a Together page that renders and then asks the
   visitor's own machine for the board. Override with
   `FIDDY_BUILD_TOGETHER_API_URL=<origin>` if the service ever moves off
   fiddy.fun's origin (docs/TOGETHER.md has the CORS caveat).
   `VITE_PRIVY_APP_ID` (optional — the Google/X doors of the sign-up screen) is
   the one other build-time switch. Unset means the feature is **absent, not
   broken**: no social door is drawn and Farcaster sign-in is exactly as it was,
   which is what every build before 2026-10-22 shipped. Set it to the public app
   id of the ONE Privy app (the console in legitmate-farcaster exports the same
   value as `NEXT_PUBLIC_PRIVY_APP_ID`; never a second integration), and the two
   doors ship. The id is public by design and rides in the bundle; the secret
   half, `PRIVY_APP_SECRET`, is a server value and nothing in this client reads
   it. Which of the doors actually answers is a switch in the Privy dashboard
   (`disallowed_login_method`), not a line of code.
   **To judge whether a live build has the doors, do not grep for the buttons'
   words:** `Continue with Google` is in every bundle, because the provider list
   is code. Grep the served entry chunk for the app id's own value — that is the
   only thing that distinguishes a release with the doors from one without.
3. **Local gate.** The built bundle must contain the adapter's 501 sentence, the
   media path, the configured node **and the Together route literal, and must
   NOT contain the `127.0.0.1:8766` fallback** — asserted over every built asset
   — **and the built shell must carry no inline script** (the host serves
   `script-src 'self'`, so an inline `<script>` or an inline `on*=…` handler in
   `index.html` would be refused in the browser after the release). A build that
   needs one does not ship
   (`apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs`, taken from
   the frozen tree). Step 3 also has to pass
   `apps/farcaster-web/scripts/check-manifest.mjs` over the built tree: the
   app-list manifest must be signed, spec-sized (200×200 splash, read from the
   PNG's own header), describe the same product the shell unfurls as, and name a
   splash asset this repo owns — see *The listing manifest* below. Step 6 repeats
   the Together assertions on the extracted
   tree on the VPS. Step 3 also has to resolve the entry chunk the release
   ships (`/assets/index-<hash>.js`, grepped out of the built `index.html`) and
   refuse to ship when that file is not in the build — step 8 fetches *that*
   path, so a path derived from a served shell (which can belong to another
   release) is not allowed to name it.
4. **Assemble** `web/` + `server/` + `web/preview/` as described above.
   Sourcemaps are left out: they are 44 MB of source for a public host.
5. **Upload and extract** into a new immutable `releases/<sha>/`; the running
   release is never written to.
6. **Disk gate on the VPS** — grep the extracted tree, and check the vhost still
   carries the client's locations. Not the deploy command's exit code.
7. **Cut over by symlink only** (`ln -sfn … && mv -Tf …`) plus one nginx reload
   in the same command; the previous release stays where it is. The same command
   first **installs the app-list manifest** from this build's web root into
   `/var/www/fiddy-well-known/farcaster.json` and byte-compares it — the listing
   is domain state the vhost serves by alias from outside any release directory,
   so the release that ships it is what writes it (see *The listing manifest*).
8. **Served gate against the origin.** Fetch the built shell and the entry chunk
   this build produced from the host **by IP** (`--resolve fiddy.fun:443:<origin
   IP>`; HTTPS with SNI, so it is the same vhost a browser reaches, with the CDN
   out of the path), check the served `index.html` for inline script, and compare
   both files byte-for-byte (`cmp`) with the build. Then one **cache-busted**
   fetch through the edge (`?cb=<sha>` — a key no earlier release can have
   populated) as a second gate, and the **plain** edge fetch as a *report* only.
   A CDN in front of the host holds copies of URLs whose names do not change
   between releases (`index.html`) and caches chunk 404s for hours — measured
   2026-10-21, when a release cut over seconds after a sibling's cutover was
   judged against the edge's cached shell, which named the previous release's
   chunk, and the ritual rolled a good release back by itself. A stale edge copy
   is now waited out (up to the host's `max-age`, `FIDDY_EDGE_SETTLE_WAIT`) and
   reported; only a real byte difference rolls the symlink back. When the origin
   is serving a *different release* entirely (a concurrent cutover),
   step 8 prints `OVERTAKEN` and leaves that release alone rather than rolling
   back on top of it.
   `FIDDY_GATE_ASSET=<path>` and `FIDDY_EDGE_PROBE_ASSET=<path>` are fault
   injection for this step (point the chunk fetch / the informational probe at
   another path), never set in a real release.

One thing a release leaves to a human, because a byte gate cannot see a runtime
answer: **the funding surfaces**, checked after the cut-over with
`node apps/farcaster-web/scripts/verify-funding-live.mjs` — origin-direct, no
stubs and no local server (`LIVE_FUNDING_ORIGIN`, default `https://fiddy.fun`),
asserting signed out that the balance home renders with no chip and a dash
rather than an invented `$0.00`, that add-funds names the server's own presets
and its `$1.00` floor, and that **no send is offered** while the balance route
refuses — the signed-out refusal step 8 cannot see. `52/52` at 390px and 1440px
is the green state.

**The sign-out surfaces** are the same kind of gap in a different shape: a
signed-in shell cannot be produced from outside this repository — a Farcaster
session needs the person's own phone, and a worker may not mint one — so this
one is gated on a dev server, at the revision being released and before the
cut-over:

```
HTTPS=true VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  PROBE_VITE_CACHE_DIR=/tmp/<name> \
  npx vite --config scripts/probe.vite.config.mjs --port <free port> --strictPort
SIGN_OUT_SERVER=https://localhost:<port> node scripts/verify-sign-out.mjs
```

It signs in through the stubbed SIWF relay (the same real-SIWE fixture
`verify-account-switching.mjs` uses, said again at the one FID it names), and
then, on every signed-in surface — home, agent, wallet, settings, your own setup
— at 390px and 1440px, it opens the account menu the way a person does (a real
mouse click on the avatar, at phone width on the "You" tab of the bottom bar),
and asserts that **"Sign out" is on screen without scrolling** and fully inside
the viewport, that pressing it **asks first** and that cancelling the dialog
signs nobody out. On the last surface it signs out for real and asserts the
landing is on screen at `/` with the session gone. `98/98` in ~2.5 minutes is
the green state. What the release is then responsible for is smaller and is
checked after the cut-over: the revision in `/release.json`, and the strings
that make these surfaces exist inside the **served** bundle
(`account-menu-sign-out`, `fiddy-account-menu-tabbar`) — in the `.js`, never in
the `.js.map` beside it.

nginx is **not** touched by the script. The client needs four locations that
exist now and are checked in step 6:

- `location ^~ /snapchain-api/` → `https://haatz.quilibrium.com/` with
  `client_max_body_size 2m` (the server-level limit is 1 KB, and a browser
  cannot POST `application/octet-stream` across origins — hence the relay);
- `location ~ ^/spaces(/.*)?$` → `http://127.0.0.1:8787` (the hosted
  collaboration service, `hermes-multiplayer.service`) with
  `client_max_body_size 48k`, `X-Forwarded-For` (the service throttles the real
  caller, trusting that header only from loopback) and `Upgrade`/`Connection`
  (for the board's live stream when it ships). This is the other half of the
  same-origin build: the client's CSP is `connect-src 'self'`, so Together's
  `/spaces/*` calls must answer on fiddy.fun's own origin. Backed up at
  `/root/nginx-backups/fiddy.fun.*.together.bak`;
- `location /` with `try_files $uri $uri/ /index.html` (a SPA needs route
  fallback) and the client's CSP — the one header in this vhost that changes
  when the shell changes, documented below;
- `location ^~ /preview/` and `location = /farcaster` → the preview page, under
  the preview's own stricter CSP.

The client's own routes are `/~/together` and `/~/spaces`, so nothing the SPA
serves lives under `/spaces` — the API prefix does not shadow a page.

### The listing manifest (`/.well-known/farcaster.json`)

Fiddy's listing identity — the app-list entry, search, and the notification
webhook — is the manifest a Farcaster client reads at the well-known path. The
vhost serves that path by exact-match alias in **both** the port-80 and the
port-443 `fiddy.fun` block:

```nginx
location = /.well-known/farcaster.json {
    default_type application/json;
    alias /var/www/fiddy-well-known/farcaster.json;
    add_header Cache-Control "no-store";
}
```

The copy that counts is in this repo, at
`apps/farcaster-web/public/.well-known/farcaster.json`, and step 7 installs it.
It moved out of VPS-only state for two reasons: the manifest is a *second front
door to the same app*, so a change to its copy is a change to what the app says
about itself and belongs in a diff; and nothing in the repo could hold it to the
shell's own `fc:miniapp` embed, which is exactly how it drifted — measured
2026-10-22, the served manifest asked for a 512×512 splash where the spec asks
200×200, painted that splash in upstream Warpcast purple `#6200EA` while the
app's ground is `#161715`, and sold "deploy always on agents with onchain
identities" on the listing while the shell unfurled "a Farcaster client with an
agent".

Rules that come with it:

- **Never re-sign in a release.** `accountAssociation` is the owner's
  cryptographic approval of the *domain* — it covers `{"domain":"fiddy.fun"}` and
  none of the `miniapp` block. It is copied through unchanged; re-signing needs
  the owner's phone. `check-manifest.mjs` refuses an unsigned or stubbed
  association, so no release can take the listing offline by accident.
- **The listing and the link are one product or they are broken.** The release
  gate compares name, splash URL, splash colour and the description sentence
  between the built manifest and the built shell, and reads the splash PNG's own
  header for its size.
- **Every picture the listing names is a file in this repo.** The splash, the
  icon and the embed image are each served under the release root at the size the
  spec asks (`/fiddy-splash.png` 200×200, `/brand/fiddy-app-icon.png` 1024×1024,
  `/fiddy-embed.png` 1200×800), and the release gate reads each PNG's own header
  for its size before anything is uploaded. Measured 2026-10-22 (card
  t_90a2eee2): `/icon.png` and `/image.png` were nginx aliases into
  `/var/www/fiddy-fssc/assets/` — the *sibling* FSSC app's asset directory — and
  served FSSC's "Network Court" judge art, so Fiddy's app-list icon and every
  fiddy.fun cast card sat one FSSC art edit away from being repainted. The icon
  is the app's own (one PNG, three surfaces: the Farcaster listing, the shell's
  `apple-touch-icon`, the Expo icon); the embed card is drawn from the repo's
  mascot by `scripts/render-share-card.mjs`, the same script and art system as
  the og card. The splash is drawn by that script too, and the gate checks more
  than its size: it decodes the PNG and holds the DRAWING's bounding box to the
  centre of the square, because the splash that shipped was the right size, the
  right file, and off-centre — a mark in the corner of its own square is what the
  first frame of every launch showed (measured 2026-10-22, card t_28b3612c; see
  *The splash* below).
- **Every URL it names must answer 200**, and the well-known path must serve real
  JSON (never a redirect) on **http and https** — a redirect or a 404 there is
  what makes a signing phone answer "error matching manifest" (the debug playbook
  is in the `farcaster-miniapps` skill).

### The listing's pictures: one home each, and the old root URLs redirect

Before 2026-10-22 the manifest's `iconUrl` and `imageUrl` were exact-match
aliases into the *sibling* FSSC app's asset directory
(`/var/www/fiddy-fssc/assets/fiddy-judge-ai.png` and `fiddy-card.png`) — the
shape the `farcaster-miniapps` skill warns about, and in this case already the
wrong art: Fiddy's app-list icon and every fiddy.fun cast card were showing
FSSC's "Network Court" judge mascot. They are gone. The three pictures the
listing names are files in this repo, and the three root paths the listing has
ever named redirect to them, so anything that cached the old URL still lands on
Fiddy's own art. The vhost names URLs rather than reaching into a release tree
or another app's directory (card t_90a2eee2; vhost backed up at
`/root/nginx-backups/fiddy.fun.<timestamp>.listing-assets.bak`):

```nginx
location = /icon.png   { return 301 https://fiddy.fun/brand/fiddy-app-icon.png; }
location = /image.png  { return 301 https://fiddy.fun/fiddy-embed.png; }
location = /splash.png { return 301 https://fiddy.fun/fiddy-splash.png; }
```

A redirect is right on those three — they are no longer manifest URLs, and the
well-known path is the only URL on this domain that must never redirect. A
release is what changes the listing (step 7 installs the manifest, and
`check-manifest.mjs` refuses a build whose icon, embed image or splash is
missing, mis-sized, or off-origin); this nginx half was a one-time vhost edit
(`nginx -t && systemctl reload nginx`), not a step in the release ritual.

Measured after the cut-over: the ORIGIN answers `301` on all three immediately
(`curl -sk --resolve fiddy.fun:443:187.127.148.194 …`), while the edge goes on
serving its own cached copies of `/icon.png` and `/image.png` for up to the
7-day TTL the old `expires 7d` aliases set. That is a cache, not a failed fix:
nothing names those two URLs any more, and the pictures the listing and the
shell DO name are the repo-owned ones.

The live state, in four commands:

```bash
curl -s  https://fiddy.fun/.well-known/farcaster.json | head -c 120  # real JSON, 200
curl -sI http://fiddy.fun/.well-known/farcaster.json | head -1       # 200 — not a 3xx
for u in fiddy-splash.png fiddy-embed.png brand/fiddy-app-icon.png; do \
  curl -s -o /dev/null -w "$u %{http_code} %{content_type} %{size_download}\n" https://fiddy.fun/$u; done
for u in icon.png image.png splash.png; do \
  curl -s -o /dev/null -w "$u %{http_code} -> %{redirect_url}\n" https://fiddy.fun/$u; done
```

### The splash: one thing in a 200×200 square, and where it sits

The splash is the one picture here that is a COMPOSITION rather than a file found
somewhere: 200×200, the mascot on the brand's ground `#161715`, no wordmark, no
glow, no address — a square of that size has room for one thing. It is drawn by
the third variant of the same generator the og card and the embed card come from:

```bash
cd apps/farcaster-web && node scripts/render-share-card.mjs splash   # or `all`
```

Two things about that variant are the whole point:

- **It crops the still to its drawing.** `fiddy-mark-poster.png` is 384×384 and
  its drawing is a 217×210 box at (89,80) once composited over the ground, so an
  `<img>` centred by its BOX puts the DRAWING 2.5px right and 3.2px high. The
  variant measures that box with the same reader the release gate uses
  (`scripts/lib/png.mjs`), crops in the page's own canvas, and only then places a
  centred box — so a centred box is a centred mark. It refuses to write a splash
  whose drawing is not centred.
- **It is the size the app icon's mark is.** Measured: the icon's drawing is
  499×550 of 1024, i.e. about half the square, so the splash draws its mark at
  100px in a 200px square.

Measured 2026-10-22 (card t_28b3612c): the art that shipped from card t_8654d91e
was a hand-made 200×200 whose drawing occupied (29,16)-(118,117) — centre
(73.5,66.5) on a canvas whose centre is (100,100) — so the launch transition
painted Fiddy's mascot into the upper-left of its own square with the empty
ground stacked to its right and below. Nothing in the release could see it: the
size was right, the file was this repo's, the bytes were identical live and in
the repo. `check-manifest.mjs` now decodes the splash (a 200×200 PNG is 40k
pixels of inflate, no dependency) and refuses a drawing whose box is not centred
within a couple of pixels, or one that fills less than 30% or more than 80% of
the square. The shipped picture measures 100×96 at (50,52) — centre (99.5,99.5).

The same measurement on what is LIVE, if a splash ever looks off:

```bash
curl -s https://fiddy.fun/fiddy-splash.png -o /tmp/live-splash.png
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { boxCentre, decodePng, rgbOf, visibleBox } from './apps/farcaster-web/scripts/lib/png.mjs';
  const img = decodePng(readFileSync('/tmp/live-splash.png'));
  const box = visibleBox(img, { ground: rgbOf('#161715') });
  console.log(img.width + 'x' + img.height, box.width + 'x' + box.height, JSON.stringify(boxCentre(box)));
"
```

### Rollback

```bash
cd /Users/lc/Projects/fiddy && scripts/release-client.sh --rollback   # → releases/89cdd01…/
ssh root@100.111.203.78 'ln -sfn /var/www/fiddy.fun/releases/89cdd016b5001f75548d92550ab7fa5b8b2d4ee1 \
  /var/www/fiddy.fun/current.new && mv -Tf /var/www/fiddy.fun/current.new /var/www/fiddy.fun/current'
```

The Oct 17 release (`9047c21…`, the read-only preview, with its `server/`) and
the first client release (`89cdd01…`) are both still on disk and byte-intact; the
symlink is the whole switch. The vhost change is backed up at
`/root/nginx-backups/fiddy.fun.*.bak`.

## The client's CSP: `script-src 'self'`, with no CDN rewrites

As served — `curl -sSI https://fiddy.fun/` on 2026-10-21, from `location /` in
`/etc/nginx/sites-available/fiddy.fun`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'
```

One token of that header changed on 2026-10-21 (vhost backed up at
`/root/nginx-backups/fiddy.fun.20261021-031207.csp-self.bak`):

```diff
- script-src 'self' 'unsafe-inline';
+ script-src 'self';
```

Nothing else in the header moved.

### Why `script-src` has no `'unsafe-inline'`

Two things in `apps/farcaster-web/index.html` used to need it, and both are gone
(commit `7cd04fd`):

1. **The theme bootstrap** — the `user-saved-theme` block that sets `html.dark`
   before first paint, so the shell never flashes the fork's light ground. It
   moved to `apps/farcaster-web/public/shell-bootstrap.js`, referenced as
   `<script src="/shell-bootstrap.js">`. It stays a **classic** (non-deferred)
   script on purpose: a module script is deferred, and a deferred bootstrap runs
   after the body is parsed, which is exactly the flash it exists to prevent. The
   served file is the repo's file, byte for byte (sha256 `f9ae13d9…`).
2. **The font sheet's `onload="this.media='all'"`** — an inline event-handler
   attribute is inline script, so moving only the `<script>` would have left the
   CSP just as wide. The Inter sheet is now a normal render-blocking stylesheet;
   the two preconnects above it are what keep the third-party fetch cheap.

### HTML is delivered exactly as built

Every client HTML answer carries `no-transform`: the page is delivered exactly as
we built it, and the CDN may not add scripts to it. This covers `/`, the per-page
cast/profile/look answers and `/client`; JSON, images and hashed assets keep their
existing cache policy. Cloudflare used to inject a Web Analytics beacon, which was
the only reason `script-src` allowed `static.cloudflareinsights.com`. A real-browser
check on 2026-10-26 found no beacon tag or request on any of those routes, so that
host allowance was removed. `verify-csp-script-src.mjs` now requires exactly
`script-src 'self'`; its `--beacon` local mode injects the old tag on purpose and
requires the browser to refuse it.

### Why the rest of the header stays as wide as it is

Each allowance was measured, not guessed:

- `connect-src 'self' https: wss:` — the SIWF relay `relay.farcaster.xyz`, the
  Farcaster websocket `wss://ws.farcaster.xyz`, and **whichever node the reader
  picks in the node picker**, an arbitrary https host. Do not narrow this to
  `'self'`: the picker breaks, and the relay alone is not enough for a reader on
  their own node.
- `img-src … https:` — avatars served through `wrpcd.net`.
- `media-src … blob: https:` — the picked photo before it is uploaded (`blob:`)
  and the uploaded one after.
- `style-src https://fonts.googleapis.com` + `font-src https://fonts.gstatic.com`
  — Inter.
- `frame-src 'self' https:` — Farcaster's own sign-in frame.
- `style-src 'unsafe-inline'` — **deliberately kept**: the document carries two
  inline `<style>` blocks of its own (the ground colours, and the shell skeleton
  that keeps a signed-in cold load from painting an empty body). Inline *style*
  is not script; `style-src` is a different directive with a much smaller blast
  radius, and hashing it would mean rebuilding the document for a cosmetic gain.

### What holds the shape

- `apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs` — cheap, no
  browser: refuses a shell with an inline `<script>` or an inline `on*=`
  handler. Runs in the ritual at step 3 **and** on the served page at step 8.
- `apps/farcaster-web/scripts/verify-csp-script-src.mjs` — a real browser, ten
  checks: no inline script, no inline handler, `script-src` exactly `'self'`,
  the bootstrap fetched 200, no beacon in the live document or requests (or a
  deliberately injected local beacon refused), nothing of the page's own refused, nothing newly
  refused hiding among the documented pre-existing refusals, and — with the app
  bundle blocked, so only the document can run — the shell still paints dark,
  and light for a reader who saved `light`.

### Re-checking it

```bash
curl -fsS https://fiddy.fun/ -o /tmp/served-index.html
node apps/farcaster-web/scripts/check-shell-has-no-inline-script.mjs /tmp/served-index.html
node apps/farcaster-web/scripts/verify-csp-script-src.mjs      # https://fiddy.fun by default
```

To ask the question step 8 asks — what the **origin** serves, with no CDN copy
able to answer — use the origin's IP and compare the entry chunk with the
release tree:

```bash
ORIGIN=187.127.148.194
curl -sk --resolve fiddy.fun:443:$ORIGIN https://fiddy.fun/ -o /tmp/origin-index.html
ASSET=$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' /tmp/origin-index.html | head -1)
curl -sk --resolve fiddy.fun:443:$ORIGIN "https://fiddy.fun$ASSET" -o /tmp/origin-entry.js
ssh root@<box> "cat /var/www/fiddy.fun/current/web$ASSET" | cmp - /tmp/origin-entry.js
```

The first two are seconds; the third is the measurement behind every claim in
this section.

## Verified on the live host (2026-10-21)

Every row names the release it was measured on.

| Check | Result |
| --- | --- |
| Served shell carries no inline script | `check-shell-has-no-inline-script.mjs` on the fetched `/` (12,489 bytes): *"no inline script, no inline handler — script-src 'self' is enough"* — on `a0e53d5` |
| The CSP the browser is handed | the header above: `script-src 'self' https://static.cloudflareinsights.com`, no `'unsafe-inline'`, no `'unsafe-eval'` — on `a0e53d5` |
| The CSP in a real browser, live page | `verify-csp-script-src.mjs` against `https://fiddy.fun`: **10/10** — the bootstrap fetched 200, the beacon fetched and not refused, the document alone still dark (and light for a saved `light`), 1 console error total and it is the documented PostHog one — on `a0e53d5` |
| Served bytes ARE the built bytes | a fresh `git archive a0e53d5…` build reproduces them exactly: `/` `cmp` equal, sha256 `2a5fd7e1…` (12,489 bytes); the index chunk `/assets/index-DI2v8EDP.js` `cmp` equal, sha256 `873b279a…` (7,628,004 bytes); `/shell-bootstrap.js` sha256 `f9ae13d9…` (1,610 bytes) — on `a0e53d5` |
| `/release.json` | `{"revision":"a0e53d5eda61f76b16c50e56a2179f71b7922fff","mode":"node-backed-client","node":"https://haatz.quilibrium.com","media":"https://fiddy.fun"}` — on `a0e53d5` |
| A real sign-in, real browser, public site | the SIWF relay stubbed with a real SIWE message signed by a throwaway key: the ready step renders its own control, the click lands **in the client** — `path=/`, shell frame mounted, Cast control visible, no onboarding sheet, no device-only landing — on `a0e53d5` |
| Node relay through the public host | `GET https://fiddy.fun/snapchain-api/v1/info` → 200 with the node's `dbStats` |
| Composer, real browser, public site | `scripts/verify-media-upload.mjs` against `https://fiddy.fun`: **11/14** — sign-in lands in the client, the composer opens over the feed, the picked bytes are **POSTed to `https://fiddy.fun/api/fiddy/media` → 201**, the URL comes back on that host, the stored photo is readable (200, `image/jpeg`, 227,384 bytes), the served bytes hash to the name in the URL, the composer shows the photo with no failure copy, and nothing was posted to Farcaster. **Measured on `a0e53d5`, the release live at the time**, with the probe fixed so that it survives the sign-in's own navigation (`8d2bf62`); the three checks it does not satisfy are the same three explained below, and the same probe against the local probe server (which sets `VITE_SNAPCHAIN_DEBUG`) is **14/14** |
| Preview / neighbour surfaces | on `a0e53d5`: `/preview/` 200, `/farcaster` 200, `/client` 200, `/client/` 200, `/FSSC/` 200, `/start` 200, `/manifest.json` 200, `/fiddy-card.png` 200, `/fiddy-splash.png` 200, `/shell-bootstrap.js` 200, `/robots.txt` 200, `mate.legitclub.com/api/health` 200 |

Three of the composer probe's fourteen checks are not satisfied on `a0e53d5`,
and each says why:

- **"the upload-URL request … was answered by the MEDIA route"** and **"the cast
  payload … references the media URL"** read `window.__nodeBackedRequests`,
  which is published only under `VITE_SNAPCHAIN_DEBUG`; the release build does
  not set it. The same probe against the local probe server, which does set it,
  is 14/14 (re-measured 2026-10-21, after the probe fix below — the earlier
  measurement on `89cdd01` is t_54ee6c54). The live evidence for the same fact:
  the composer asked for an upload URL, no such request appears in the requests
  that left the page (the adapter answers it inside the page), a 201 upload
  followed, and no failure copy was shown — a 501 would have produced the
  failure copy and no upload.
- **"the photo is served immutable, with nosniff"** — the probe re-uses one
  deterministic photo, and its CDN entry was cached (immutable, one year) while
  nginx and the media service both sent `X-Content-Type-Options`. That duplicate
  is fixed (`proxy_hide_header x-content-type-options` in the media location,
  one header on 200 and 404 alike); the stale cache entry still shows two, and
  every freshly uploaded photo shows one.

## Known gaps (not this release's job)

- **What the composer row could not be measured on before, and why it can now.**
  The row above used to be attributed to the previous release: re-running
  `scripts/verify-media-upload.mjs` against the live client failed in *the probe*,
  not in the client — it read the page surface (`document.body.innerText`) while
  the sign-in's own navigation replaced the document, and died on the null body
  before its first check, which is why nothing could be re-measured. That is
  fixed (`8d2bf62`, which fixes the same read in `verify-siwf-login.mjs`,
  `verify-post-signin-landing.mjs`, `verify-unseen-containment.mjs` and
  `verify-dead-node-feed.mjs` too), and the row is now measured on the release
  that is live. What it still cannot satisfy on a release build is the two checks
  that read `window.__nodeBackedRequests` (no `VITE_SNAPCHAIN_DEBUG` in the
  build) and the cached-`nosniff` duplicate above — both accounted for, neither a
  client fact.
- `/client` and `/client/` (the static landing pages) keep
  `script-src 'self' 'unsafe-inline'` in their own locations: their HTML carries
  an inline `<script>` and no inline handler. Different page, different CSP —
  tightening it means moving that script out, which is not the client's shell.
- ~~The client still makes a few hosted calls the public origin cannot serve~~
  **Closed by `f562e17`/`6313040`** (2026-10-21): `api.farcaster.xyz/v1/**` and
  `/v2/**` and `ph.neynar.com` are no longer asked at all by a page. Two halves:
  the provider seam refuses a request for Farcaster's own public server in place,
  in the words of that request's own classification
  (`src/snapchain/providers/publicServerOffTheWeb.ts`), and the health probe no
  longer asks that server for the ONE path a page may read (`/fc/primary-address`)
  — which is what used to measure it "reachable", park the reader on it, and make
  every real read fail. Analytics with no `VITE_POSTHOG_API_KEY` in the build
  sends nothing (`src/constants/analytics.ts`). `/fc/*` is untouched (it answers,
  and it is not routed through the seam).
  Verify with `scripts/verify-no-off-site-reads.mjs` against the served origin:
  same harness, pre-fix 374 reads / 24 refused by CORS / 2 PostHog with
  `REPLACE_ME` → FAIL; fixed 351 reads / 0 refused / 0 PostHog → PASS, and the
  "Unseen counts couldn't load — Farcaster didn't answer. Retrying." banner that
  the parked reader used to carry is gone.
- Farcaster's wallet modal frame (`wallet.farcaster.xyz`) measures itself with
  its own PostHog key inside its own document, so a page that frames it will show
  those requests in the network panel. Not this client's doing, and not fixable
  from here; `verify-no-off-site-reads.mjs` reports them as another document's.
- `VITE_WALLETCONNECT_PROJECT_ID` is not set in the release build (the working
  clone's `.env.local` holds a placeholder), so WalletConnect-based wallets
  stay unavailable; the node picker and the public relay work without it.
- The miniapp's launch URL still opens the read-only preview at `/farcaster`.
  Pointing it at the client is a product decision, not a deploy detail.

## Release `692377d…` — a photo in a cast renders as a photo

Released 2026-10-21, CI `39599584948` (lint / typecheck / test, all success on
the sha). What it carries, all of it in `apps/farcaster-web`:

- a cast's embed is a bare URL on the protocol, and the node adapter used to
  classify one by file extension — which `https://imagedelivery.net/<account>/
  <id>/original` does not have, so a user's photo landed in the link bucket and
  drew as a chain-link icon over a blank meta box. `snapchain/nodeApi/
  embedKinds.ts` now asks each URL's own media type (one bounded `HEAD`, then one
  ranged `GET`, then a browser `Image()` load), cached per session and in
  `localStorage`, capped at four probes in flight with a 1.5s wait per page so a
  slow host cannot hold the feed open. A URL nothing can answer for stays a link
  card; a video container the renderer plays goes to `embeds.videos`.
- the classification happens per page, before any cast is built, so a photo is a
  photo on the first paint rather than after a reload.

Measured on the live site, after the cut-over — `scripts/verify-embed-images.mjs`
against **`https://fiddy.fun`**, signed in as the account from the report (SIWF
relay stubbed with a real SIWE message): **9/9**.

| What it measures | Result, on `692377d…` live at fiddy.fun |
| --- | --- |
| the reported cast's photo, from the node's own bytes | 523 casts read; the cast among them; one `<img>`, `…/a62d038c…/rectcontain3` |
| that it really drew | `1284x335` (a loaded box, not a broken image) |
| it did not call every URL a photo | 201 embed URLs, 109 of them pages, **0** drawn as images |
| avatars | the node's own pfp URL rendered, `48x48`, loaded |
| the mechanism | 9 `HEAD` to `imagedelivery.net` before the photo was drawn |
| the read itself | 12 node routes, all `200` |

Same probe against the local probe server on the same commit: 9/9. The style pass
over the new files (`692377d`'s parent) is what the CI lint gate needed; the
branch as first written had 20 errors in it, all mechanical.

Run it yourself:

```bash
cd apps/farcaster-web
SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
npx vite --config scripts/probe.vite.config.mjs --port 5174
EMBED_SERVER=https://localhost:5174 node scripts/verify-embed-images.mjs
```

Both variables, and the trap is silent: with only `SNAPCHAIN_HTTP_URL` the shell
does not consider a node configured (`isNodeConfigured()` reads
`VITE_SNAPCHAIN_HTTP_URL`), a completed sign-in lands on the device-only landing,
and the run measures an empty feed — 0 casts read, 2/9 — which looks exactly like
the bug you are trying to fix. Point `EMBED_SERVER` at `https://fiddy.fun` to run
the same nine checks against the release.