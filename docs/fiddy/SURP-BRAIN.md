# Surp as Fiddy's second brain — what was verified, and what is blocked

Written 2026-10-21 against `surp.ivc.lol` as it answered that day. Everything in
this note is a measurement, not a plan. The captures the code is tested against
live in `apps/farcaster-web/src/lib/surp/__tests__/fixtures/`.

## What Surp really is, measured

| What | Where | What it said |
| --- | --- | --- |
| Live prices | `GET /api/price-compare?input_share=0.7` | 129 models routed, each with Surp's per-million-token rate beside the same model's blended OpenRouter rate; `generated_at` minutes old |
| Routes and their rates | `GET /v1/models` | per-combo `usd_per_1m_tokens` (e.g. `surp/value` → `deepseek-v4.1-flash` at `0.000623`), plus `network`, `asset`, `pay_to` |
| A request's price | `POST /v1/chat/completions`, unpaid | `402` with `price_usd "$0.0100"` and `accepts[0]` = `exact`, `eip155:8453`, USDC on Base, `amount "10000"`, `payTo 0x2f95…c2c8`, 600s |
| Making a key | `POST /api/keys/create` | returns a real `sk-surp-…` (51 chars) anonymously, once |
| Reading a key | `GET /api/keys/balance?key=…` | `{label, balance_usd_cents, total_requests, last_used}` |
| The token's EIP-712 domain | Surp's own studio `402` | `extra.name = "USD Coin"`, `extra.version = "2"` |

The verification run created one real key and probed it read-only (`/api/keys/balance`
and `GET /v1/models` with the key). The key is a throwaway with no balance; it is
**not** in this repository and not in any commit. It is on the workstation at
`~/.hermes/cache/scratch/t_c514509a/.probe-key`, mode 600, outside every repo.

## The number that changes the product story

Surp bills **whole cents with a $0.01 floor** (`floor_cents = 1`, plus 5% markup,
rounded up to the cent). Measured: `price_usd` came back `$0.0100` for requests
of 5, 500, 900 and 4000 tokens alike. So:

    Surp per month  ≈  $0.01  ×  requests per month

and **not** `tokens × the per-million rate`. Surp's own price page reports ~99%
savings per million tokens; that is true about tokens and false about a bill.

The honest version, which is what `lib/surp/savings.ts` computes and what the
panel prints:

> Claude Pro is $20.00 a month whether you use it or not. At about 20 messages a
> day the same work costs about $6.00 on Surp — about $14.00 less this month.

Both numbers say where they came from. The Surp side is live (the request charge
is read out of a real 402). The plan's price is a dated, sourced fact — a
subscription price is a fact about someone else's website, not a feed, and the
line says so rather than implying it is live.

## Two things block the in-browser version, and both are on the Surp side

### 1. Surp sends no `access-control-allow-origin`

`fiddy.fun` cannot read `surp.ivc.lol` from a browser. Confirmed on four
endpoints (`/api/price-compare`, `/v1/models`, `/api/keys/balance`,
`/api/keys/create`): none returns `access-control-allow-origin`, and the
preflight for the POST returns `404`. The only path that would avoid this is a
Fiddy-owned server hop, which would mean the owner's key transits our server —
the opposite of what the key is for.

Surp's `build_app` registers one middleware (`api_metadata_middleware`), so the
header has to be added there, scoped to the `fiddy.fun` origin, for the read
endpoints and — see below — only for a create endpoint that is safe to expose.

`lib/surp/transport.ts` reports this specifically (`code === 'CROSS_ORIGIN'`)
rather than as a generic failure, and every surface that reads Surp says so in
one sentence instead of inventing a price.

### 2. `POST /api/keys/create` mints funded keys, anonymously

Measured: the call takes `{label, balance_cents}` and grants
`balance_cents × 10_000` microcents with **no credential and no payment**.

    POST https://surp.ivc.lol/api/keys/create  {"label":"fiddy-proof","balance_cents":20}
    → 200 {"key":"sk-surp-…","balance_microcents":200000,…}
    GET /api/keys/balance?key=…  →  {"balance_usd_cents": 20, …}

Anybody on the internet can mint a key with a balance and spend the gateway's
upstream credit. This matters to this work in two ways: it is why the client
never asks for a balance (`balance_cents: 0`, always — asserted in
`keys.test.ts`), and it is why **item 3 of this card, "fund the key with the
connected wallet", is not what the wallet rail should do**. There is no
fund-the-key endpoint; the real wallet rail is per-request x402 (sign an
EIP-3009 authorization, send it with the request, pay exactly that request's
charge), and that is what `lib/surp/x402.ts` prepares. Adding CORS to the create
endpoint before the balance grant is gated would hand every website on the
internet a way to mint funded keys from visitors' browsers.

## Where Surp is wired, on both sides (reworked against `main`, 2026-10-21)

Surp is a **provider preset**, not an id the client invents. The card in the
picker is the same shape as ChatGPT/Claude/Gemini/OpenRouter/Nous Portal — a
`BrainId` in `lib/fiddySetup.ts`'s `BRAIN_IDS`, `kind: 'preset'`,
`needs: 'account'`, no address field — and the descriptor the sheet sends to the
agent service is exactly:

    { kind: 'preset', presetId: 'surp', model: 'surp/<combo>', key: 'sk-surp-…' }

which is the descriptor `t_8c879418`'s provider table already understands. That
required the missing half: a `surp` entry in the control plane's
`BRAIN_PRESETS` (`legitmate-farcaster`, commit `5cd53ae`), because a preset id
that side does not know is refused with `BRAIN_PRESET_NOT_APPROVED` — a card you
can pick and never apply is not a brain.

The address stays ours (`https://surp.ivc.lol/v1`, transport
`chat_completions`), and two things are measured rather than assumed:

- `surp.ivc.lol` resolves to `187.127.148.194`, a public address, so the DNS
  check the probe path applies passes.
- Surp's `/v1/models` is **not** the OpenAI shape. It names each route a *combo*:
  `{combos: [{combo: "surp/value", resolved_model, usd_per_1m_tokens}]}`, with no
  `data` array at all. Read through the generic reader a perfectly good key came
  back as "listed no models", so the preset declares `listShape: 'surp_combos'`
  and one live probe through `probeBrainProvider` with a real key answered
  `BRAIN_OK` with Surp's 19 real route ids.

On the client side, one thing is worth stating plainly because the sheet's copy
used to say the opposite. For every other card the key already exists on the
owner's own dashboard and only passes through, so "Fiddy keeps no copy" is true.
Surp's key does not exist anywhere until this screen makes it, so
`lib/surp/keys.ts` keeps it in one storage entry of its own and the sheet says
where it lives — in this browser — instead of borrowing that sentence. The key
is still never in the preference file (`fiddy.setup`), never in a URL, and only
ever shown as a mask.

`walletChoice` is a field `saveFiddySetup` writes explicitly (its whitelist is
deliberate: the file holds a preference and an address, never a credential), so
the wallet home's choice survives a reload — asserted in `fiddySetup.test.ts`
alongside the 'surp' round-trip through `BRAIN_IDS`.

## What was built here (fiddy client)

    src/lib/surp/transport.ts      one seam: addresses, deadline, and the honest refusal
    src/lib/surp/pricing.ts        live price board + live request quote, both parsed strictly
    src/lib/surp/savings.ts        the honest monthly arithmetic (floor, not token rate)
    src/lib/surp/keys.ts           a key made in this browser, kept in this browser
    src/lib/surp/x402.ts           the live offer → the EIP-3009 authorization to sign
    src/lib/surp/walletChoice.ts   the two wallet choices, and the truth about each
    src/components/fiddy/SurpBrainPanel.tsx    the panel inside "Add a brain"
    src/components/fiddy/FiddyWalletHome.tsx   which wallet pays, and what it pays for

`x402.ts` prepares and never signs: `preparePayment` returns the typed data for
the owner's wallet, `encodePaymentHeader` turns a wallet's signature into the
header a request carries, and nothing in the module holds a key or sends a
payment. The wallet home stops at the signature and says so on screen.
`FiddyWalletHome.test.tsx` asserts the spend boundary by counting the requests
the surface makes: one unpaid price probe, no payment header, no broadcast.

## What is left

1. **CORS on Surp** for the read endpoints, scoped to the `fiddy.fun` origin
   (surp-router repo, `build_app` middleware).
2. **A payment gate on `POST /api/keys/create`** before that endpoint is exposed
   to any origin. Until then, key creation stays browser-local and direct.
3. **A Fiddy account's embedded wallet** for "Create a fresh wallet for me".
   That wallet is built in `legitmate-farcaster` (Privy) and this client must
   reuse it rather than grow a second one; the card in `walletChoice.ts` states
   where it comes from and stays unavailable until the account hands one over.
4. **The agent actually calling Surp** with a signed payment — the last hop, and
   the one that spends for real. Not built here on purpose.