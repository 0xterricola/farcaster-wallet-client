# Fiddy iOS v1 — what was verified, on what, and how

Every claim below is from a command that ran, not from a design intention. Where
something was **not** verified it says so.

## 1. The app launches on the iOS 27 simulator

```
cd apps/fiddy-mobile/ios
xcodebuild -workspace Fiddy.xcworkspace -scheme Fiddy -configuration Debug \
  -destination "platform=iOS Simulator,id=4975AB8E-EC9C-412E-9072-876BBE7A21CB" \
  -derivedDataPath ../build-ios-sim CODE_SIGNING_ALLOWED=NO build
xcrun simctl install <udid> build-ios-sim/Build/Products/Debug-iphonesimulator/Fiddy.app
xcrun simctl launch <udid> fun.fiddy.app
```

**BUILD SUCCEEDED**; app installed and launched. Two launch crashes were found
and fixed on the way (both real, both reproducible):

| What broke | Why | Fix |
| --- | --- | --- |
| `EXC_BREAKPOINT` at launch, `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` | Apps built with the iOS 27 SDK must adopt the scene-based life cycle (TN3187). Expo SDK 55's template still starts React Native from `didFinishLaunchingWithOptions` and has no `UIApplicationSceneManifest`. | `SceneDelegate` + `UIApplicationSceneManifest`, encoded as `plugins/withSceneLifecycle.js` so `expo prebuild` reproduces it. |
| "Network request failed" against every node | The generated `NSAppTransportSecurity` had **both** `NSAllowsArbitraryLoads` and `NSAllowsLocalNetworking`. When the local-networking key is present, ATS ignores arbitrary loads, so cleartext HTTP to the node's IP was blocked. | Dropped `NSAllowsLocalNetworking`, added an explicit `NSExceptionDomains` entry for the node host. |

## 2. The Feed reads the user's own node — verified on device, by text

Screenshots were OCR'd locally (Vision framework, `tools/ocr.py`) rather than
eyeballed, so the text below is what the screen actually said:

```
• Fiddy
• served by your node          ← the node pill, healthy
Feed   Agent
YOUR FEED                                  fid 3
60 casts from 34.101.47.167:3381
Greg @greg now                             oh so we're time traveling now?
:grin: @grin 5h                            Marrakech goes hard      in ~/channel/grin
Darryl Yeo @darrylyeo 6h                   Lanna was epic!
adrienne @adrienne 10h                     Which community will I be seeing you at next??
```

That output is the whole read path working on Hermes: `GET /v1/linksByFid`
(follow graph) → 79 `GET /v1/castsByFid` (one per follow, concurrency 6) → merge
on the Farcaster timestamp, plus `GET /v1/userDataByFid` for display names. Live
timestamps ("now", "5h", "10h") are the proof the data is current, not cached.

**A bug this exposed and fixed:** the node pages *oldest first* unless asked
otherwise, so the first working build showed casts from July. Measured directly:

```
$ curl "…/v1/castsByFid?fid=3&pageSize=3"           → timestamps 60212418 (2022-era)
$ curl "…/v1/castsByFid?fid=3&pageSize=3&reverse=true" → timestamps 182745002 (now)
```

`packages/farcaster-node-client/src/feed.ts` now sends `reverse: true` for
`fetchCastsByFid` and `fetchFollowing`; `pnpm --filter farcaster-node-client test`
→ **73 passed, 9 skipped** after the change.

## 3. On-device compatibility checks (the card asked for these explicitly)

`src/dev/selfTest.ts` runs on the device; `App.tsx` prints the results to the
Metro console on every dev launch. Copied verbatim from the device's own output:

```
[fiddy self-test] PASS Buffer: utf8+base64+hex ok (deadbeef)
[fiddy self-test] PASS TextEncoder/Decoder: 21 bytes round-tripped (shim)
[fiddy self-test] PASS CSPRNG: 16 bytes from the OS per call, uuid 0ec93dd9…
[fiddy self-test] PASS Farcaster time: epoch ok, round-trip drift 49ms
[fiddy self-test] PASS Noble Ed25519: 64B signature matches the Node-computed key 79b5562e8fe654f94078…, tamper rejected
[fiddy self-test] PASS Cast build+sign: 238B protobuf, 64B sig, hash 9f9c91ee8518… (not submitted)
[fiddy self-test] PASS Node read: 5 casts decoded from fid 3 in 570ms · From your POV, what's:
```

Notes on what those mean, because "PASS" is not self-explanatory:

- **TextEncoder/Decoder says "shim"** — RN 0.83 on Hermes has no native text
  codec, and `@farcaster/core` constructs one at module scope. Without
  `src/polyfills.ts` this is an immediate launch failure. Assumed-broken would
  have been wrong in the other direction too: the shim round-trips multi-byte
  text correctly (checked with `Fiddy · 🥚 é 𝟘`).
- **Ed25519 is cross-checked against Node.** The same seed produces
  `79b5562e8fe654f94078…` in both runtimes, so Hermes' pure-JS curve code is
  bit-identical, and a tampered hash is rejected.
- **Cast build+sign** is the full write path (`makeCastAdd` → blake3 hash →
  Ed25519 → protobuf encode → decode) minus the network. `selfTest.ts` contains
  no `submitMessage` call; the signing seed is bytes 1..32, a public test vector.
- **CSPRNG** comes from `expo-crypto` (the OS RNG). This was the third launch
  crash: something in the import graph requests randomness during startup, and a
  JS fallback would have been a silent key compromise. Now it is the real OS RNG,
  checked for non-trivial output and for two calls differing.

## 4. Brand

`simctl` screenshot of the home screen shows the app as **Fiddy** with the
charteuse Fiddy mark (`assets/icon.png`, 1024×1024 from the brand set); the
in-app splash is `assets/splash.png` on `#161715`; no Warpcast/Farcaster marks
anywhere in the app, and the word "Farcaster" appears only where the protocol is
named (Farcaster time, Farcaster timestamp).

## 5. Farcaster Articles read as one article (`t_6e650073`)

Four optional `CastAddBody` fields (per FIP “Cast Format and Chained Casts”,
snapchain v0.16.0) turn a chain of casts into one piece: `format_version` says
the text is article Markdown, `chain` says which part this is. The client decodes
them, enforces the reader rules, assembles the chain in one read, and renders it.
An older node simply omits them, and the cast stays a plain cast.

**The reader rules are tests, not claims**
(`packages/farcaster-node-client/src/__tests__/article.test.ts`, 29 tests):
index 0 carrying a root, index > 0 without one, `index >= count`, `count > 100`,
a root that is not the author's own cast, a duplicate index resolved by later
timestamp then greater hash, a partial chain reported incomplete, and a decode of
a real node's message with neither field producing a plain cast rather than an
error. The fixture is a **real chain read from a live node**, not a hand-built
string: fid 1's “Introducing Farcaster Articles!”, captured from
`haatz.quilibrium.com` (mainnet, snapchain v0.17.7), stored in
`src/__tests__/fixtures/articleChain.json` with the two requests that produced it
in its header.

```
$ pnpm --filter farcaster-node-client test
Test Files  8 passed | 3 skipped (11)
     Tests  133 passed | 9 skipped (142)
$ pnpm --filter farcaster-node-client typecheck   # clean
$ pnpm --filter fiddy-mobile typecheck            # clean
```

**The screens.** Five 390 pt screenshots in `evidence/` (see its README for the
OCR transcripts): the feed row with `Article · 2 parts →`, the article top, the
article body with the `[$1]` embed in place, the incomplete-chain copy, and the
failed-chain copy. The last two come from
`tools/articleStubNode.mjs --incomplete` / `--fail-chain`, which forwards to the
same live node and only shapes the chain read.

**The rendered subset**, read back from those screens: `##` does not print, so
`The Basics` is a heading; `**bold**` does not print its asterisks (`Bold,
italic and strikethrough` are styled); a table stays literal pipe text; a bare
URL prints as a link. Two cases the live article does not contain — **a code
fence stays literal** and **an escaped `\*` prints as `*`** — are read back from
the renderer's tests (`articleMarkdown.test.ts`, “leaves a fenced block literal”,
“prints an escaped asterisk as an asterisk”), not from a photograph.

**Bundle.** Measured the same way as the previous card, on the same Node, by
exporting the iOS bundle on the base commit and on this branch:

```
base d424656b   10,366,498 bytes
branch          10,436,387 bytes
delta              +69,889 B  (+0.674%)
```

**Gates that do not pass, and why they are not this card's**

- `pnpm lint` at the repo root stops on `farcaster-analytics`, and the
  `farcaster-node-client` package reports 14 `prettier/prettier` errors in
  `clientFilter.test.ts`, `feedPagination.test.ts`, `http.test.ts`, `feed.ts` and
  the tail of `http.ts`. **The pristine base commit d424656b reports the same 14
  errors in the same five files**, measured by running `eslint` in a second
  worktree checked out at d424656b. Every file this card touches is clean under
  `eslint` when linted by name.
- A repo-wide `pnpm typecheck` / `pnpm test` cannot complete in this environment
  for reasons that predate the branch: several packages have no built `dist`
  (`farcaster-cryptography`, `-web`, `farcaster-analytics`), `pnpm build:packages`
  fails in `farcaster-cryptography-react-native`'s `pnpm:sync` postbuild, and
  `farcaster-client-hooks` has one failing test that asserts on a
  `snap-builder-api.REPLACE_ME.workers.dev` placeholder URL. None of those
  packages is in this diff, and `farcaster-client-hooks` does not depend on
  `farcaster-node-client`, so there is no path from this change to it.

## 6. NOT verified in this session

- **Physical-device install.** `xcodebuild -destination id=00008150-…` refused
  with `iPhone needs to be unlocked to enable development services`. The build,
  the free-team setup (`DEVELOPMENT_TEAM=VQ2W66RM8Z`, automatic signing) and the
  install command are ready; the phone has to be unlocked and awake first.
- **Tapping through the UI.** The simulator here is headless (no `Simulator.app`
  window, no AppleScript UI control), so screenshots were taken after launching
  and the Agent tab was captured by temporarily defaulting the tab, then
  reverting. Every interactive control compiled and rendered; none was tapped.
- **Android, desktop, posting, hatching.** v2 by the card's own scope.

## 7. Reproducing

```
pnpm install
pnpm --filter farcaster-node-client build
cd apps/fiddy-mobile
pnpm ios                      # simulator
npx expo prebuild --clean -p ios   # regenerates ios/ including the scene-lifecycle plugin
```

`tools/ocr.py` is the OCR helper used above:
`uv run --no-project --with pyobjc-framework-Vision python tools/ocr.py shot.png`