# Adding funds, and the Fiddy balance (client half)

A Fiddy balance is a **platform credit**: somebody sends USDC on Base to Fiddy's
treasury, Fiddy verifies that transfer itself, and the ledger records what it owes
them in-app. It is spent inside Fiddy and it is not custody — the client never
says "your wallet balance", "deposit" or "your funds", and it never implies Fiddy
holds anybody's keys. The server's half of the copy rule is the control plane's
`docs/fiddy/BALANCE-CREDIT.md`.

## The three routes, one origin

`GET /api/fiddy/funding/config`, `POST /api/fiddy/funding/credit` and
`GET /api/fiddy/funding/balance` are served by `fiddy-auth` on **the origin that
serves this app** (`fiddy.fun`), proxied by nginx. Everything in
`apps/farcaster-web/src/lib/fiddyCredit.ts` is a relative path for that reason:
the session is a cookie, and a page that reaches another origin carries neither
the cookie nor a CORS grant. `fiddyCredit.test.ts` asserts the paths, and that
the credit body is exactly `{ txHash }`.

## What lives where

| Piece | File | What it is |
| --- | --- | --- |
| The contract | `src/lib/fiddyCredit.ts` | Config/balance/credit reads, the named failure codes and their sentences, money as strings (never a float), and `runTopUp` — submit, wait while Base confirms, then prove it in the balance |
| The send | `src/lib/fiddyTopUpSend.ts` | One USDC transfer on Base to `config.treasury.address`, through the client's own transfer builder (`~/utils/baseWalletTransfer`), so the wallet is checked, the transfer is simulated and the fee is estimated before anybody approves |
| The miniapp wallet | `src/lib/farcasterWallet.ts` | `sdk.wallet.getEthereumProvider()` when the app is open inside a Farcaster client; `null` outside one, never a hang |
| The remembered transfer | `src/lib/fiddyPendingTopUp.ts` | The hash is kept in this browser *before* the credit is asked for. The money has already moved; if the tab dies, the next load can still ask |
| The reads | `src/hooks/fiddy/useFiddyCredit.ts`, `useFiddyTopUp.ts` | React Query keys, the session state, and the send/credits flow |
| The surfaces | `src/components/fiddy/FiddyFunding.tsx`, `AddFundsSheet.tsx` | The chip, the balance home, and the add-funds sheet every entry point renders |
| The routes | `/~wallet/add-funds` (its own page), `/~wallet` (the balance home), `/welcome/funds` (the way in's step 2 of 3) | |

The sheet is one component rendered by three entry points, so there is one set of
words and one implementation of "add funds".

## What the flow refuses to do

- **It never sends without a review.** The review names the amount in dollars,
  "USDC on Base", and the treasury address — short on screen, full in the copy
  control, and always the address the config route published.
- **It never offers a send the service cannot credit.** The balance route is the
  only thing that can say whether this session can hold a credit, so its answer
  decides whether the press exists. A transfer to Fiddy's address that cannot be
  credited is somebody's money with no balance behind it.
- **It never rounds.** `12.505` is refused rather than sent as `12.50`, and an
  amount under the server's `minimum` is refused with the server's own floor.
- **It never fails twice the same way.** A failed credit keeps the hash on screen
  with "check again" — which sends nothing — rather than a second transfer.

## Known gap: the session the funding routes want (follow-up card material)

The funding routes require a **Privy principal** (`principal.mode === 'privy'`,
verified against Privy's JWKS). This client's signed-in session is Farcaster SIWF,
so in production today the balance read answers `AUTH_REQUIRED` /
`PRODUCTION_AUTH_REQUIRED` and the flow refuses the send honestly rather than
moving money it cannot credit. Reaching `session === 'ready'` in production needs
a session the funding routes accept (or the routes accepting the SIWF session) —
a backend/auth decision, not a client one. The client is already correct on both
sides of that decision: when the session is accepted, the same screen sends.

## Verifying it

Unit tests (57 of them, five files):

```
pnpm --filter farcaster-web exec vitest run \
  src/lib/__tests__/fiddyCredit.test.ts \
  src/lib/__tests__/fiddyTopUpSend.test.ts \
  src/lib/__tests__/fiddyPendingTopUp.test.ts \
  src/components/fiddy/__tests__/AddFundsSheet.test.tsx \
  src/components/fiddy/__tests__/FiddyBalanceChip.test.tsx
```

The browser probe, at 390px and 1440px, with the funding routes stubbed from real
payloads (a signed-out visitor, a signed-in visitor with a balance, and the way
in's step):

```
cd apps/farcaster-web
HTTPS=true VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
  PROBE_VITE_CACHE_DIR=/tmp/fiddy-funding-probe-cache \
  npx vite --config scripts/probe.vite.config.mjs --port 5211 --strictPort
FUNDING_ORIGIN=https://localhost:5211 node scripts/verify-fiddy-funding.mjs
```

Give the probe server a cache directory **outside the repo**: it is ~100MB of
machine-local state, and a cache directory inside `apps/farcaster-web` is walked
by eslint on every lint run (measured: a lint that takes ~3 minutes took 23+).

`164/164 checks passed` is the green state (`FUNDING_STATES=ready`, `refused`,
`welcome` and `FUNDING_WIDTHS=390,1440` narrow a run while chasing something).

**The probe never sends a transfer.** It asserts that the send press exists and
does not take it: a probe has no funded wallet and must not need one.