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

## 5. NOT verified in this session

- **Physical-device install.** `xcodebuild -destination id=00008150-…` refused
  with `iPhone needs to be unlocked to enable development services`. The build,
  the free-team setup (`DEVELOPMENT_TEAM=VQ2W66RM8Z`, automatic signing) and the
  install command are ready; the phone has to be unlocked and awake first.
- **Tapping through the UI.** The simulator here is headless (no `Simulator.app`
  window, no AppleScript UI control), so screenshots were taken after launching
  and the Agent tab was captured by temporarily defaulting the tab, then
  reverting. Every interactive control compiled and rendered; none was tapped.
- **Android, desktop, posting, hatching.** v2 by the card's own scope.

## 6. Reproducing

```
pnpm install
pnpm --filter farcaster-node-client build
cd apps/fiddy-mobile
pnpm ios                      # simulator
npx expo prebuild --clean -p ios   # regenerates ios/ including the scene-lifecycle plugin
```

`tools/ocr.py` is the OCR helper used above:
`uv run --no-project --with pyobjc-framework-Vision python tools/ocr.py shot.png`