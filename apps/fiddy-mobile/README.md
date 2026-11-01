# Fiddy for iOS — v1

The smallest testable Fiddy client: a branded Expo shell with two tabs, reading
the Farcaster network through **your own Snapchain node**, and nothing else.

```
pnpm install                                  # from the repo root
pnpm --filter farcaster-node-client build     # the app imports the built package
cd apps/fiddy-mobile
pnpm ios                                      # build + run on a simulator
pnpm ios --device "iPhone"                    # build + run on a paired iPhone
```

## What v1 is

| | |
| --- | --- |
| **Feed tab** | Your follow graph read from your node (`GET /v1/linksByFid`), their casts (`GET /v1/castsByFid`), merged locally on the Farcaster timestamp. No indexer, no API key, no third party. |
| **Agent tab** | The NOT-HATCHED surface: what a Fiddy is, what this build does, and one real action — "Hatch your Fiddy" opens `https://fiddy.fun/start` in the system browser (outside the app, so the page inherits no app session). |
| **Node pill** | "served by your node" — green only while the node is answering, with host and latency behind a tap. Never a claim it cannot back. |
| **Brand** | Fiddy icon, splash, chartreuse `#D4FF3F` on `#161715`, glass surfaces. No Warpcast/Farcaster marks. |

**Why a new app instead of reskinning `apps/farcaster-mobile`:** that app is the
full Warpcast client — 1,646 TypeScript files, 1,012 of them mentioning
Farcaster, needing Privy, Datadog, Firebase and its own auth backend before it
will show anything. It cannot become a runnable v1 in one release, and every
claim in this card would have been untestable through it. This app inherits the
monorepo's toolchain (Expo 55.0.24, RN 0.83.6, pnpm 10.8.1, the monorepo Metro
config, the same `farcaster-node-client`), not its surface area.

## Hard constraints, and how they are enforced

- **No seed phrase anywhere near v1.** There is no wallet, no signer, no
  keystore code in this app. Randomness comes from the OS CSPRNG
  (`expo-crypto`), never a JS fallback — the only thing that needs randomness is
  signing, and signing is v2.
- **No API keys in the bundle.** Reads are unauthenticated `GET /v1/*`. The
  only baked-in value is a node URL, which is a hostname, not a secret.
- **Honest soon-tags.** Everything not in this build is labelled `soon` on the
  Agent tab, and the feed says "read-only in v1" rather than implying posting.

## Where reads come from

`src/node/nodeConfig.ts` resolves one URL in this order:

1. `EXPO_PUBLIC_FIDDY_NODE_URL` (build-time env — see `.env.example`)
2. `extra.fiddy.nodeUrl` in `app.json`
3. `DEFAULT_NODE_URL`, this repo's Fiddy node

The node pill reports which one is in force, and the node sheet lets you point
the running app at another node (a LAN box, an SSH tunnel to `127.0.0.1:3381`,
or a public hub for comparison). That override is session-only: v1 keeps no
preferences on disk, and says so in the sheet.

## Verifying it actually works (not just that it bundles)

"Metro resolved the import" is not evidence that the read path runs on Hermes,
which has no `Buffer`, a `crypto` object that is not Node's, and its own text
codec. So the app ships the check: **node sheet → On-device checks**, which runs
on the device and prints PASS/FAIL per check.

1. `Buffer` — utf8/base64/hex round-trips (`@farcaster/core` uses
   `globalThis.Buffer` in its protobuf helpers)
2. `TextEncoder`/`TextDecoder` — multi-byte round-trip, reports native vs shim
3. Farcaster time — epoch and `toFarcasterTime`/`fromFarcasterTime` drift
4. **Noble Ed25519** — signs a 32-byte hash with a public test vector and
   verifies it, cross-checked against the public key the same seed produces on
   Node (`79b5562e8fe654f94078…`), and rejects a tampered hash
5. **Cast build+sign** — `makeCastAdd` → blake3 hash → Ed25519 signature →
   protobuf encode → decode, all on device. **Nothing is submitted.**
6. Node read — health plus a real `castsByFid` decode from the node above

No user key is involved in any check, and `src/dev/selfTest.ts` contains no
`submitMessage` call.

## Layout

```
App.tsx                     shell: gradient, header, node pill, tabs
index.js                    entry: polyfills first, then the app
src/polyfills.ts            Buffer / TextEncoder / TextDecoder / crypto honesty
src/shims/util.js           what @farcaster/core's static require("util") resolves to
src/node/nodeConfig.ts      which node, from where, and how to normalise a typed URL
src/node/nodeSession.ts     one client + health poll + the locally assembled feed
src/node/profiles.ts        display names from userDataByFid, bounded fan-out, cached
src/components/             glass card, node pill + sheet, fid sheet, cast card, tab bar
src/dev/selfTest.ts         the on-device checks above
```

## v2 (not here yet)

Posting/reacting/following through the node with a gasless app key, hatching your
Fiddy, resolving your FID from the key you authorize, Android, desktop.

## Verified, and not

`VERIFICATION.md` records exactly what was run, what passed on the device, and
what was not verified (the physical-device install needs the iPhone unlocked —
xcodebuild refuses with `iPhone needs to be unlocked to enable development
services`).