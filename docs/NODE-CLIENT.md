# The client on your own node

How `apps/farcaster-web` reads feeds and submits casts through the user's own
Snapchain read node — no Neynar, no Warpcast API, no API keys — and what was
actually verified while building it.

Code: `packages/farcaster-node-client` (the data layer) and
`apps/farcaster-web/src/{snapchain,pages/settingsNode}` (the app side).
UI surface: **Settings → Your node** (`/~/settings/node`).

## 1. The wire contract, as the node actually behaves

Read out of `farcasterxyz/snapchain`'s `src/network/http_server.rs` and confirmed
against a live read node. These are the details a client gets wrong first:

| Fact                                                                                                           | Why it matters                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/submitMessage` requires `Content-Type: application/octet-stream` and a **binary protobuf** body      | A JSON body is a 400 _before_ parsing. Writes are not JSON even though every read is.                                                                                                                                                                                                        |
| Messages must carry `dataBytes` (the JS serialization) as well as `data`                                       | The node hashes the Rust serialization; `@farcaster/core`'s `makeMessage` populates `dataBytes` for exactly this reason — the code comment says so.                                                                                                                                          |
| Enum fields arrive as proto names (`MESSAGE_TYPE_CAST_ADD`, `REACTION_TYPE_LIKE`)                              | Except `linkBody.type`, which is the protocol's free-form string (`follow`).                                                                                                                                                                                                                 |
| `reaction_type` / `link_type` query params are **snake_case** and take _Rust variant names_ (`Like`, `Recast`) | `?reaction_type=REACTION_TYPE_LIKE` is a 400: `unknown variant`. Omitting it on `/v1/reactionsByFid` is also a 400.                                                                                                                                                                          |
| Byte fields are inconsistent: `signature` is base64, `hash`/`signer` are `0x`-hex                              | One decoder handles both; guessing means garbage hashes.                                                                                                                                                                                                                                     |
| `requesterFids` is unusable over HTTP                                                                          | A single value fails (`expected a sequence`) and repeating the key fails (`Multiple values for one key`). The consequence: the **app nonce is not readable** from this API, so the client tracks it locally for self-revocation and uses `currentUserNonce` (always returned) for `KEY_ADD`. |
| Every response carries `Access-Control-Allow-Origin: *`, but **no OPTIONS handler exists**                     | CORS preflight 404s, so a browser cannot POST protobuf cross-origin. See §2.                                                                                                                                                                                                                 |
| A read node has no mempool                                                                                     | `200` means "accepted for relay to validators". Inclusion is confirmed by querying the message back.                                                                                                                                                                                         |

## 2. Why the browser talks to a relay path, not the node URL

Two independent blocks, either one fatal:

1. **CORS.** `POST /v1/submitMessage` with `application/octet-stream` is not a
   CORS-simple request, so the browser sends an `OPTIONS` preflight. The node has
   no `OPTIONS` route (it falls through to `Not Found`), so the preflight fails
   and the write never happens.
2. **Mixed content.** The dev server runs HTTPS by default in this app
   (`HTTPS !== 'false'` in `vite.config.js`), so a `http://127.0.0.1:3381` page
   request is blocked outright.

So the client talks to a **same-origin path** `/snapchain-api`, and the dev /
preview server proxies it to the node:

- `apps/farcaster-web/vite.config.js` — `/snapchain-api` → `SNAPCHAIN_HTTP_URL`
  (default `http://127.0.0.1:3381`) for both `server.proxy` and `preview.proxy`,
  because `fiddy client up --build` serves the production build through
  `vite preview`.
- `apps/farcaster-web/src/snapchain/nodeEnv.ts` — `resolveNodeBaseUrl()` returns
  `VITE_SNAPCHAIN_HTTP_URL` when set, otherwise the relay path.
- `SNAPCHAIN_HTTP_URL` stays server-side (the proxy target); it is not shipped to
  the browser.

`fiddy client up --tunnel` already produces the tunnel this expects:
`ssh -N -L 3381:127.0.0.1:3381 user@your-node`, then
`VITE_SNAPCHAIN_HTTP_URL`/`SNAPCHAIN_HTTP_URL` point at `127.0.0.1:3381`.

## 3. Gasless app keys

`packages/farcaster-node-client/src/appKey.ts`. The custody key signs **once**:

1. `GET /v1/signersByFid?fid=` → `currentUserNonce`; the `KEY_ADD` nonce must be
   strictly greater.
2. `makeKeyAddBody(...)` builds the `KeyAdd` EIP-712 payload (fid, key, keyType,
   scopes, ttl, nonce, deadline) and attaches the gasless
   `SignedKeyRequestMetadata` from the signer's
   `getGaslessSignedKeyRequestMetadata` (domain `Farcaster KeyAdd` / v1 /
   chainId 1 — the _same_ domain pair core exports and the fake node re-declares
   independently, so drift fails a test).
3. The KEY_ADD **envelope is signed by the new app key** (the node checks
   `message.signer == body.key`).
4. `POST /v1/submitMessage` to your node.
5. `GET /v1/signersByFid` until the key appears — that is the confirmation.

Scopes requested: cast add/remove, reaction add/remove, link add/remove, user
data add. TTL: the protocol maximum, 90 days, **sliding** (renewed per use).
`issueAppKey` refuses to build an inadmissible scope or a TTL over the cap, and
refuses to start when the FID is already at 1000/1000 gasless keys.

Revoking is `KEY_REMOVE` in its self-revoking form (`signatureType: 2`): the app
key signs its own removal, so **no custody key is needed** to cut access.

### The dependency pin, precisely

`@farcaster/core` is pinned to **0.20.0**. The gasless builders
(`makeKeyAdd`, `makeKeyAddBody`, `KeyAddBodyOptions`) and the EIP-712 signer
methods (`signGaslessKeyRequest`, `getGaslessSignedKeyRequestMetadata`) do not
exist in `@farcaster/core@0.19.0` — verified by grepping both published
tarballs. `@farcaster/hub-nodejs@0.17.0` depends on core 0.20.0 and re-exports
it (`export * from '@farcaster/core'`), so 0.17.0 is the hub-nodejs version that
"exports them"; 0.16.0 (core 0.19.0) does not. The browser client imports
`@farcaster/core` directly because hub-nodejs also drags in `@grpc/grpc-js`.

## 4. Reads, feeds, and what a node can't do for you

A read node answers **per-FID** queries; it is not an indexer. There is no home
feed endpoint, so the client builds one locally (`src/feed.ts`):

1. `GET /v1/linksByFid?fid=<you>&link_type=follow` — your follow graph (paged);
2. `GET /v1/castsByFid?fid=<them>` — each followee's casts, bounded concurrency
   (default 6 in flight), one failing author cannot blank the feed;
3. merge on the Farcaster timestamp, de-duplicate by `fid:hash`, cap.

Replies come from `GET /v1/castsByParent` (by cast id, or by channel URL).
Timestamps are Farcaster seconds and are converted to Unix ms in the decoder
(`timestampMs`) so the UI never does epoch math.

## 5. Writes, and the two states that matter

`buildCastAddMessage` picks the cast type from the text length (≤320 `CAST`,
≤1024 `LONG_CAST`, ≤10000 `TEN_K_CAST`) because the node validates the declared
type against the byte count; the composer shows the same thing live. Submitting
returns the node's echo — the UI labels that "accepted for relay" — and
`confirmMessage` polls `castById` until the message is queryable, which the UI
labels "stored on the node". Follows (`LINK_ADD`/`LINK_REMOVE`), likes/recasts
(`REACTION_ADD`/`REACTION_REMOVE`) and profile edits (`USER_DATA_ADD`) are built
and submitted the same way.

## 6. Include/exclude casts from other clients

Farcaster casts carry no client field. What they carry is the signer key, and a
**gasless** key's node record reports the `requestFid` of the app that requested
it. So identity is resolved from the node itself (`clientFilter.ts`):

- `self` — signed by this client's own key (`requestFid === your FID`);
- `app:<fid>` — another app requested the key; labelled only if **you** label it
  (the UI has "name this client", stored per FID). No vendor names are invented
  from a FID in this repo;
- `onchain` — a custody/on-chain signer, which has no app FID at all;
- unresolved lookups render as unknown rather than failing the feed.

Filtering is a **view-layer preference** persisted per FID: `all`, `only`
(explicitly narrow — unresolved casts are hidden, because half-honouring "only"
would be a bug) or `exclude` (names clients to drop; unresolved casts stay, since
hiding a stranger's cast because a lookup failed is worse). Each cast shows
"via <client>" so the filter is never mysterious.

## 7. Seed-phrase safety, as invariants

- The phrase is typed into a blocking modal (`SeedPhraseWarningModal`) that
  enumerates the risk, insists on a test account, states that the phrase never
  leaves the tab, and requires a checkbox before the confirm button enables.
  There is no backdrop-click dismiss; the field is `type=password`, cleared on
  close **and** on unmount.
- The phrase is never persisted: only the app key's private key hex is stored
  (per FID). A test asserts seeded storage contains no mnemonic-shaped value.
- The custody key signs exactly one thing in this feature: the EIP-712 `KeyAdd`
  authorization. No transaction, no ETH, no Optimism tx, no storage purchase, no
  on-chain account creation.
- Client messages are signed by the app key only — asserted directly in tests.

## 8. Tests, and how to run them

```bash
pnpm --filter farcaster-node-client test        # hermetic, over real HTTP
SNAPCHAIN_LIVE_URL=https://<read-node> \
  pnpm --filter farcaster-node-client test      # + read-only live checks
SNAPCHAIN_LIVE_WRITE_URL=https://<read-node> \
  pnpm --filter farcaster-node-client test \
    src/__tests__/live.write.node.test.ts      # + live write path (rejections only)
SNAPCHAIN_LIVE_WRITE_URL=https://<read-node> SNAPCHAIN_LIVE_WRITE_KEYADD=1 \
  pnpm --filter farcaster-node-client test \
    src/__tests__/live.keyadd.node.test.ts     # + KEY_ADD acceptance probe
pnpm --filter farcaster-web typecheck
pnpm --filter farcaster-web test
```

Three live suites, each behind its own env var so a default run never touches
the network:

| Suite                      | Gate                                        | What it does to a real node                                                                                                                                                     |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live.node.test.ts`        | `SNAPCHAIN_LIVE_URL`                        | reads only                                                                                                                                                                      |
| `live.write.node.test.ts`  | `SNAPCHAIN_LIVE_WRITE_URL`                  | submits a cast, a reaction, a follow and a profile edit **signed by a key the FID never added** — all four must be refused, so nothing enters gossip                            |
| `live.keyadd.node.test.ts` | `SNAPCHAIN_LIVE_WRITE_KEYADD=1` (+ the URL) | submits one gasless `KEY_ADD` whose custody signature is wrong: the only message a real read node _accepts_ on the wire, which is why it is gated separately and off by default |

The fake node (`packages/farcaster-node-client/test/fakeSnapchainNode.ts`) is a
real HTTP server that enforces the contract rather than echoing it: it decodes
your protobuf, recomputes the blake3 hash from the decoded `data`, verifies the
Ed25519 envelope signature, verifies the gasless `KEY_ADD` custody signature with
**viem's** `verifyTypedData` against a locally-declared EIP-712 table, verifies
the `SignedKeyRequest` metadata with `@farcaster/core`'s own verifier, enforces
nonce/scope/TTL/quota rules, and rejects messages from keys that were never
added.

### What a real read node actually says (2026-10-18, node v0.13.5)

Raw transcript: `docs/evidence/node-client-live-runs-2026-10-18.txt`.

- **A write the client is not authorized for is refused on authorization, not on
  the wire.** Cast / reaction / follow / profile-edit messages signed by a
  stranger key came back `400` with
  `bad_request.validation_failure/invalid signer` — the node decoded our
  protobuf, hashed it and looked the signer up. A JSON body on the same route
  fails differently (`content-type`/parse), which is what makes the distinction
  meaningful rather than a coincidence, and a test asserts both halves.
- **A read node returns `200` for a gasless `KEY_ADD` whose custody signature is
  wrong.** Measured, twice: `accepted=true`, `HTTP 200`, hash echoed — and the key
  never appeared in `signersByFid` over the next 60 s, so the validators dropped
  it and nothing merged. Two consequences, both already implemented:
  `issueAppKey` must confirm by polling the signer record rather than trusting
  the response, and the UI must label a `200` "accepted for relay" instead of
  "posted". The client behaves this way; the probe is what keeps that honest.

### Verification evidence (2026-10-18)

| Check                                                                                   | Result                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter farcaster-node-client test`                                              | 73 passed, 9 skipped (the three live suites, each gated on its own env var)                                                                                                  |
| `SNAPCHAIN_LIVE_URL=https://haatz.quilibrium.com … live.node.test.ts`                   | 5 passed — real casts decoded, real Ed25519 signatures verified, real signer records resolved                                                                                |
| `SNAPCHAIN_LIVE_WRITE_URL=https://haatz.quilibrium.com … live.write.node.test.ts`       | 3 passed — real node refused an unauthorized cast, reaction, follow and profile edit, each with `bad_request.validation_failure/invalid signer`, plus the JSON-body contrast |
| `SNAPCHAIN_LIVE_WRITE_KEYADD=1 … live.keyadd.node.test.ts`                              | 1 passed — node answered `200` to a wrong-custody `KEY_ADD`, key still absent from `signersByFid` after 60 s                                                                 |
| `pnpm --filter farcaster-node-client typecheck` / `tsc -p tsconfig.test.json`           | clean                                                                                                                                                                        |
| `pnpm --filter farcaster-web typecheck`                                                 | clean                                                                                                                                                                        |
| `pnpm --filter farcaster-web test src/snapchain src/constants/__tests__/Routes.test.ts` | 25 passed (21 of them the node wiring's own)                                                                                                                                 |
| `pnpm --filter farcaster-web build`                                                     | builds; `SettingsNodePage` lazy chunk emitted, containing the gasless key path                                                                                               |

Negative paths are covered too: a JSON body on the submit route is rejected by
the node (the reason this client speaks protobuf), an unknown signer cannot
publish, a replayed nonce is rejected with the node's own reason, a wrong custody
account fails signature verification, a `KEY_ADD` accepted but not merged is
reported as _not_ success, and a self-revoked key stops working immediately.

## 9. Not verified, and what would close it

- **A successful write.** The write path now reaches a real node and comes back
  with that node's own verdict, including its `invalid signer` rejection of four
  message types this client builds (`§8`), but no cast has ever been _accepted
  and merged_ from this repo: that needs a real FID with storage and an app key
  issued for it, and creating one is not something a build should do
  unilaterally. Closing it is one `fiddy client up` against a synced node with a
  test account, then `confirmMessage` on the hash the node echoed.
- **A local full node.** A read node wants ~2 TB and a long initial sync (the
  three-command run in `docs/RUN-REPORT-2026-10-18.md` measured 468 GB of
  snapshot before its host ran out of room), so this work used a public read node
  for live reads rather than standing up another one on a shared 55 GB host.
- **Upstream gaps worth a PR** (found while reading the node):
  1. no `OPTIONS`/preflight handling on the HTTP API, which blocks every
     browser-based client from writing directly (`src/network/http_server.rs`
     has no OPTIONS arm), and
  2. `requesterFids` cannot be expressed in a query string, so the app-nonce
     namespace is unreadable over HTTP.
     Both are small, and fixing (1) upstream would let clients drop the relay.
- **`farcaster-web`'s older Warpcast-coupled screens** still use the hosted API;
  the node-backed surface is this new settings page, not a rewrite of the
  existing data layer. `docs/CLIENT-NODE-GAP.md` (written by the three-command
  work) inventories that gap.
