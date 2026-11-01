# What a mini app can do inside Fiddy: the host, audited against the spec

`t_1e01f488`. This is the deep half of the mini app work: not "does a card
render" (that was measured and landed — `docs/CLIENT-MINIAPP-FEED.md`), but what
a mini app can actually DO once it is running inside this client, held against
the official specification, plus the hosting details a shared link needs.

Every claim below says which kind of claim it is: **measured** (a command ran and
this is its output), **read** (this is what the installed package or the
committed source says, with the file and line), or **not verified** (it follows
from the other two and has not been watched happen).

The two sources of truth for the surface are the installed packages this client
builds against — `@farcaster/miniapp-core@0.6.0` (the host interface and the
context it must answer with) and `@farcaster/miniapp-host@0.3.0` (the wire that
carries it into the frame) — and the spec at
`miniapps.farcaster.xyz/docs/specification` (**read** 2026-10-22: `context` +
actions `addMiniApp`, `close`, `composeCast`, `ready`, `openUrl`, `viewProfile`,
`viewCast`, `swapToken`, `sendToken`, `viewToken`, plus events, the
`.well-known/farcaster.json` manifest and its webhooks).

---

## 1. The surface, member by member

**Read**: `MiniAppHost` in `@farcaster/miniapp-core@0.6.0` `src/types.ts:105-135`,
against what this client wires in `apps/farcaster-web/src/components/miniApp/MiniApp.tsx`.

| member | wired at | verdict |
| --- | --- | --- |
| `context` | `MiniApp.tsx:927-947` | works (user, location, client, features) |
| `close` | `MiniApp.tsx:410` | works |
| `ready` | `MiniApp.tsx:439` | works; the options argument (`disableNativeGestures`) is accepted and ignored — on the web there is no native gesture layer to disable |
| `openUrl` | `MiniApp.tsx:486` | works (`https://` only, which is what `useExternalNavigate` takes) |
| `signIn` | `MiniApp.tsx:636` | works (SIWF, via `SignInProvider`) |
| `signManifest` | `MiniApp.tsx:499` | works (`experimental.signManifest`) |
| `setPrimaryButton` | `MiniApp.tsx:508` | works; the press is emitted back as `primary_button_clicked` (`:519`) |
| `ethProviderRequest` | `MiniApp.tsx:526-533` | **was `Error('not implemented')` — see §3; now forwards to the instrumented wallet** |
| `ethProviderRequestV2` | not ours | supplied by the host package out of `ethProvider` (`@farcaster/miniapp-host/dist/helpers/endpoint.js:12`) |
| `eip6963RequestProvider` | `MiniApp.tsx:968` | works (announces a provider named Farcaster, rdns `xyz.farcaster.MiniAppWallet`) |
| `solanaProviderRequest` | `MiniApp.tsx:778, 955` | works (the Solana wallet provider, passed through) |
| `addFrame` | not ours | supplied by the host package as an alias of `addMiniApp`, with the SDK's result/error envelope (`dist/helpers/sdk.js:5-25`) |
| `addMiniApp` | `MiniApp.tsx:567` | works (confirm → favourite → emit `miniapp_added` with notification details) |
| `viewCast` | `MiniApp.tsx:721` | works (navigates the client's own conversation route) |
| `viewProfile` | `MiniApp.tsx:905` | works |
| `viewToken` | `MiniApp.tsx:982` | works (opens the wallet's Token surface) |
| `sendToken` | `MiniApp.tsx:1064` | works (wallet send sheet; reports the transaction) |
| `swapToken` | `MiniApp.tsx:1004` | works (wallet swap sheet; reports the transaction) |
| `openMiniApp` | `MiniApp.tsx:886` | works (`actions.openMiniApp`, with the referrer domain) |
| `composeCast` | `MiniApp.tsx:679` | works (text, embeds, channelKey, parent, `close`), and the result resolves or resolves-to-undefined on close |
| `updateBackState` | `MiniApp.tsx:961` | works; the host emits `back_navigation_triggered` when the app's own back is used (`:558`) |
| `getCapabilities` | `MiniApp.tsx:803-827` | 18 strings, see §2 |
| `getChains` | `MiniApp.tsx:830` | works (`eip155:*` chain ids + Solana mainnet) |
| `impactOccurred` / `notificationOccurred` / `selectionChanged` | `MiniApp.tsx:781-797` | no-ops, and `context.features.haptics` is `false` — the honest refusal, see §2 |
| `requestCameraAndMicrophoneAccess` | `MiniApp.tsx:799-801` | no-op, and `context.features.cameraAndMicrophoneAccess` is `false` |

**Read**, and worth naming because it is where most of the wire actually lives:
the frame is driven by `@farcaster/miniapp-host`, not by this repo —
`createIframeEndpoint` builds the endpoint (`MiniApp.tsx:547-560`) and
`useExposeToEndpoint` exposes the SDK into the frame (`MiniApp.tsx:1335-1341`),
handing the host package `ethProvider: instrumentedProvider`. So "the wallet
works from a mini app" is true on the V2 channel by construction, and this
client's job is to make sure the functions the package calls are real.

### Location contexts

**Read**: this client produces the spec's location types rather than defaulting
to `launcher`: `cast_embed` when a mini app is launched from a cast embed
(`MiniApp.tsx:266`, `:1750`), `launcher` from search, the mini app rail,
trending lists and featured notifications (`src/components/search/Search.tsx:347`,
`src/components/rightSidebar/MiniApps.tsx:30`,
`src/components/apps/TrendingMiniAppListItem.tsx:30`), `channel` from a channel
header (`src/components/channelsV3/ChannelHeaderChannelMetadata.tsx:101`),
`notification` from a notification group
(`src/components/notifications/MiniAppNotificationGroup.tsx:60`), and
`open_miniapp` when one mini app opens another (`MiniApp.tsx:869`).

---

## 2. Capabilities: declared vs backed, and what is honestly refused

**Read**, `getCapabilities` at `MiniApp.tsx:803-827` — every string it declares is
backed by a real implementation except the haptics/camera trio, which it does
NOT declare (correctly), and `wallet.getEvmProvider` /
`wallet.getEthereumProvider`, which it DID declare while the function behind them
threw (§3).

Refused on purpose, and said so in the context the app reads:

- **Haptics** — `context.features.haptics: false` (`MiniApp.tsx:946`) plus three
  no-op handlers (`:781-797`). The web has no way to ask for the platform's own
  feedback language: iOS Safari has no Vibration API at all, and Chromium's
  `navigator.vibrate(ms)` is a buzz with no notion of light/medium/heavy or
  success/warning/error. A mini app that needs haptics should be told no, not
  handed a buzz that fires on some devices and not others.
- **Camera and microphone** — `context.features.cameraAndMicrophoneAccess:
  false` (`:947`) and a no-op handler (`:799-801`), so a well-behaved app is
  told no. **Measured on main while writing this**: the launch iframe still asks
  for them (`allow="microphone; camera; clipboard-write"`,
  `MiniApp.tsx:1493`) — but the document's own `Permissions-Policy` denies both
  (`camera=(), microphone=()`), and per the spec a child frame cannot be granted
  what its parent denies, so the request cannot succeed. The one-line tightening
  (clipboard-write only) is card `t_f5143ed9`'s and lives on that card's branch
  `t_f5143ed9-miniapp-media-perms` (`f4d99b8`) — **not on main**, so this card
  leaves it there rather than landing a sibling's change inside its own diff.
- **Native gestures / safe-area insets** — no web equivalent; `ready`'s option is
  ignored and `client.safeAreaInsets` is left unset (both are optional in the
  spec's `ClientContext`).

---

## 3. The gap that was real, and what changed

**Read**, before this card, `MiniApp.tsx:518-520`:

```ts
const handleProviderRequest = useCallback(async () => {
  throw new Error('not implemented');
}, []);
```

That function is `sdk.ethProviderRequest` — the wallet channel an older mini app
SDK calls (`@farcaster/miniapp-core` `types.ts:120`, `WireMiniAppHost`). The
comlink wire dispatches it straight through
(`@farcaster/miniapp-host/dist/comlink/comlink.js:123-124`). So: a mini app on
the older SDK asks for the reader's wallet, and gets `not implemented` — while
this same host declares `wallet.getEvmProvider` and `wallet.getEthereumProvider`
in `getCapabilities` "in case of a mini app with an old SDK"
(`MiniApp.tsx:803-805`). A declared capability that throws is not a refusal; it
is a wallet button dying inside somebody's app with a message nobody can act on.

What landed instead (`src/components/miniApp/legacyWalletChannel.ts`, wired at
`MiniApp.tsx:526-533` and `:1347`):

- the channel forwards the request to the **same instrumented provider** the V2
  channel uses — the one that already re-asks for accounts when the wallet
  answers `UnauthorizedError` (`MiniApp.tsx:1309-1317`);
- the provider is reached through a getter over a ref, filled during render the
  moment the wallet is instrumented, because the SDK object is built ABOVE the
  wallet in this component: a captured provider would be the empty one from the
  render that had no wallet;
- with no wallet in the session it throws `No wallet is connected in Fiddy` —
  a sentence a mini app can read and show.

Four unit tests hold it (`src/components/miniApp/__tests__/legacyWalletChannel.test.ts`):
forwards and answers, reads the wallet at call time, names the refusal, and does
not swallow a refusal the wallet itself makes.

**Not verified**: no real mini app on the older SDK was driven against the fixed
channel in a browser during this card. The wire is read, not watched — the
browser probes that could watch it need the client running and a machine that is
not at load ~200 (see §7).

---

## 4. The hosting details: a shared fiddy.fun link

**Measured**, `curl -s https://fiddy.fun/` on 2026-10-22, before this card: the
served shell carried `og:` tags **zero** times, and `<title>Fiddy</title>` was
the whole of its metadata. The one 1200×630 image on the host was
`/opengraph.png`, which is **upstream Farcaster's purple brand card** (viewed,
not guessed) — a different product's art, for a different product's link.

**Measured** now, on the same host: `/fiddy-share-card.png` is Fiddy's own
1200×630 (1200×630, 146 KB), drawn from the mascot still the chrome already
ships (`fiddy-mark-poster.png`) by `apps/farcaster-web/scripts/render-share-card.mjs`
(Playwright + the reader's own Chrome, the same `channel: 'chrome'` the probes
use; no network). `curl -sI https://fiddy.fun/fiddy-share-card.png` answers 200
with the right content type after this card's release.

The shell now declares, statically:

- `og:type`, `og:site_name`, `og:title`, `og:description`, `og:image`,
  `og:image:width`/`height` (1200/630) and `og:image:alt`;
- `twitter:card: summary_large_image` with its own title/description/image;
- `description`;
- **and an `fc:miniapp` embed**, so the same URL is a launchable mini app card —
  `imageUrl` is `/fiddy-embed.png`, the manifest's own 3:2 image (1200×800,
  drawn from the repo's mascot by `scripts/render-share-card.mjs`; card
  t_90a2eee2), the action is `launch_miniapp` named `fiddy` (the manifest's
  `name`), and the splash ground is the app's own `#161715` — the same ground
  the listing manifest paints (card t_8654d91e; all of it is pinned by
  `src/__tests__/wellKnownManifest.test.ts` and the release's
  `scripts/check-manifest.mjs`).

**Deliberately absent**: no static `og:url`. This one document answers for every
route, so a static front-door `og:url` would tell an unfurler that a shared cast
or profile link is really the front door — a platform that honours it would
rewrite the link. A test pins the omission (`src/__tests__/sharedLinkMeta.test.ts`).

**Not done, and honestly so**: *per-page* cards. A cast URL or a profile URL
still unfurls with the site card above, not its own. The client DOES set
per-page `og:` tags at runtime (`src/components/page/PageMeta.tsx`, mounted by
`Page.tsx:25`, with `Conversation.tsx:161` passing the cast's own image when it
has one) — but a crawler never runs that JavaScript, so it sees the shell. The
quilcast pattern (a server that renders a 1200×630 card per surface) needs an
HTML-rendering surface in front of the SPA, which this repo does not have: the
release ships a static `web/` plus a `server/` it carries forward **from the
previous release, unchanged** (`scripts/release-client.sh:203-206`, gated at
`:238`). That is a card of its own, not a client change — see §8.

---

## 5. The composer, and sharing a mini app

**Read**, so nobody re-measures it:

- Pasting a URL into the composer resolves it through the same reader the feed
  uses (`src/snapchain/nodeApi/embedCards.ts`), and a page that declares
  `fc:miniapp` renders the **mini app card** in the preview, not a link card:
  `src/components/composer/components/ComposerOpenGraphAttachment.tsx:167-188`
  → `ComposerFrameEmbed` (`:334`, the `disabled` preview at `:374`) → `FrameEmbedAttachment ... disabled`.
  The preview is deliberately not launchable — you are composing, not playing —
  and posting carries the URL as the cast's embed, which is the in-feed card
  that DOES launch (measured in `docs/CLIENT-MINIAPP-FEED.md` §2).
- Sharing an app out of the mini app window already exists: the header computes
  the canonical URL and copies it (`MiniApp.tsx:1749`, `:1896`).
- Sharing a CAST produces a `farcaster.xyz` link, not a fiddy.fun one:
  `getCastURL` (`packages/farcaster-client-data/src/utils/CastUtils.ts:8-20`)
  is what `ShareCast`'s copy-link writes (`src/components/casts/actions/ShareCast.tsx:187-195`).
  That is upstream's behaviour and it is no longer forced: until this card a
  fiddy.fun link unfurled as nothing, so pointing a share at it would have been
  strictly worse. Switching that URL is now a product decision with a real card
  behind it (§8) — it belongs with the per-page cards, because a cast link that
  says nothing is not an improvement.

---

## 6. Boundaries: what belongs to another card

- **Launch performance** (the quilcast speed patterns) — card `t_a6166ed6`.
  Nothing in this card touches first-open timing.
- **The 501 sweep** (`This page isn't on your node`) — card `t_e0d6f44c`.
- **One-tap connect identity** — card `t_e9657ffb`.
- **The in-feed card itself** (catalog reads, render-or-refuse) — landed
  (`ecc6127`, `9cd530e`) and measured in `docs/CLIENT-MINIAPP-FEED.md`.

---

## 7. Verification, and what it does not cover

**Run, and green** (this card's tree, `apps/farcaster-web`):

- `pnpm exec vitest run` on the three touched/added files — 30 tests pass
  (`src/__tests__/sharedLinkMeta.test.ts`,
  `src/components/miniApp/__tests__/legacyWalletChannel.test.ts`,
  `src/snapchain/nodeApi/__tests__/embedCards.test.ts`).
- The repo's own gates (`lint`, `typecheck`, the full `test` run) and the release
  ritual are recorded in the card's handoff, with their real output.

**Not run, and why** — the honest part:

- **A real mini app driven end to end in the host at both widths.** The probes
  exist and are the right ones (`scripts/verify-miniapps.mjs`, which signs in,
  finds a real `fc:miniapp` cast and presses the card; `scripts/verify-miniapp-in-feed.mjs`,
  the Beeper fixture). They could not run inside this card's budget on this
  machine: the host's load average sat between 50 and 240 while several sibling
  builds ran, and the skill's own rule applies — a starved browser fails on page
  load, which is environmental, not a finding. The next run of
  `verify-miniapps.mjs` on a calm machine is what closes this, and the card that
  owns the release owns that run.
- **The per-page unfurl** (§4) — not built, carded.

**Also worth knowing** (measured while working): `/image.png`, `/icon.png` and
`/splash.png` — the three assets the manifest pointed at on 2026-10-22 — all
answered 200 on the host, and the manifest IS signed (`accountAssociation` with
header/payload/signature for `fiddy.fun`). But `/splash.png` was 512×512 where
the spec asks a splash to be 200×200, the manifest's `splashBackgroundColor` was
`#6200EA` — upstream Warpcast's purple, not this brand — and its `description`
sold a different product ("deploy always on agents with onchain identities")
than the shell unfurls. All three are fixed, and the manifest is no longer
VPS-only state: card t_8654d91e moved the copy into the repo at
`apps/farcaster-web/public/.well-known/farcaster.json`, had the release install
it (step 7) behind the `check-manifest.mjs` gate, and pointed the splash at the
200×200 `/fiddy-splash.png` that the shell's embed already used, so the listing
and the link describe one product. The signed `accountAssociation` carried over
byte-for-byte — nothing was re-signed. `docs/CLIENT-RELEASE.md` → *The listing
manifest* is the reference, including the two assets that were aliased into the
sibling FSSC app's asset directory: card t_90a2eee2 gave all three pictures a
home in this repo (`/fiddy-splash.png` 200×200, `/brand/fiddy-app-icon.png`
1024×1024 — the app's own icon, the same PNG the shell serves as
`apple-touch-icon` and the Expo app declares — and `/fiddy-embed.png` 1200×800,
drawn by `scripts/render-share-card.mjs`), and turned `/icon.png`, `/image.png`
and `/splash.png` into 301s to those paths, so nothing FSSC edits can repaint
Fiddy's app-list icon or its cast cards. The splash's ART was then measured, and
it was off-centre — the mark sat in the upper-left third of its own square, which
is the first frame of every launch (card t_28b3612c). It is now redrawn by a
third variant of the same generator (`node scripts/render-share-card.mjs splash`:
the mascot cropped to its own drawing, centred on `#161715` at half the square,
the share the app icon gives its mark), and `check-manifest.mjs` decodes the PNG
and refuses a splash whose drawing is not centred, so a cornered mark cannot ship
silently again.

## 8. Carded, not done

1. **A server-rendered card per surface** (cast, profile): the quarried quilcast
   pattern — answer a crawler with HTML carrying that page's own `og:` tags and
   a 1200×630 card drawn for it — plus, once that exists, pointing cast shares
   at `fiddy.fun` instead of `farcaster.xyz`.
2. **The agent bridge for mini apps**: a mini app asking the reader's agent to do
   something (an honest "your agent" bridge, consented, with the same
   refuse-by-name rule as everything else). The card asked for this to be carded
   first because it is big: what a mini app may ask an agent for is a product and
   safety decision, not a wire to fill in.
3. ~~**The listing's two remaining host-aliased assets**~~ — **done**, card
   t_90a2eee2. `/icon.png` and `/image.png` were vhost aliases into
   `/var/www/fiddy-fssc/assets/`, a sibling app's directory (and, measured, that
   sibling's judge art — not Fiddy's). Both pictures are files in this repo now
   (1024×1024 and 1200×800) and the three root paths the listing has ever named
   redirect to them.