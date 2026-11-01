# The client ↔ node gap (what `fiddy client up` does and does not wire up)

Status as of 2026-10-18, verified by running the client (`/bin/bash bin/fiddy
client up --tunnel`) and reading what the running app actually requests.

## The gap

The web client's data layer does **not** read from a Snapchain node. It reads
and writes Farcaster's hosted API:

| Evidence | Where |
| --- | --- |
| `const upstreamApiUrl = 'https://farcaster.xyz/~api'` — dev builds use it directly | `apps/farcaster-web/src/constants/api.ts` |
| production builds use a same-origin relay pinned to `https://farcaster.xyz` ("Callers cannot choose the host or path prefix, so this is not a general proxy") | `functions/~api/[[path]].ts` |
| the client is constructed with `baseUrl={baseApiUrl}` and ~700 routes of `client.farcaster.xyz`'s REST surface (`/v1/audio-room`, `/v2/farcaster/...`) | `apps/farcaster-web/src/contexts/WebFarcasterApiClientProvider.tsx`, `packages/farcaster-client-data` |
| `VITE_SNAPCHAIN_HTTP_URL` — the variable `fiddy client up` writes — is read by **nothing** in the repo (grep: zero hits outside the CLI) | `cli/client.sh` writes it into `apps/farcaster-web/.env.local` |

So pointing the client at your node today is recording a URL, not switching a
data source. `fiddy client up` says so plainly at the end of its run rather
than claiming otherwise.

The Snapchain node's API is the Hubble-compatible `/v1/*` surface
(`/v1/info`, `/v1/castsByFid`, `/v1/submitMessage`), which is a *different*
API from the hosted client API. That is the whole reason an adapter or a
port is needed — not a missing URL.

## The seam that exists

The app already supports a local backend on **`http://localhost:8080`**
(`ws://localhost:8080/stream`): set `localStorage['farcasterApi.local'] = 'true'`
in a dev build and the API base flips to localhost. That is the intended
injection point, and the shape a node-backed backend has to satisfy.

## The layer that exists (in progress, not in this commit's scope)

As of **commit `591cf1a`** (the tree this run verified), nothing in
`apps/farcaster-web` imported a node client — the app's only data source was
the hosted API above. While this run was in flight, a parallel effort
(kanban card `t_7ae8be28`) landed the node-backed layer in the working tree:

* `packages/farcaster-node-client` — reads over the node's `/v1/*` HTTP API,
  protobuf writes via `submitMessage`, gasless `KEY_ADD` (`appKey.ts`),
  `feed.ts`, `clientFilter.ts`, `messages.ts`, `wire.ts`, plus a fake node for
  tests. **Untracked** at the time of writing: it is not in the repo a judge
  clones until it is committed.
* `apps/farcaster-web/src/snapchain/` (`useNodeClient.ts`, `nodeEnv.ts`,
  `appKeyStorage.ts`) and `apps/farcaster-web/src/pages/settingsNode/` —
  also untracked, and `nodeEnv.ts` is what finally consumes
  `VITE_SNAPCHAIN_HTTP_URL` (the variable `fiddy client up` has been writing all
  along).

`fiddy client check` detects this: it reports "node-backed data layer present"
exactly when the web app imports `farcaster-node-client`, and "NOT wired" when
it does not — so the CLI never claims a read path the checkout does not have.

## What remains, in order

1. **Commit and test `farcaster-node-client`** (card `t_7ae8be28`) — until it is
   committed, the repo's claim of node-backed reads is unbacked for a judge.
2. **Wire one read surface end to end** — the home feed is the smallest useful
   slice: `feed.ts` → a feed hook behind a flag, so the hosted path stays the
   default until the node path matches it.
3. **Writes**: issue the app key gaslessly (`KEY_ADD`) and post via
   `POST /v1/submitMessage`; confirm inclusion by querying the message back or
   watching `MERGE_MESSAGE`, since a read node has no mempool of its own.
4. **Prove it with third-party APIs off** — the acceptance test from the bounty
   spec: block `farcaster.xyz` / `client.farcaster.xyz` (hosts file or devtools)
   and show the feed still renders from the node. Until that passes, no part of
   the product should claim reads come from your node.
5. **Then** `fiddy client up` can state that reads are served by the node, and
   `--tunnel` becomes load-bearing rather than descriptive.

Note the browser-side constraint: Farcaster's hosted API is CORS-limited to
`farcaster.xyz` and `localhost`, which is why the app has a `localhost:8080`
escape hatch at all — a node-backed client has to run from `localhost` (as
`fiddy client up` does) to read the node directly from the browser.