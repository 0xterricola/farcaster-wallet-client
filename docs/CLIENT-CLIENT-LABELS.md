# Which app made a cast — the label, and the filter that uses it

Every Farcaster cast says which app posted it. Not a field on the cast: the
protocol records it in the *signed key request* for the key that signed the
message, and Snapchain holds both halves of that record.

## Where the answer comes from

```
cast
 └─ `signer`  (the key that signed it)
     └─ GET /v1/signer?fid&signer
         ├─ gasless key:  `requestFid` — the app FID that asked for the key
         └─ on-chain key: `metadata` — abi.encode(SignedKeyRequestMetadata),
                          whose first field is that same app FID
             └─ GET /v1/userDataByFid?fid=<appFid>   the app account's own profile
```

Both halves matter, and both are implemented in
`packages/farcaster-node-client/src/clientAttribution.ts`:

- `appFidFromSignerRecord` reads the gasless field when it is there and decodes
  the on-chain metadata when it is not. MEASURED 2026-10-24 against a live
  mainnet node: 15 casts from an open channel feed resolved to the same app FID
  the hosted indexer reports, every time — `9152` for posts made through
  Warpcast, `3356396` and `16823` for the other apps in that window.
- `createAppClientNameLookup` reads what the *app account itself* says
  (`USER_DATA_TYPE_USERNAME`, `..._DISPLAY`, `..._PFP`), cached per app FID for
  half an hour. FID 9152 says `warpcast` / `Warpcast`; FID 3356372 (this
  client's own app key) says `fiddy-one` / `fiddy one 🐣`. An app FID with no
  profile stays nameless rather than being given a vendor name this repo made
  up.

The vocabulary a resolved cast carries — `ClientKind`:

| kind | what it means | what is shown |
| --- | --- | --- |
| `self` | the key this client's own app FID asked for | `via Fiddy` |
| `known` | the app account's own profile (or the reader's own name for it, which wins) | `via Warpcast` |
| `own` | the account asked for the key itself, so no app is involved | `via their own key` |
| `unknown` | an app FID whose account says nothing about itself | `via app 3356396` |
| `onchain` | an on-chain key whose metadata names no app | `via an on-chain key` |

A **self-requested** key (`requestFid` = the author's own FID) is never named from
a profile, even when that account has one. That is not a detail: the "app" account
in that case IS the author, so reading its profile put the author's own name on
their own cast as if it were the client. MEASURED live 2026-10-24, fid 7237: the
card read `via Thomas`, under a cast written by Thomas (`@aviationdoctor.eth`'s
own display name). `own` is decided from the protocol, before the profile is
consulted.

## Where it shows

- **The cast card's author line** (`components/casts/CastAuthorLine.tsx`,
  `data-fiddy="cast-client-label"`) and therefore everywhere a card is drawn —
  home, following, a channel, a profile, and the conversation view. Hovering says
  what the label means.
- **A cast's own page**, which already drew a `client` row for hosted-API reads
  (`components/casts/CastDetails.tsx`); node-backed reads now fill the same field
  (`nodeApi/fromNode.ts` `apiCastClientFromIdentity`), so both sources light up
  the same surfaces.
- A cast whose client could not be established carries **no** client at all and
  is drawn without a label. No label beats a guessed one.

## The filter (hide an app, or show only one)

`Settings → Advanced → Your own setup → "Who made a cast"`
(`pages/settingsNode/Component/ClientFilterCard.tsx`) offers three plain choices
— *Show all*, *Only these*, *Hide these* — over the apps that really appear in the
sample feed above it, each with its count. Ticking an app on its own moves the
reader to *Hide these*, which is the common intent.

- The policy is stored per FID (`snapchain/nodePreferences.ts`) and held in a
  synchronous store (`snapchain/clientFilterPreferences.ts`) that the read seam
  consults on every request, so a change applies to the next page rather than
  after a reload. Saving also drops the react-query cache, so no stale page
  survives it.
- It runs on **feeds only** (`nodeApi/reads.ts` `filterFeedMessages`): home,
  following and a channel page. A conversation and a profile stay whole — hiding
  one side of a reply thread would make the thread unreadable rather than
  quieter.
- Nothing is hidden on the node: the messages stay, and this is a view.
- A name the reader types overrides the app's own profile everywhere, and
  clearing it restores the app's own name.

## How it is verified

Repo tests (no network, the recorded fixture node):

- `packages/farcaster-node-client/src/__tests__/clientFilter.test.ts` — the
  decoder (against real mainnet metadata), the resolver against the node, and
  the pure filter.
- `apps/farcaster-web/src/snapchain/nodeApi/__tests__/feedClientAttribution.test.ts`
  — a real page read: every cast labelled with the app that signed it, a cast
  signed by this client's own key reading as this client, a cast whose signer
  cannot be read carrying no label, "hide these" emptying the page, "only these"
  keeping exactly the app's casts, and no filter showing everything.
- `pnpm --filter farcaster-web exec vitest run` — 202 files, 2147 tests.

Live, signed out, no configuration:

```sh
node apps/farcaster-web/scripts/verify-client-labels.mjs
```

It reads `/explore` and `/feed` at 390 and 1440 px, asserts every cast card
carries a `via <app>` label, and then walks the protocol backwards for a sample
of them — handle → FID → `castById` → `signer` → signed key request → the app's
own profile — and compares the app it resolved with the app the page printed. A
plausible-but-wrong label fails the run. `LIVE_CLIENT_LABEL_ORIGIN`,
`LIVE_CLIENT_LABEL_NODE`, `CLIENT_LABEL_PATHS`, `CLIENT_LABEL_SAMPLE` and
`CLIENT_LABEL_SHOT_DIR` override its defaults.

It cannot check the **filter** half: that is a per-account preference, and a
worker must not mint a session. The filter is covered by the tests above and by
the settings screen's own preview feed, which applies the same policy it saves.