# What Mask Network does, and what of it Fiddy should carry

Status 2026-10-21. Mask Network (github.com/DimensionDev/Maskbook, mask.io) is a
browser extension that adds a Web3 layer to social timelines: encrypted posts to
a chosen audience, a lucky-draw "red packet", token/NFT rendering, and encrypted
files. This document is the audit Fiddy asked for before any of it was built:
each of their moves, judged against *this* client (a node-backed Farcaster
client that holds its own keys), with a verdict and an honest size.

## Licence and provenance — read this first

Maskbook is **AGPL-3.0**. Fiddy is MIT. Nothing in this repository may be a copy
of Maskbook: no files, no components, no lifted functions, no translated code.
What this card did instead is *clean-room by construction*:

| what was looked at | what was not |
| --- | --- |
| product behaviour and user-facing help pages (mask.io, their extension's help centre) | Maskbook source code — not opened, not cloned, not read for this work |
| the public feature list and their published identity/encryption *concepts* | their file layout, their crypto code, their steganography code, their assets |

Everything below is reimplemented from the primitives this client already has
(the browser's own WebCrypto, the node seam's signing path) and from the
Farcaster protocol's own limits. Where our design differs from theirs on
purpose, it says so — the differences are the interesting part for a reviewer
checking for accidental derivation.

Two structural differences worth naming up front, because they change the whole
shape of the work:

1. **Mask is an extension over someone else's timeline. Fiddy is a client with a
   node and its own signer.** Mask has to detect and rewrite posts inside
   Twitter/X's DOM and cannot change the platform. We can put our own renderer
   in our own cast body path, so no DOM scraping and no steganography are needed
   to make a sealed cast *look* sealed here.
2. **Mask's identity is a 12-word mnemonic + a Next.ID persona. Fiddy's is the
   signed-in Farcaster account with an app key held on the device.** Adding a
   second, unrelated identity system to a Farcaster client would be a lie about
   who you are on the network. So our sealing keys are *device* keys that
   announce themselves with a shareable public key string, not a new account.

## The audit

| Mask's move | verdict | why, in one line | honest size |
| --- | --- | --- | --- |
| Encrypted posts to a chosen audience | **FIT — built (v1)** | the one feature whose *point* survives the move to a real client, and the protocol's 320-byte cast limit makes it a postcard-sized problem worth solving carefully | ~600 lines of tested crypto/envelope code + one surface |
| Token info on `$cashtags` | **FIT — built (v1)** | the fork already links `$TICKER` to a token page but shows no price; a price chip is a small, isolated win | ~200 lines + a lazy chunk |
| Image steganography (payload hidden inside a picture) | **LATER — not in v1** | their signature trick exists because a *centralised* timeline strips unknown text; Farcaster carries our bytes natively, so stego would buy us a fragile encoder for no capability | an afternoon to a week (lossless PNG pipeline, robustness against re-encode, tests) |
| Red packet / lucky draw | **LATER — not in v1** | it is not a UI feature, it is custody: someone's funds must be escrowed on-chain with a claim rule and a gas payer. Calling a mock one "shipped" would be dishonest | days, plus an owner decision about custody |
| NFT avatar (render an NFT as your pfp) | **SKIP** | Farcaster profiles already carry a pfp NFT that every client renders; a second NFT layer here adds an indexer and a picker to say what the network already says | — |
| Encrypted file sharing | **LATER — not in v1** | the interesting half (seal a payload for named recipients) is exactly the sealed-cast code; the boring half (host opaque blobs, distribute keys) is a media-host + storage-cost conversation we should have after sealed casts have been used | ~a day *on top of* sealed casts, once there is a reason |
| Design: everything heavy in an on-demand chunk | **ADOPTED** | sealed crypto and price lookups are `import()`ed only when a surface appears, because the main bundle is already 7.6 MB and this card may not grow it | measured, not asserted — see *The bundle* below |
| Design: features gate themselves off | **ADOPTED** | both surfaces answer honestly ("this browser cannot seal" / "no price found") instead of half-working | — |

## Encrypted posts → "seal this cast for specific people" (built)

Mask's flow, from their help page: write a post, set the visibility range, add a
lucky drop or a file if you like, publish; a reader without their extension sees
a placeholder. Their key model is an identity code with a per-persona keypair.

What we built, and where we deliberately diverge:

| | Mask | Fiddy v1 |
| --- | --- | --- |
| keys | 12-word mnemonic → persona keypair, published via Next.ID | a device keypair generated in the browser (WebCrypto, ECDH P-256), published as a shareable public-key string |
| where keys live | extension vault, mnemonic backuppable | `localStorage` on this device only; **not** backuppable in v1, and the copy says so |
| crypto | their own ECIES-style implementation (secp256k1) | the browser's WebCrypto: ephemeral P-256 ECDH → HKDF-SHA256 → AES-256-GCM. No new dependency, no custom primitive |
| audience | visibility range (several people) | one recipient per sealed cast in v1; the codec carries a recipient list, the surface stays at one because of the cast byte budget below |
| transport | hidden inside the post (and inside images) | the sealed bytes are the cast text, prefixed `fdy-seal-1:`, which our own cast renderer detects and draws as a sealed card |
| a reader without Fiddy | sees a placeholder, no content | sees the sealed bytes as text. Their client has no renderer for our envelope — this is the unavoidable cost of not being a browser extension over someone else's DOM, and the copy tells the sender so |

### The byte budget, measured rather than guessed

The Farcaster protocol allows cast text of, per the specification: up to **320
bytes** as an ordinary cast, and up to **1024 bytes** as a long cast
(`CastType.LONG_CAST`, 321–1024 bytes). A sealed cast is base64url, so it is
about 4/3 of its raw bytes. The envelope for one recipient is:

    version(1) | ephemeral public key, compressed(33) | recipient count(1)
    | per recipient: fingerprint(4) + iv(12) + wrapped key(48)
    | content iv(12) | ciphertext + tag(16)

= 127 bytes + the ciphertext, ≈ 181 characters + 4/3 of the ciphertext, plus
the 11-character prefix. So, measured by the budget test in
`envelope.test.ts` (`describe('the budget a sealed cast has in a cast')`) rather
than guessed:

| cast kind | people named | plaintext it holds | in words |
| --- | --- | --- | --- |
| ordinary (320-byte) cast | 1 | **104 bytes** | about two short sentences |
| ordinary (320-byte) cast | 2 | 40 bytes | a very short line — two people barely fit |
| ordinary (320-byte) cast | 3 | **nothing** | a 3-person sealed cast does not fit at all |
| long cast (1024 bytes) | 1 | **632 bytes** | a short paragraph |
| long cast (1024 bytes) | 3 | 504 bytes | a paragraph, shared with two other people |
| long cast (1024 bytes) | 8 (the codec's maximum) | 184 bytes | a long sentence each |

That second and third row are the measured reason the surface seals for **one
person at a time** in v1: naming more people costs 64 raw bytes (85 characters)
each, and at the ordinary cast limit that leaves either almost nothing or less
than nothing. The codec carries up to 8 recipients, and the moment there is a
reason to (a long-cast surface, or a shorter envelope) the surface can raise its
limit without touching the format.

The surface shows the remaining budget live, and refuses to seal something that
does not fit rather than silently truncating a secret.

The ephemeral public key is compressed (33 bytes instead of 65) specifically to
buy back ~43 characters of plaintext per cast; that compression is ours, written
against P-256's own curve parameters, and is round-trip tested against WebCrypto
in `p256.test.ts`.

### What v1 does not do

- No recipient names inside the envelope. The envelope holds fingerprints, so the
  sealed card in the feed says *"sealed — you can open this"* when your key
  matches a block and stays honest otherwise. Names were never in the bytes, so
  we do not invent them on screen.
- No key backup. Clearing this browser's data loses the key and the sealed casts
  addressed to it, in this browser, forever. The copy states it.
- No image steganography. On Farcaster the bytes travel intact; hiding them
  inside a PNG would add a fragile encoder for no capability. LATER.
- No red packets. See the audit row.

## Token info on `$cashtags` (built)

The fork already turns `$TICKER` into a link to `~/token/TICKER`
(`utils/linkify/linkifyUtils.ts`) and already carries token mentions from the
node (`ApiTokenLinkCore` — ticker, chain, contract address). What was missing was
the number a reader actually wants at a glance. We render a chip: the ticker,
then the price — fetched from a keyless read-only price API (Dexscreener) when
the chip is *seen*, cached for a minute, and answered honestly ("no price found")
when the lookup fails or the ticker has no market. When the cast carries a
contract address, the price is looked up by address, which is exact; the ticker
fallback picks the best-matching market and says which one it used.

## The bundle

Measured in this worktree, with the repo's own build command
(`NODE_OPTIONS=--max-old-space-size=8192 HTTPS=false pnpm build`), before and
after — the numbers are in `docs/evidence/mask-bundle-baseline.json` and
`docs/evidence/mask-bundle-report.json`, written by the script below:

| | before | after | change |
| --- | --- | --- | --- |
| main entry chunk | 7,658,862 B | 7,662,752 B | **+3,890 B** (ceiling for this card: 102,400 B) |
| all JS chunks | 13,457,185 B (315) | 13,490,808 B (323) | +33,623 B |
| sealed-cast crypto | — | `sealedCast-*.js` 3,999 B + `envelope-*.js` 5,353 B | its own chunks |
| price lookup | — | `price-*.js` 2,749 B | its own chunk |

What the entry chunk gained is only what every cast body needs: the two string
prefixes, the detector, the chip and the lazy boundaries. The crypto and the
price lookup are `import()`ed — by a sealed cast appearing in a feed, or by a
chip being looked at — and the guard below fails the build if either ever ends up
in the entry chunk.

`apps/farcaster-web/scripts/verify-mask-surfaces.mjs` is both the bundle report
and the dead-code check this card asked for (the knip-equivalent, scoped to the
modules this card added):

    cd apps/farcaster-web && node scripts/verify-mask-surfaces.mjs --report
    cd apps/farcaster-web && node scripts/verify-mask-surfaces.mjs --visual

It asserts, from the built bytes rather than from the source:

1. the sealed crypto and the price lookup are not in the main entry chunk (it
   prints the chunks they *are* in);
2. the entry chunk did not grow more than 100 KB against the recorded baseline;
3. no export of the new modules is unused by every module and test in `src/`;
4. nothing on the sealing path — `encoding`, `p256`, `envelope`, `keys`,
   `sealedCast` — contains a request API or an address of any kind, so there is
   no code path that could send a message anywhere;
5. with `--visual`, a real browser drives `~/sealed` at 390px and 1440px: makes a
   key, seals a message for a key generated in the page, and checks that the
   preview a reader will see carries the message (screenshots land in
   `docs/evidence/mask-surfaces-390.png` and `-1440.png`).

Honest scope of the visual check: it covers the sealed surface end to end. A
cashtag chip's *feed* rendering is not in it — a built client with no signed-in
session and no node has no feed to render — so the chip is covered by its own
tests (`lib/tokens/__tests__/price.test.ts`, 15 of them), by the shape of the CSS
it shares with the sealed card, and by the guard that it never reaches the entry
chunk.

## Surface

- `~/sealed` — "Sealed casts": your key and its share string, who a new sealed
  cast is for, the message, the live budget, a preview of how it will look in a
  feed, and a button that posts it through the client's ordinary signed path.
  Registered in `constants/routes.ts`, `lazy/pages.tsx` and — this is the one
  file to look at twice in a merge — `components/routing/Router.tsx`, next to the
  other two ungated pivot surfaces, because making a key and sealing something
  need no account.
- In the feed, a cast body starting with `fdy-seal-1:` renders as a sealed card
  (`components/sealed/SealedCastView.tsx`), and a body carrying `fdy-key-1:`
  offers to keep that key (`components/sealed/SealedKeyNotice.tsx`) — the key
  discovery mechanism this design uses instead of a key server: a public key is
  public, so it travels in the same posts everything else does.
- `components/casts/CashtagChip.tsx` — the `$cashtag` price chip, rendered from
  the cast body path in `components/text/LinkifiedText.tsx` (the fork already
  linked `$TICKER` to a token page; this adds the number a reader wants at a
  glance, without touching the fork's routing).

## What is deliberately not here

- Red packets, image steganography, NFT avatars, encrypted files: the audit rows
  above say why, and each is a card of its own rather than a half-built surface
  smuggled into this one.
- No key server, no escrow, no recovery, no second identity system: see the table
  under *Encrypted posts*. A closed source of keys would be a lie in a client
  whose whole claim is that your keys are yours.