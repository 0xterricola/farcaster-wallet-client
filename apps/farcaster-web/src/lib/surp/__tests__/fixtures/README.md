# Surp fixtures

Verbatim captures from `https://surp.ivc.lol`, taken **2026-10-21** (IST). They
are here so the parsers and the savings arithmetic are checked against what the
service really answers, rather than against a shape somebody imagined.

| file | where it came from | what it pins down |
| --- | --- | --- |
| `price-board.json` | `GET /api/price-compare?input_share=0.7` | 129 routed models, Surp's per-million rate beside OpenRouter's blended rate; `generated_at` and `source_age_seconds` are what the savings line dates itself from. |
| `chat-402.json` | `POST /v1/chat/completions` with **no payment at all** (`model: surp/value`, `max_tokens: 900`) | the price Surp charges for one request: `price_usd "$0.0100"`, `accepts[0]` = `exact`, `eip155:8453`, USDC on Base, `amount "10000"`, `payTo 0x2f95…c2c8`, 600s. Asking costs nothing — the 402 *is* the answer. |
| `key-created.json` | `POST /api/keys/create` (`balance_cents: 0`) | the shape of a created key. **The `key` value is a fake** — the real one was replaced before this file was written, because a captured credential does not belong in a repository. |
| `key-balance.json` | `GET /api/keys/balance?key=…` | the read-only check that a key is real and live: `balance_usd_cents`, `total_requests`, `last_used`. |

## Re-taking them

The numbers move — Surp re-quotes continuously and the board's `generated_at`
is minutes old, not days. To re-take, fetch the same four things and keep the
same file names; nothing in `src/lib/surp/` hardcodes a figure these files
carry. **Replace the key value with a fake before writing `key-created.json`.**

## Two things these captures established that are worth keeping

1. **The floor is the bill.** Surp bills whole cents with a $0.01 floor, so
   `price_usd` was `$0.0100` for requests of 5, 500, 900 and 4000 tokens alike.
   Its public price page reports ~99% savings *per million tokens*, which is
   true about tokens and false about a bill. `savings.ts` is built on the
   per-request charge for exactly this reason, and the test named
   *"bills the floor, not the token rate"* is the one that fails if somebody
   ever rebuilds it on the token rate.
2. **The catalog route and the request route disagree about the domain.** The
   chat 402's `extra` carries only `description`/`mimeType`; Surp's own studio
   402 carries `extra.name = "USD Coin"` and `extra.version = "2"`. The EIP-712
   domain has to match the token's, so `x402.ts` reads `extra` when it is there
   and otherwise falls back to the values the studio route states. A signature
   over the wrong domain is rejected by the facilitator; this is the note that
   saves somebody an afternoon.