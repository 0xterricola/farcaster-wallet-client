# A phone signs in in one tap, and a Mini App signs itself in

Status: **shipped**. Merged to `main` as `7a8c6e174f29f42951870ce4c6721faf906181a8`
(PR ivcained/fiddy#10), CI green, and released to fiddy.fun. This file is the
design record for the two ways in that never involve scanning a code with the
phone that is displaying it — what was measured against the live network, what
was built, what the probe proved, and what is still unproven.

Everything marked MEASURED was read off a real HTTP response, a real app-link
file, or a real browser run on 2026-10-21/22 and is named where it came from.
Anything not measured says so.

---

## 1. What it was

`LoginWithMobile` rendered `LoginQRCodeWithInstructions`: a QR code and one
sentence telling you to open the Farcaster app on your phone and scan it. That
is exactly right when the code is on a laptop screen.

It is unusable when it is not:

- **On a phone.** `https://fiddy.fun` in Safari or Chrome on the phone that
  holds the Farcaster app shows a code, and the only camera pointed at that code
  would have to be the same phone. There is nothing to scan and the modal waited
  for a scan that could not happen.
- **Inside Farcaster itself.** `fiddy.fun` is a registered Mini App, so it can
  be opened *inside* the Farcaster app — where the host already knows the fid,
  handle, display name and avatar of the person looking at it. Those visitors
  were shown a sign-in modal and a code, in the one place nothing needs to be
  asked or scanned at all.

## 2. What happens now

**On a phone.** The modal leads with one button — *Open in Farcaster on this
phone* — which is a plain `<a href>` to the URL the QR would have encoded. Tap
it, Farcaster opens on its own sign-in request, you approve it there, and the
page you left behind is still polling the relay channel that URL was made from,
so it finishes by itself, exactly as it does after a scan. The QR code is no
longer on screen by default (there would be nothing to scan it with); it is one
disclosure away behind *Show QR code for another device*, for anyone who would
rather hand the sign-in to a second device. Nothing about this is decided by
viewport width: it is decided by the device, and the copy says so.

**On a desktop.** Unchanged. The code is still the first thing on screen,
because there it works.

**Inside a Farcaster Mini App host.** No modal, no code, nothing typed. The app
recognises the host, calls `sdk.actions.ready()` so the host's own splash comes
down, reads who this is from the host context, asks the host to sign in with a
nonce of its own making, verifies the signature it gets back with the QR flow's
own checks, and signs in — landing inside the client, signed in as the account
the host already had.

## 3. What it rests on, and what was measured

**The deep link is a real link into the app, on both platforms.** MEASURED:

- the relay answers a channel with
  `{"channelToken":"GYYQH2LG","url":"https://farcaster.xyz/~/siwf?channelToken=GYYQH2LG", …}`
  (`POST https://relay.farcaster.xyz/v1/channel`, 2026-10-21) — note the host is
  `farcaster.xyz`, not `warpcast.com`;
- `https://farcaster.xyz/.well-known/apple-app-site-association` lists
  `V9B5DUDJ36.com.farcaster.mobile-client` (and `YXBSCD696G…`) with path `*`,
  excluding only `/~/download`, `/~/register`, `/~/code/*`, `/~/r/*`,
  `/referralCode/*` and `/magic-link` — `/~/siwf` is therefore an app link;
- `https://farcaster.xyz/.well-known/assetlinks.json` grants
  `delegate_permission/common.handle_all_urls` to `com.farcaster.mobile`, so
  Android App Links cover it too.

**`fiddy.fun` is a Mini App.** MEASURED: `GET
https://fiddy.fun/.well-known/farcaster.json` → 200, with an
`accountAssociation` and a `miniapp` block whose `homeUrl` is
`https://fiddy.fun`, `webhookUrl` `https://fiddy.fun/api/webhook`. That is what
makes the host's context available to this client at all.

**The protocol is the real one, both directions.** The app side is
`@farcaster/miniapp-sdk` 0.3.0 — a new direct dependency, whose own deps are
`ox`, `comlink`, `eventemitter3`, `@farcaster/quick-auth` and
`@farcaster/miniapp-core` (already in the tree as a host dependency). The host
side of the probe is this repo's own `@farcaster/miniapp-host` 0.3.0: the same
package `components/miniApp/MiniApp.tsx` uses to run other people's Mini Apps,
which is why the verification below is a conversation between two real
implementations rather than two stubs agreeing with each other.

**CSP does not block being framed.** MEASURED: fiddy.fun's response carries no
`frame-ancestors` directive and no `X-Frame-Options`, so a Mini App host can
embed it. (This is also the reason §5's guard exists.)

## 4. What is verified, and how

**Unit — 26 new tests, all green** (`npx vitest run` in `apps/farcaster-web`):

- `src/lib/__tests__/miniAppSession.test.ts` (16): the flow refuses rather than
  guesses. A host that will not name an account gets no signature request; a
  signature made for another nonce, another domain, or a tampered message is
  refused; a signature whose `farcaster://fid/<n>` resource disagrees with the
  host context is refused and says both numbers; a host that never answers is
  given up on after the timeout instead of waiting forever; a "no" from the
  person is an outcome, not an exception; a host that will not take `ready()`
  still signs in, with `readyAnnounced: false`; a page outside a host does
  nothing at all. Two of these load the **real** SDK to assert the shape this
  module drives actually exists.
- `src/components/login/__tests__/LoginQRCodeWithInstructions.test.tsx` (4):
  on an iPhone UA the deep-link anchor carries exactly the URL the QR would,
  the code is absent until the disclosure is pressed, and the tap is counted;
  on a desktop UA the code is first and there is no deep-link button at all.
- `src/components/session/__tests__/MiniAppAutoSignIn.test.tsx` (6): the
  session and its onboarding state are written before the sign-in (the reboot
  reads them back by key); the overlay says what is happening; a refusal leaves
  the sign-in door open and signs nobody in; an existing session is left alone
  but still takes the host's splash down; and a second attempt in the same tab
  session never happens.

**Browser — `scripts/verify-miniapp-autologin.mjs`, 12/12**, against a dev
server (`HTTPS=true npx vite --port 5210`) in a real Chrome:

| Check | Result |
| --- | --- |
| A1 the modal opens on a phone (390x844, iPhone Safari UA) | opened from the landing's "Go social" |
| A2 the button opens the app at the URL the QR encodes | `https://farcaster.xyz/~/siwf?channelToken=PROBE001` |
| A3 the label is for the device | "Open in Farcaster on this phone" |
| A4 no code on screen for a phone to fail to scan | 0 canvases before, 1 after the toggle |
| A5 the code is still reachable behind the disclosure | toggle label exact; gone once pressed |
| A6 the channel behind it is real, created once | 1 × `POST /v1/channel`, then status polls |
| B1 the hosted app calls `ready()` | `["ready", …]` |
| B2 it asks the host to sign in with its own nonce | `signIn nonce=91d5c6f0…852b` (64 hex) |
| B3 it comes back up signed in, not on the landing | signed-in surface, `landing=false` |
| B4 no door and no code were shown inside the host | `door=false overlay=false` |
| B5 nothing was left half-signed-in | no refusal notice |
| B6 one attempt, marked for the tab session | `fiddy.miniapp.auto-sign-in = true` |

Run the same probe against a **node-backed** server
(`SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com`
`VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com`, port 5211) and B3 is
the thing the card asked for, read off the hosted frame's own DOM: `Home
Following Feed Agent Wallet Settings`, the client's nav and surface, signed in
as the host's account (`@probe-host · fid 191554`), with the offer card
("Let Fiddy post as you?") available rather than a wall. Both server
configurations: **12/12**.

Screenshots from both runs: `t_eb10ef8a-shots/phone-login-door.png`,
`…-qr-disclosed.png`, `miniapp-host-autologin.png`, and the node-backed copies
in `t_eb10ef8a-shots-node/`.

To run it yourself:

```bash
cd apps/farcaster-web
HTTPS=true npx vite --port 5210
PROBE_SERVER=https://localhost:5210 node scripts/verify-miniapp-autologin.mjs
```

With only `SNAPCHAIN_HTTP_URL` set (and not `VITE_SNAPCHAIN_HTTP_URL`) a
completed sign-in lands on the device-only landing instead of the client — the
same trap `CLIENT-RELEASE.md` records for the embed probe — and B3 still passes
because that landing is not the public one. Set both to see the client itself.

## 5. What a failure looks like

Nothing here can half-sign anybody in.

- **The person says no, or the host never answers.** A line at the top of the
  screen says what happened ("that sign-in was not approved in Farcaster…",
  "the host did not answer the sign-in request in time") and ends with *nothing
  was signed in on this device*. The ordinary sign-in door is untouched, five
  pixels below it.
- **The proof does not hold up.** A signature for another nonce, another domain,
  or a message whose fid disagrees with the host context is refused, and the
  reason the verifier gave is what the screen prints. No session is created.
- **The reload does not take.** A completed host sign-in ends in a reload (the
  same reboot the QR flow does). If the reload came back still signed out, an
  unguarded component would sign in again, reload again — forever, inside
  somebody's Farcaster app. So there is one attempt per tab session
  (`sessionStorage['fiddy.miniapp.auto-sign-in']`), and on the second entry the
  component only takes the host's splash down and leaves the door to the person.

## 6. Still open

- **A real phone's tap was not observed.** What is MEASURED is that the URL the
  button carries is an app link on both platforms (§3). Whether iOS or Android
  hands that tap to the Farcaster app, and whether the app then completes the
  channel, is the documented SIWF flow but it was not run on a device from this
  machine. If it does not, the page falls back to what it always did: the
  relay poll is identical, and the code is one tap away.
- **A real Warpcast host was not observed.** The host in the probe is this
  repo's own `@farcaster/miniapp-host` with a fake user and a real signature.
  That is the same protocol implementation the client itself uses, but it is
  not Warpcast: whether a production host answers `context` and `signIn` the
  same way — and whether it passes our nonce through untouched — is unverified
  here.
- **The fid↔address binding is still unchecked**, exactly as
  `~/lib/siwfSession` records for the QR flow: the signature proves an address
  signed a message for this host with this nonce, not that the address controls
  the fid. The session is local-only and grants no privileged access, so the gap
  is structural rather than dangerous — but it is a gap.
- **`sdk.actions.signIn` needs the host to support it.** The capability list on
  the wire (`getCapabilities`) includes `actions.signIn`, and the SDK's
  `isInMiniApp` only proves a host is there. A host that can hand over a context
  but not sign a message will produce a refusal, not a session — by design, and
  the refusal says so.
- **`fiddySetup` is not "pre-filled" and does not need to be.** It holds the
  setup wizard's own state (agent name, brain, apps) for a person who goes
  through that wizard. A Mini App visitor is not asked anything, so there is
  nothing to pre-fill: they land in the client with a real local session
  (`hasCompletedRegistration: true`, name, handle, avatar) and the wizard's
  state is left alone.
---

## 7. Shipped

**Landed.** PR ivcained/fiddy#10, merged into `main` as
`7a8c6e174f29f42951870ce4c6721faf906181a8`. CI on the branch head
(`4688ba01`, run 39694012894) and on the merge (`7a8c6e17`, run 39694746266):
lint, typecheck and test all green.

**Released.** `bash scripts/release-client.sh
7a8c6e174f29f42951870ce4c6721faf906181a8`, exit 0 — every gate in the script
passed, including step 8's served gate: the origin's shell is byte-identical to
the built one and its entry chunk (`/assets/index-_VP6gFRZ.js`, 8 025 791 bytes,
sha256 `5555fa3e7cd629af…`) is the one this build produced, and
`https://fiddy.fun/release.json` names the full 40-character sha. The first
attempt at this release was refused by that same step-8 check and rolled itself
back: it ran a copy of `release-client.sh` that wrote the *short* sha into
`release.json` (the defect `t_0b9dc099` fixed on main) while the gate compared
against the full one. The artifact was never served — the script's rollback
put `7ee0f24455961200baaf85af4b1dd47dd6e86339` back before anyone saw it.

**Re-verified on the landed tree**, in this pass, not carried over:

- `npx vitest run src/lib/__tests__/miniAppSession.test.ts
  src/components/login/__tests__/LoginQRCodeWithInstructions.test.tsx
  src/components/session/__tests__/MiniAppAutoSignIn.test.tsx` — 3 files, **26
  passed**;
- `scripts/verify-miniapp-autologin.mjs` against a dev server — **12/12**, and
  **12/12** again with the node-backed configuration
  (`VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com`), where B3's text is
  the client itself: `Home Public Cast Home Following Feed Agent Wallet
  Settings`, signed in as `@probe-host · fid 191554` (screenshots:
  `t_eb10ef8a-shots-run2/`, `t_eb10ef8a-shots-node-run2/`);
- the **live** release, in a real Chrome at 390x844 with an iPhone UA
  (`t_eb10ef8a-shots-live/phone-login-live.png`): the modal leads with *Open in
  Farcaster on this phone* → `https://farcaster.xyz/~/siwf?channelToken=MXVGBEQU`
  (a channel the real relay issued in that run), **0** canvases on screen, and
  exactly one after pressing *Show QR code for another device*.

The limits in §6 stand: a real phone's tap and a real Warpcast host were not
observed from this machine, and the fid↔address binding is still unchecked.
