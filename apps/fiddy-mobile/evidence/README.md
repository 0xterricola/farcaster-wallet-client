# Evidence — Fiddy iOS v1

Screenshots from the iOS 27 simulator (`xcrun simctl io <udid> screenshot`), with
the text read back by local OCR (Vision framework) rather than by eye, so the
transcripts below are what the screen actually said. Full method and the raw
output: `../VERIFICATION.md`.

| File | What it shows | OCR transcript (excerpt) |
| --- | --- | --- |
| `feed.png` | The Feed tab, Debug build, reading the live network | `• Fiddy` / `• served by your node` / `YOUR FEED  fid 3` / `60 casts from 34.101.47.167:3381` / `Greg @greg now — oh so we're time traveling now?` / `:grin: @grin 5h — Marrakech goes hard, in ~/channel/grin` / `Darryl Yeo @darrylyeo 6h — Lanna was epic!` / `adrienne @adrienne 10h — Which community will I be seeing you at next??` |
| `release-standalone.png` | The same app as a **Release** build with the JS bundle embedded and Metro stopped — the configuration a real install runs | `• served by your node` / `60 casts from 34.101.47.167:3381` / `Nounish Prof @nounishprof 4h — why do we have to pick a side? only one of those "sides" is pushing us to do so` / `Greg @greg now` |
| `agent-not-hatched.png` | The Agent tab: the NOT-HATCHED surface, with the hatch URL and the honest soon-tags | `NOT HATCHED  this device` / `No Fiddy has hatched here yet.` / `Hatch your Fiddy` / `opens fiddy.fun/start in your browser — this app's session is not shared with the page` / `RUNS AGAINST http://34.101.47.167:3381` / `Answering in 588ms • version 0.14.3 • 3 shards` |
| `node-not-answering.png` | The honest failure state, captured before the ATS fix — this is what the pill and the feed do when the node does not answer | `your node is not answering` / `READ FAILED  fid 3` / `34.101.47.167:3381 is not answering — nothing below is cached` / `Your node did not answer` / `Could not reach the Snapchain node at http://34.101.47.167:3381 (Network request failed)` |

## Farcaster Articles (`t_6e650073`)

The article read path, photographed at 390 pt (1170 × 2532 px at 3×), with the
text read back by `tools/ocr.py` like the rows above. All five run against
`apps/fiddy-mobile/tools/articleStubNode.mjs`, a dev proxy that forwards every
read to the live public Snapchain node (`haatz.quilibrium.com`, v0.17.7) and
shapes only three things, each stated in its header comment: it answers
`linksByFid` with nobody followed so the feed is one account's casts, and
`--incomplete` / `--fail-chain` cut a chain read short so the two honest-copy
states can be photographed. The article itself is the real one, from fid 1.

| File | What it shows | OCR transcript (excerpt, bottom-of-screen first as the tool prints it) |
| --- | --- | --- |
| `article-01-feed-row.png` | The Feed: one row for a two-part article, with the affordance; part 2 is not a second row | `Article • 2 parts →` / `CAST 0XD59F6618...` / `Introducing Farcaster Articles!` / `The Basics` / `• Title and cover image. They show on the feed card and in share previews.` / then a different cast: `$1024 IN PRIZES FOR VIDEOS ON ALBION'S SEED` |
| `article-02-screen-top.png` | The article as one piece: title, byline, the root's cover from its single URL embed, then the body with `##` gone | `Article • 2 parts` / `Introducing Farcaster` / `Articles!` / `Farcaster @farcaster • 7h` / `The Basics` / `Title and cover image. They show on the feed card and in share previews.` / `A public page. Every article opens on web and mobile without an account, so the link works anywhere you share it.` / `On the protocol. Behind the scenes, an article is` |
| `article-03-screen-body.png` | Further down the same piece: headings, bold / italic / strikethrough, a blockquote, the embedded cast placed by `[$1]`, a link, and a table left literal | `Headings` / `Subheadings` / `Body text` / `Bold, italic and strikethrough` / `Blockquotes, for pulling out quotes or asides` / `**Embedded casts **` / `embedded cast • Oxfe13de98...` / `Inline images and video` / `imagedelivery.net` / `Tables and code` / `|If you want to|Use|` |
| `article-04-incomplete.png` | A chain whose later parts did not arrive: the count is stated, twice, and no total is invented | `This looks incomplete: 1 of 2 parts loaded` / `This looks incomplete: 1 of 2 parts loaded` / `read from 127.0.0.1:8791 in one pass • 1 of 2 parts` |
| `article-05-chain-failed.png` | A chain read that failed: the parts that arrived are still shown as an article, with plain copy | `part of an article; the rest did not load` / `part of an article; the rest did not load (HTTP 500)` / `read from 127.0.0.1:8791 in one pass • 1 of 2 parts` |

Two method notes, so these are not read as more than they are:

- **A code fence and an escaped `\*` are not in these screenshots**, because the
  live article from fid 1 has neither. Those two readbacks come from the
  renderer's own tests (`packages/farcaster-node-client/src/__tests__/articleMarkdown.test.ts`,
  “leaves a fenced block literal” and “prints an escaped asterisk as an asterisk”)
  rather than from a photograph, and `VERIFICATION.md` says so.
- **`**Embedded casts **` prints its asterisks on purpose.** The line in the real
  article has a space before its closing `**`, so CommonMark does not read it as
  emphasis, and neither does this renderer. The same screen shows `Bold`,
  `italic` and `strikethrough` rendered properly from well-formed markers.

Not in here: a physical-device install. `xcodebuild` refuses with
`iPhone needs to be unlocked to enable development services` until the phone is
unlocked; the Release build and the install command are ready.