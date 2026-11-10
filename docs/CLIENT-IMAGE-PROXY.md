# The picture proxy (`/api/img`)

Other sites' pictures, fetched and cached by fiddy.fun instead of by the
reader's browser. Before this service, every avatar, embed picture and preview
was fetched from the third-party host by whoever opened the page, so each host
learned the reader's address and referer on every render. Now the host fetches
the picture once, answers it from its own origin, and caches it.

Design borrowed from backmeupplz/quilcast (MIT, commit `7348a4a7bf5e`) — the
hardened fetcher, the magic-byte sniff and the LRU are its shapes, re-derived
for this repo's server; the Cloudflare edge-IP table and the "every picture on
the site" claim are deliberately not.

## The two halves, and the rule that keeps them one release

- **Browser:** `src/utils/externalMediaUrl.ts` `proxiedExternalMediaUrl()`
  rewrites an external picture URL to `/api/img?u=<encoded>`, but only when
  `VITE_IMAGE_PROXY=on` at build time (set by `release-client.sh`, which is the
  fiddy.fun cut) AND the page is HTTPS AND the host is not this origin, not a
  local address, and not `data:`/`blob:`. A build without the flag keeps the
  old behaviour — pictures load from where they live, which is the honest state
  for a self-hosted install that does not run the service.
- **Server:** `server/img/` (shipped in the release beside
  `server/unfurl/`) answers `GET /api/img?u=…` on the unfurl service, but only
  when `FIDDY_IMG_PROXY=on` in its environment; otherwise the route answers 404
  with one sentence ("Pictures are loaded directly on this host.").

`release-client.sh` refuses to cut over unless BOTH halves are present: the
vhost carries `location = /api/img`, and `/etc/fiddy-unfurl/unfurl.env` says
`FIDDY_IMG_PROXY=on`. No button that 404s, and no picture that silently
regresses to leaking readers.

## What the server refuses (all of it tested in `src/__tests__/imageProxy.test.ts`)

- **The address check runs inside the socket's DNS lookup** (`server/img/addresses.mjs`):
  no DNS-rebinding window. A host that answers BOTH a public and a private
  address is refused. Blocked: loopback, `10/8`, `172.16/12`, `192.168/16`,
  link-local (`169.254/8`, metadata endpoints included), CGNAT `100.64/10`
  (Tailscale lives there), `0.0.0.0`, multicast, and every IPv6 shape that is
  really one of those (`::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`,
  `64:ff9b::/96` NAT64, 6to4).
- **HTTPS only**, and every redirect hop is a new checked request; a loop ends
  at three hops.
- **A deadline** (8 s, the whole chain) and **a byte cap** (5 MB, enforced while
  the body arrives).
- **Only bytes this service can name are served** (`server/img/pic.mjs`): PNG,
  JPEG, GIF, WebP, AVIF, SVG, ICO — read from magic bytes, never the extension
  or the content-type. A picture past **50 megapixels** is refused, and an SVG
  past 512 KB.
- **The answer is inert**: `Content-Security-Policy: default-src 'none';
  sandbox`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy: same-origin`, and no referer is ever sent
  upstream.

## The cache, and the numbers a host cares about

LRU: 64 MB / 20 000 entries / nothing over 2 MB kept / a picture kept a day / a
miss held ten minutes. Two readers of one avatar cost one fetch. All
overridable: `FIDDY_IMG_CACHE_BYTES`, `FIDDY_IMG_CACHE_COUNT`,
`FIDDY_IMG_BIG_BYTES`, `FIDDY_IMG_TTL_MS`, `FIDDY_IMG_MISS_MS`,
`FIDDY_IMG_MAX_BYTES`, `FIDDY_IMG_TIMEOUT_MS`.

The per-visitor limit (120 fetches/minute) counts **fetches, not hits** — a
reader who scrolls a feed twice pays once, and a hot avatar pays nothing.

The measurement lives in `GET /unfurl/health` under `images`: entries, bytes
held, hit rate, bytes served. That is the honest way to answer "did the box's
bandwidth move", and `verify-no-off-site-reads.mjs`'s list is the honest way to
see the off-origin reads shrink.

## Verifying live

1. `curl -s https://fiddy.fun/unfurl/health | python3 -m json.tool | grep -A 8 images`
2. Pick an avatar host from a cast on `/feed`, then:
   `curl -si 'https://fiddy.fun/api/img?u=<that url>'` — expect 200, the
   picture's own content-type, `x-fiddy-img: miss`, then a second call showing
   `x-fiddy-img: hit`.
3. Read `/feed` in a browser (390 and 1440) and confirm an `<img>` whose `src`
   starts `/api/img?u=` — same-origin, page still paints.
4. A URL pointing at a private address (`http://127.0.0.1/x.png`,
   `https://internal.example/x.png`) answers 400/403 in one sentence, never a
   fetch.
