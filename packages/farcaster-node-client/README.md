# farcaster-node-client

Read and write Farcaster through **your own** Snapchain read node.

No Neynar, no Warpcast API, no Alchemy, no API keys. Reads are the node's
authenticated-nothing `/v1/*` HTTP API; writes are protobuf `submitMessage`
calls that the node gossips to validators. App keys are issued **gaslessly** —
`KEY_ADD` authorized by an EIP-712 signature from the custody address, with no
Optimism transaction, no ETH and no storage purchase.

```ts
import {
  SnapchainNodeClient,
  buildCastAddMessage,
  generateAppKey,
  issueAppKey,
} from 'farcaster-node-client';

const node = new SnapchainNodeClient({ baseUrl: 'http://127.0.0.1:3381' }); // SSH tunnel

const appKey = await generateAppKey(); // 32 bytes, local only
await issueAppKey({ node, fid, appKey, custodyAccount }); // gasless KEY_ADD

const built = await buildCastAddMessage({
  fid,
  signerPrivateKey: appKey.privateKey,
  text: 'posted through my own node',
});

const accepted = await node.submitMessage(built.bytes); // 200 = accepted for relay
const merged = await node.confirmMessage({ fid, hash: accepted.hash });
```

## Why it looks like this

- **Dependency pin.** `@farcaster/core@0.20.0` is pinned exactly. The gasless
  builders (`makeKeyAdd`, `makeKeyAddBody`, `getGaslessSignedKeyRequestMetadata`
  on the EIP-712 signers, `ADMISSIBLE_KEY_ADD_SCOPES`) first ship in 0.20.0 —
  `@farcaster/core@0.19.0`, which `@farcaster/hub-nodejs@0.16.0` depends on, has
  none of them. `@farcaster/hub-nodejs@0.17.0` re-exports core 0.20.0
  (`export * from '@farcaster/core'`), so that is the pinned version if you want
  the same functions from the Node-oriented package. This package imports
  `@farcaster/core` directly because hub-nodejs also pulls `@grpc/grpc-js`, which
  has no place in a browser bundle.
- **`application/octet-stream` or nothing.** `POST /v1/submitMessage` on a
  Snapchain node rejects a JSON body with a 400 before parsing it. The client
  sends binary protobuf, and the tests assert the content type on the wire.
- **`dataBytes` matters.** Snapchain serializes `data` in Rust, so messages must
  carry the JS `dataBytes` alongside `data`; `@farcaster/core`'s `makeMessage`
  does this, and the tests assert the two serializations agree.
- **Query params are inconsistent on purpose.** `reaction_type` / `link_type` are
  snake_case and take _Rust variant names_ (`Like`), not proto names
  (`REACTION_TYPE_LIKE`); `pageSize`/`pageToken` accept both spellings. The
  client hides that behind typed methods.
- **A 200 is not inclusion.** A read node has no mempool: it accepts and relays.
  `confirmMessage` polls the message back out of the node, which is the only
  honest confirmation available on this seam.

## What the API gives you

| Area             | Surface                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node             | `info()`, `health()`, `storageLimitsByFid()`                                                                                                                                         |
| Reads            | `castsByFid`, `castById`, `castsByParent`, `castsByMention`, `userDataByFid`, `linksByFid`, `linksByTargetFid`, `reactionsByFid`, `reactionsByCast`, `reactionsByUrl`                |
| Signers          | `signer()`, `signersByFid()`, `onChainSignersByFid()`                                                                                                                                |
| Writes           | `submitMessage()`, `validateMessage()`, `confirmMessage()`                                                                                                                           |
| Message builders | `buildCastAddMessage`, `buildCastRemoveMessage`, `buildReactionAddMessage`, `buildReactionRemoveMessage`, `buildLinkAddMessage`, `buildLinkRemoveMessage`, `buildUserDataAddMessage` |
| App keys         | `generateAppKey`, `appKeyFromPrivateKeyHex`, `buildKeyAddMessage`, `issueAppKey`, `fetchSignerState`, `revokeAppKey`                                                                 |
| Feeds            | `fetchFollowing`, `fetchCastsByFid`, `fetchFollowingFeed`, `fetchReplies`, `mapWithConcurrency`                                                                                      |
| View layer       | `CastClientResolver`, `filterCastsByClient`, `clientIdentityFor`                                                                                                                     |
| Errors           | `NodeApiError` (`status`, `nodeError`, `nodeErrorDetail`), `NodeUnreachableError`, `MessageBuildError`                                                                               |

## Tests

The seam under test is the node's HTTP API, so the suite runs against a **real
HTTP server** (`test/fakeSnapchainNode.ts`) that enforces the contract: it decodes
your protobuf, recomputes the blake3 hash, verifies the Ed25519 envelope
signature, verifies the gasless `KEY_ADD` custody signature with **viem's**
`verifyTypedData` (a different library from the one that produced it), verifies
the `SignedKeyRequest` metadata with `@farcaster/core`'s own verifier, enforces
nonce/scope/TTL rules, and refuses messages from keys that were never added.

```bash
pnpm --filter farcaster-node-client test          # hermetic: 73 tests over real HTTP
SNAPCHAIN_LIVE_URL=https://<your-node> \
  pnpm --filter farcaster-node-client test        # + 5 read-only live tests
```

The live suite is read-only by design: writing needs a real FID and an app key,
and a test suite must not mint one.

## Licence

MIT.
