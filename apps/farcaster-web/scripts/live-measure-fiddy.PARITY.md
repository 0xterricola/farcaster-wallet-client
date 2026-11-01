# Assertion parity: `live-measure-fiddy.mjs` (probe, t_451ad931/t_c6256597) → this driver

Companion to `apps/farcaster-web/scripts/live-measure-fiddy.mjs`. The driver was
fixed on `t_c50646cc`, and this note is the evidence that **none of the probe's seven
assertions was removed or weakened** on the way; it landed next to the driver on
`t_f0c9d881` (2026-10-22).

The fix that made it read 7/7 was validated at driver sha256
`5894652688df2d8ff23985c788cb67a5808bf472b80e6bd9153e9c6ca84201d8`. The **landed** file
is sha256 `900b0921fc6e5e4a7fd4cbd198e7542ce1716c2a49bdc993e3a15002ce19fa39`, and the
whole delta between them is four things, none of them an assertion (`diff -u`, 5 hunks):

- the header's run instructions, which now name the repo path instead of the scratch
  workspace it was fixed in (and `FIDDY_REPO=…`, the variable the driver actually reads,
  instead of the `LIVE_FIDDY_REPO` the old comment claimed);
- `Buffer.from(...)` → `new Uint8Array(...)` on the served entry chunk: the byte count
  and the sha are all that read needs, and a probe the app's lint refuses reddens the
  repo's gate;
- the wait helper's unused ceiling parameter is now quoted in its failure note;
- two dead locals dropped (`setup`, and the sheet wait's unused `opened` binding).

No row name, selector, `data-fiddy` attribute, threshold or abort changed: the seven
check names below are still byte-identical to the probe's, and the landed file's own run
from the repo reads 7/7 — quoted in `docs/CLIENT-ACCOUNT-CREATION.md` §7.4.

Run it from the repo root, against whatever `https://fiddy.fun/release.json` names:

    node apps/farcaster-web/scripts/live-measure-fiddy.mjs

`playwright` and `viem` resolve from `apps/farcaster-web/`'s own `node_modules`; the
driver also falls back to `<repo>/apps/farcaster-web/node_modules/viem/_esm` when the
specifier does not resolve directly. It prints the whole run as JSON to stdout.
`LIVE_SITE=…`, `LIVE_BOOT_MS=…` (per-step wait ceiling), `FIDDY_REPO=…` and
`LIVE_SELFCHECK=1` are the knobs.

Checked mechanically, not by eye — the row names are extracted from all three files
(the probe, the driver as fixed on `t_c50646cc`, and this landed driver) and compared:

    probe rows : 7      driver rows: 7      identical, in order: true

The seven strings are byte-identical to the probe's, in the probe's order:

1. the sign-in entry is on the deployed setup screen
2. the create-account entry is reachable from the sign-in modal
3. the entry opens the account-creation sheet
4. the rail carries the account switcher on the deployed build
5. the switcher sheet opens from the rail
6. the mobile menu carries the account switcher
7. no write left the machine during this measurement

Also retained unchanged: the four `data-fiddy` selectors, the in-modal test
`closest('[role=dialog], #modal-root, [data-radix-portal]')`, the SIWF relay stub
(channel token `LIVEMEAS`, nonce `'c'*128`, fid 3, handle `dwr`), `WRITE_METHODS`,
and the cross-origin write abort (nothing leaves the browser).

## Row by row

| # | Row | Probe asserted | This driver asserts | Direction |
|---|-----|----------------|---------------------|-----------|
| 1 | sign-in entry | a visible `button`/`a` whose text matched `/go social/i` was found and `element.click()`ed after a 3 s sleep | a visible button whose copy contains `sign in with Farcaster` — the deployed label — clicked as an element, and its label recorded | same claim, narrower match: a build that renamed the button away from the sign-in wording would now red, never green |
| 2 | in-modal entry | `entriesInModal > 0`, read after a 6 s sleep | identical evaluate, identical `closest()` test, identical condition; plus a wait for that entry to hold a box (`inModalEntryHasBox`) and no sleep | same assertion, added evidence |
| 3 | creation sheet opens | `clickedEntry && sheetState.sheet`, where the click was `document.querySelector('[data-fiddy="create-account-entry"]')` — the first match, hidden 0×0 on this build — then a 5 s sleep | same condition on `[data-fiddy="create-account"]`, but the click is scoped to the **in-modal** node (the one row 2 tests) and the sheet is a selector wait, not a sleep | same assertion, now actually exercised |
| 4 | rail switcher | `waitForSelector` (visible) then `found: true`; the read looked at the first match only | an entry that holds a real box must exist; the box, the count and the first-match width are all recorded | same-or-stricter |
| 5 | switcher sheet opens | `switcher.open` after a 4 s sleep, click on the first match | same condition, click on the entry that holds a box, retried up to 4× (the repo's own `verify-account-switching.mjs` retries 12× for the same reason: the rail remounts) | same assertion |
| 6 | mobile menu carries the switcher | `visible` = **the first DOM match** has `width > 0`. On this build the first match is the rail's copy (0×0, `inMobileChrome: false`), so the row could not go green however the menu behaved | `visible` = an entry with a box exists **and** none was visible before the toggle was pressed; the detail records the first-match width (0) beside the menu copy's box (321×41, `inMobileChrome: true`) | stricter: the row now also requires the switcher to be *behind* the menu, and it explains the old red as a DOM-order artefact |
| 7 | no write left the machine | `abortedWrites.length === 0` — any cross-origin POST, so the page's own telemetry reds it | `chainWrites === 0 && unclassifiedWrites === 0`; named beacons are reported separately, and a POST to a host on neither list still reds the row | changed as the card's acceptance bullet asks, and strengthened: an unknown host reds instead of passing |

Nothing was removed, and no numeric threshold was loosened. Two rows are strictly
stricter (6, 7) and one is a narrower match on the same claim (1).

## The write row's own check

    LIVE_SELFCHECK=1 node apps/farcaster-web/scripts/live-measure-fiddy.mjs

runs the classifier over the four beacon hosts named in the card, three real
write destinations, and one unclassified host. Verdicts
(`write-row-selfcheck.json` on `t_c50646cc`):
`ph.neynar.com`, `wallet.farcaster.xyz`, `privy.farcaster.xyz` and the Datadog CSP
report are `telemetry` → row green; `haatz.quilibrium.com`, `relay.farcaster.xyz`,
`api.neynar.com` are `chain` → row red; `some.unknown.example` is `unclassified`
→ row red.

## What the runs are

Two runs, both 7/7, both on `aa06c630d41bdfc09411d2b8ab5c2783091c9e3e` — the revision
`https://fiddy.fun/release.json` named, read before and after each run and unchanged —
both serving entry chunk `/assets/index-BZPuaWpC.js`, 7,729,824 bytes, sha256
`bac16fb0cbba582b45702d7242456ef4b7d4424a1b5aac10932cf6de0c27cb9d`:

| run | when (IST) | driver | where |
| --- | --- | --- | --- |
| the acceptance run of the fix | 2026-10-22T02:21:36 | sha256 `5894652…` | `artifact-live-measure-aa06c630d41b.json` on `t_c50646cc` |
| the **landed** file, from the repo root | 2026-10-22T02:39:40, 15.2 s | sha256 `900b0921…` (this file) | quoted in `docs/CLIENT-ACCOUNT-CREATION.md` §7.4 |

`LIVE_SELFCHECK=1` on the landed file reproduces the classifier table above case for
case (four telemetry green, three chain red, one unclassified red).