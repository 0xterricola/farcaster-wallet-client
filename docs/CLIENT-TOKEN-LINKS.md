# `$TICKER` — what `/v2/token-links` asks, and who can really answer it

USER-REPORTED (2026-10-24): the token-links surface refused with *"Fiddy can't read
`/v2/token-links` yet."* This is what the endpoint asks, what was measured before
anything was wired, what now answers it, and what is still not answered.

## What the endpoint asks

The fork's client data layer (`packages/farcaster-client-data/bin/types.yml`)
defines one read:

    GET /v2/token-links?ticker=&chain=&intent=typeahead|submit&contextFid=
      description: Get matching tokens for a linked ticker
      200: { result: { tokens: ApiTokenLink[], coins: ApiCoinLink[] } }

So it is a **ticker → token** question: *which token does the `$TICKER` a cast
links with actually mean?* The hosted API answers it out of Warpcast's own
registry of the tokens its own casts link with a ticker — a registry no other
party keeps, which is why the client's routing table
(`apps/farcaster-web/src/snapchain/nodeApi/hostedRoutes.ts`) had no source for it
and every surface that asks it was shown the adapter's fallback sentence.

Four surfaces ask it, all of them reachable without any deliberate digging:

| surface | how it asks |
| --- | --- |
| `$TICKER` page (`/~/token/<ticker>`) | `intent: submit`, the ticker from the URL |
| `/~/ca/<address>` (a pasted contract address) | `intent: submit`, `ticker` = the address |
| the composer's `$` typeahead | `intent: typeahead`, the ticker as it is typed |
| the profile's token picker (`EditProfileModal`) | `intent: typeahead` |

## What was measured (2026-10-24, before any of it was written)

**Neynar cannot answer this one.** Its fungible reads take *contract addresses*,
never a ticker:

    GET https://api.neynar.com/v2/farcaster/fungibles/?fungibles=degen
      → 400 {"code":"InvalidField","message":"Invalid CAIP-19 token URIs found: degen"}

    GET https://api.neynar.com/v2/farcaster/fungibles/?fungibles=eip155:8453/erc20:0x4ed4e862860bed51a9570b96d89af5e1b0efefed
      → 200 {"fungibles":[{… "name":"Degen","symbol":"DEGEN","decimals":18,
              "total_supply":"36959975724817368079862685859", "cast_count":20909}]}

(measured with this build's own key, read-only; the key is never printed)

A reader that answered `/v2/token-links` from Neynar alone would therefore have to
invent the address — the one thing this client's adapter must never do. And that
is the *second* fact worth keeping: **the address is the join key**. By address,
Neynar really does know a name, a symbol, decimals, a total supply and how many
Farcaster casts mention the token (`cast_count`) — all of which is a truthful
enrichment if this client ever wants it, and none of which it needs to show a row.

**A public market index can answer it, and this client already reads it:**

    GET https://api.dexscreener.com/latest/dex/search?q=degen
      → 200, access-control-allow-origin: *, 30 pairs, each with chainId, url,
        baseToken { address, name, symbol }, priceUsd, priceChange { h6, h24 },
        volume { h6, h24 }, liquidity.usd, fdv, marketCap, info.imageUrl,
        info.websites, info.socials

    GET https://api.dexscreener.com/latest/dex/tokens/<address>   → the same, by address

Dexscreener is not a new dependency picked for this card: it is already the source
of what a `$cashtag` is worth in a cast body
(`apps/farcaster-web/src/lib/tokens/price.ts`, the chip, `docs/MASK-FEATURES.md`).
It needs no key of anyone's, answers with `access-control-allow-origin: *`, and the
live host's CSP already allows it (`connect-src 'self' https: wss:`,
`docs/CLIENT-RELEASE.md`).

## What now answers it

`apps/farcaster-web/src/snapchain/providers/marketIndex.ts` reads that index and
shapes the answer into the hosted envelope. `/v2/token-links` is classified
`market` in the routing table and is answered **before any provider is consulted**,
the same way the media pipeline and this device's own drafts are: it is nobody's
Farcaster server's read, no key is involved, and the answer is the same whichever
server the failover engine happens to be holding.

The honesty rules, each of them pinned by a test
(`src/snapchain/providers/__tests__/marketIndex.test.ts`):

- **A ticker is not unique, so the answer is a ranked list, not a claim.** Rows
  carry the chain, the contract address and the market URL they came from; the
  ranking is the cashtag chip's (the chains this client's world trades on first,
  then real liquidity).
- **`intent: typeahead` matches a symbol prefix; everything else matches the whole
  symbol.** `$deg` while typing may mean `DEGEN`; `$degen` never lands on `DEGENX`.
- **A contract address is looked up by address**, with no symbol guessing at all.
- **Every field the index did not state is absent, never zero** — no `0` market
  cap, no invented creator, verification, holder count or price. The row components
  already guard (`TokenSummary` draws a market cap only when there is one).
- **`coins` stays empty.** That list is Warpcast's own coin registry; this client
  has no source for it, and a second copy of the same markets would be one answer
  dressed as two.
- **An index that did not answer is a `502` in words** (*"Dexscreener, the public
  market index this client reads token markets from, did not answer (…) — so no
  token is shown here, and nothing was invented."*), never an empty list that
  would read as "there is no such token".
- **One question, one request**: answers are cached for a minute and shared, so a
  typeahead firing once per keystroke does not become five reads of a public API.
- **A chain this client cannot name still arrives, as the index named it** — the
  chain chip renders `?` for it rather than a wrong chain's logo, and the wallet
  path simply does not open a trade for a chain it cannot build (`TokenSummary`'s
  row still links to the market itself).

The two empty states were re-worded with it. Both used to say *"Still gathering
data — check back later."*, which was never true of a lookup that had just
finished: the `$TICKER` page and `/~/ca/<address>` now say *"No market was found
for $X. This client reads token markets from Dexscreener, a public market index."*
With this reader, an empty answer has exactly one meaning — the index answered and
no market's own symbol matches — because a failed lookup is the refusal above
instead.

## It does not need the release to carry a Neynar key

The card this came from expected a dependency on the release build carrying the
reader's Neynar key (`t_e7754140`). That dependency is gone: this route is
answered from a public index that takes no key, so the `$TICKER` surfaces work in
a keyless build exactly as they do in a keyed one. (Neynar's by-address
enrichment described above *would* need the key, which is one reason it is not
used.)

## What is still not answered on that page

The `$TICKER` page has a second section, **Casts**, and it reads a different
endpoint: `GET /v2/search-casts?q=ticker:X sort:recent` — Warpcast's *search*,
with Warpcast's own query syntax. It is classified `hosted` in the routing table
("a read node keeps no search index") and still refuses in place. Wiring *that*
one is not the same question and not this card's: an index that answers full-text
search (Neynar's cast search) cannot honour `ticker:X`, so answering it would mean
either showing casts that merely contain the word, under a heading that says the
ticker was linked, or changing what the section claims. It is carded separately.

## How to check it

Unit tests and the seam:

    cd apps/farcaster-web
    npx vitest run src/snapchain/providers/__tests__/marketIndex.test.ts \
                   src/snapchain/providers/__tests__/marketRoute.test.ts

Live, on the released client (signed out is enough — the page asks the read before
it checks the session), by the probe that was written with this change:

    node apps/farcaster-web/scripts/verify-token-links-live.mjs
    SERVER=https://fiddy.fun node apps/farcaster-web/scripts/verify-token-links-live.mjs

It fails unless a real market row paints on the page (ticker, market cap or
liquidity, and a market URL), unless the contract-address route resolves to a
token, and unless no refusal sentence is on screen.