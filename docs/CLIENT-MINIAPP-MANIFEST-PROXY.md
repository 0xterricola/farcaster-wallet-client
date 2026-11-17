# The mini app manifest proxy: the app's name, read by us for the reader

Card `t_5dfc9e8b`. The launch surface — the card in the feed and the window it
opens — needs what a mini app declares in its `/.well-known/farcaster.json`:
its name, its icon, its splash. The pattern is quilcast's (MIT,
`backmeupplz/quilcast`, `server/notify.mjs`'s `manifest()` and
`/api/manifest`): the browser asks OUR host, and OUR host talks to the app's.
Re-implemented in this repo's shape, not copied.

## Why it exists

The feed half needs nothing: a cast's `fc:miniapp` tag names the card, the
button and the address the button opens, and `embedCards.ts` reads it from the
page itself. But the tag says nothing about the app's NAME, and a signed-out
reader on the node-only chain has no hosted API left to ask — before this, the
launch opened the app anonymous (no name, no splash) or leaned on Neynar frame
details that are a bonus, never a requirement.

## The three pieces

1. **The route** — `GET /api/manifest?origin=https://example.com`, answered by
   the unfurl service (`server/unfurl/handler.mjs`, the capability mounted
   beside `/api/img` and `/api/translate`). The origin parameter is validated
   before any fetch (https, front door only, no credentials in the URL), the
   read goes through `createSafeGet` (public hosts only, every redirect hop
   re-checked, 64 KB cap), and the answer is the launch half only:
   `miniapp`/`frame` `name`, `iconUrl`, `homeUrl`, `splashImageUrl`,
   `splashBackgroundColor`. `webhookUrl` is stripped in the service and never
   leaves it — this host runs no mini app notifications yet.
2. **The cache** — ten minutes server-side, `max-age=600` in the header, and
   the service REFUSES to be built with a TTL over one hour. That ceiling is
   the one-hour rule (card `t_f50c14a1`, from quilcast 0.70.1): a manifest
   carries the app's launch address, and quilcast's own day-long cache kept
   opening a moved app at its old address for a day.
3. **The client** — `src/utils/miniAppManifest.ts` fetches
   `/api/manifest?v=1&origin=…`: same-origin, credentials omitted, an
   in-memory cache of ten minutes, and the `v=1` in the path is the rule's
   client half — bumping it reaches every browser a server purge cannot.

## Where its answer is used

`LaunchMiniApp` (`components/miniApp/MiniApp.tsx`) prefers, in order:

1. the hosted API's frame details (`useNonSuspenseFrameDetails`) — still the
   best answer when a key exists: it knows the author, the viewer's state;
2. this host's manifest proxy;
3. what the cast's own `fc:miniapp` tag declared, carried through the launch
   config (`FrameEmbedNext` passes `action.name` and the splash fields).

The launch URL itself is never one of these. The tag named it; it is the URL
the card opens.

## The nginx location

The vhost's `location ^~ /api/ { return 404; }` refuses every unlisted API
path, so the route needs its own exact match, installed beside the other
capability blocks (see `docs/CLIENT-IMAGE-PROXY.md` for the convention — the
`/api/*` capability locations live in the vhost, not the unfurl snippet):

```nginx
location = /api/manifest {
    proxy_pass http://127.0.0.1:3220;
    proxy_set_header Host fiddy.fun;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    # One manifest read is a bounded fetch of 64 KB; this outlives it.
    proxy_read_timeout 20s;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
}
```

The release ships `server/miniapp/` (`release-client.sh`'s SERVICE list); the
location is vhost state, added when this card deployed.

## Held by tests

`src/__tests__/miniappManifestProxy.test.ts` (service + route) and
`src/utils/__tests__/miniAppManifest.test.ts` (browser half): the read, the
refusals, the one-hour ceiling, the versioned key, and that `webhookUrl` never
comes back.
