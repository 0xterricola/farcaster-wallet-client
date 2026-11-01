# The approval that comes to the reader: a write with no posting key yet

Status 2026-10-22. This is the design record for the onboarding card "inline
1-tap phone/wallet signer approval on first post or like" (card 4/5): what
happens when somebody presses **Cast**, the heart, **Recast** or **Follow**
before this device holds anything that may sign for them, why the pending write
is *held* rather than refused, what was measured, and which half of it no machine
without a phone can verify.

Everything marked MEASURED was read off a real response, a real page or a real
run on 2026-10-22. Anything not measured says so.

---

## 1. What it was

MEASURED (2026-10-21, the live client, signed in, no key on the device): the
composer reached `POST /v2/casts` and the heart reached `PUT /v2/cast-likes`;
both were answered

    501 "This device has no key it may sign for you with yet, so nothing was
         signed and nothing was sent. Open Advanced → your setup and press
         “Issue app key” once; …"

That sentence is true, and it names a screen two taps away from where the reader
is standing — in the middle of writing a post. The only flow behind it was
`SeedPhraseWarningModal`: an "⚠️ Security warning … use a TEST account" screen
asking a person to paste twelve words of their account's recovery phrase into a
web page. No everyday reader will do that, and none should.

## 2. What happens now

```
the reader presses Cast / the heart          (nothing changes in the fork)
        │
        ▼
the fork's data layer → the write seam       (~/snapchain/providers, nodeApi)
        │
        ▼
nodeWrites.answer()                          no granted key, no device key
        │
        ├── askForPostingKey(pending write)  ← the seam's new option
        │        │
        │        ▼
        │   ~/snapchain/accounts/postingKeyApproval   (the store; React-free)
        │        │   one write at a time, five-minute deadline
        │        ▼
        │   ~/components/session/SignerApprovalGate   (the screen, in place)
        │        │   the SAME ConnectSheet /connect-farcaster shows, autoStart
        │        ▼
        │   the reader approves Fiddy in their own Farcaster app
        │        │   (the sheet polls; nobody presses twice)
        │        ▼
        └── carry() ── the very same request, answered again
                 the granted key carries it (managedPoster), the node's own
                 state is read back, and the original caller gets that answer
```

Three properties are the whole point:

1. **The write is held, not re-issued by the UI.** The caller (the fork's own
   composer, or the heart's mutation) receives the *real* answer of its own
   request. So the heart fills, the composer closes, and nothing has to be
   pressed a second time — no optimistic state is faked anywhere.
2. **The approval is the one that already existed.** `/connect-farcaster`'s
   `ConnectSheet` — the service's own link, a code to scan, a poll that notices
   the approval by itself — with `autoStart` and an `onApproved` callback. There
   is no second approval implementation, and no second place that talks to the
   service.
3. **Nothing is claimed that did not happen.** With nobody to ask, a person who
   says *not now*, an approval that does not produce a key, or a screen that
   cannot be reached, the answer is byte-for-byte the refusal above — same
   status, same sentence, nothing signed. A retry after an approval is answered
   with `allowAsk: false`, so a broken approval cannot loop the screen.

The phrases the reader meets, per write: `your like`, `your recast`,
`the follow`, `your post` (and `the change` for an undo). They come from the
intent the writer already classified (`approvalLabelFor`) — never from the UI
guessing.

## 3. The Advanced screen's half

`/~/settings/node` used to lead with an "Issue app key" button that opened the
recovery-phrase warning. It now leads with **"Let Fiddy post for you"**
(`PostingKeyCard`): the same phone approval, its state read from the service's
own answer (`none` / `waiting` / `connected` / `revoked`), and one sentence about
what Fiddy may do and how to take it back. The recovery-phrase path is behind a
collapsed disclosure, labelled for what it is —

    Advanced: test account recovery phrase (developers only)

— and the disclosure opens by itself when a device key is *live*, because that is
where such a key is revoked from. The offer card's own copy
(`postForYouStep`/`PostForYouStep`) is a separate card's artifact and still routes
to the phrase step; re-pointing it at this sheet is a follow-up, not a change
made here (see §6).

## 4. What is verified, and how

**Unit tests** (all green; `npx vitest run` on the touched files):

- `~/snapchain/accounts/__tests__/postingKeyApproval.test.ts` (6) — the store's
  contract: one write in front of the person, a decision that ends the wait, the
  carried write's own answer passed through untouched (a 502 stays a 502), a
  second write joining the same tap, and the deadline ending the wait instead of
  hanging a request.
- `~/snapchain/nodeApi/__tests__/nodeWrites.test.ts` (+5) — the writer's half:
  the asker is asked once with the right label; the like is carried by the
  granted key and the node's own state is still read back before success; a
  decline, no asker, an unreachable asker and an approval that did not really
  happen all leave the old refusal untouched and sign nothing; the retry never
  asks twice.
- `~/components/session/__tests__/signerApprovalGate.test.tsx` (4) — the screen:
  nothing when nothing waits; the sheet in place with the service's own link and
  the sentence naming the write; the one line while the approved write goes out;
  *not now* leaves nothing behind. It also asserts no protocol word reaches the
  screen.
- `~/components/fiddy/accounts/__tests__/connectSheet.test.tsx` (+2) — the flow
  asks by itself and answers its caller instead of signing anybody in.
- `~/pages/settingsNode/Component/PostingKeyCard.test.tsx` (5) — the card: the
  phone approval is the button, the connected state comes from the service, an
  unreachable service is one sentence, and there is no field on this card to type
  a phrase into.

**The headless browser probe**
(`scripts/verify-inline-posting-approval.mjs`, 14 checks, exit 0, Chrome,
2026-10-22, against a vite dev server started node-backed with
`VITE_SNAPCHAIN_DEBUG=true`): it signs in through the real SIWF handshake (the
relay stubbed with a **real SIWE message** signed by a throwaway key, so the
app's own verifier has to accept it), opens the composer, types a cast, presses
**Cast**, and then holds the whole claim:

| check | what it asserts |
| --- | --- |
| 4 | the approval rises in place — same path, no navigation, one screen |
| 5 | the sentence names what was pressed, the QR and the link are the service's own, and no protocol word is on it |
| 6 | exactly one request to the service: it asks by itself, nobody presses twice |
| 7 | no security warning and no phrase field anywhere in the flow |
| 8 | the moment the service says the key exists, the screen says the write is going out |
| 9 | the cast the person typed is carried **once**, with the granted key, and nothing is signed on this device |
| 10 | the answer follows the node's own state: the write's evidence is `accepted: true, landed: false` (the stub service really posts nothing) and the page says it cannot say it posted |
| 11–14 | on `/~/settings/node`: the phone approval leads, the recovery-phrase path is collapsed and invisible to a normal reader, and it is still there for a developer who opens the disclosure |

The service is **stubbed**, and it has to be: approving a posting key happens in
a person's own Farcaster app, and a real request spends the owner's Neynar
credits (measured live: `POST https://fiddy.fun/api/fiddy/connect` → 200 with a
real `https://client.farcaster.xyz/deeplinks/signed-key-request?token=0x…`, and
`GET` the same route → `{"state":"none"}` for a caller with no cookie). The stub
answers those exact shapes; everything else in the run is the app.

**Not verified here, and it cannot be from this machine:** the approval tap
itself, and therefore a cast or like that really lands on mainnet under the
owner's own FID. That is one person, in their own app, pressing approve — the same
open item as `docs/BOUNTY-DEADLINE.md` §6, `docs/VOUCHER-CAMPAIGN.md` P4 and
`docs/CLIENT-FARCASTER-CONNECT.md` §7. What this card changes is that the reader
no longer has to know anything about keys to get there.

**The like/recast/follow paths** are covered by the unit tests (the same seam
code, a different label and payload) and by the cast path in the probe, which is
the only one a probe can drive without a person's tap. The probe drives one write
verb end to end; it does not claim to have driven four.

## 5. What a failure looks like

| what happened | what the reader gets |
| --- | --- |
| signed out | unchanged: "No account is signed in on this device…" |
| no asker wired (a probe, an old embed) | unchanged: the `NO_APP_KEY` sentence |
| they pressed *Not now* | unchanged `NO_APP_KEY` sentence; nothing signed |
| the service cannot be reached | the sheet's own problem screen, one sentence, *Try again* / *Close*; closing is *not now* |
| approved, but the write is refused by the node | the node's own words, exactly as a device-signed write reports them |
| approved, service says it took it, node does not show it | `502` "…accepted this cast, but a node is not showing it yet — so this client cannot say it posted." |
| five minutes of silence | the wait ends; the original refusal, nothing signed |

**Measured defect found while building this, and fixed rather than shipped:** the
store's first version cleared the write in front of the person the instant the
approval arrived, so the screen unmounted itself for one render and then came
back as the "going out" line. The unit test above caught it (`asking → idle →
finishing → idle` instead of `asking → finishing → idle`); the store now keeps
the write's name until the last write it is carrying has been answered.

## 6. Still open

1. **The tap.** One person, in their own Farcaster app. Everything up to it is
   asserted; the tap itself cannot be.
2. **The offer card's copy.** `PostForYouStep` (the one-time "Let Fiddy post as
   you?" offer, a different card's artifact) still opened
   `SeedPhraseWarningModal`. **Closed by card `t_0b9dc099` (2026-10-22):** the
   offer's "Set it up" now mounts this same sheet (`autoStart` + `onApproved`),
   the offer ends and is remembered the moment the approval arrives, and the
   phrase step moved behind a collapsed "Advanced: test account recovery phrase
   (developers only)" disclosure on the card — still the same blocking
   `SeedPhraseWarningModal` behind it. That card's own probe
   (`scripts/verify-post-for-you.mjs`, rewritten for it) pins both halves,
   and `docs/CLIENT-PARITY.md` has the details.
3. **On a copy of Fiddy you run yourself**, the sheet used to dead-end: that
   address had no service to answer it. Card `t_745ed5be` closed that half (the
   instance's own service, `server/instance/connect.mjs`, with the instance's own
   account asking), and with it the sign-in half (the reader's own node names the
   FID the SIWF signature belongs to). See
   `docs/CLIENT-SELF-HOSTED-CONNECT.md`.
4. **A wallet-signed approval.** The card mentioned "QR scan / deep link … or
   connected wallet EIP-712". The phone approval is the implemented, live one
   (measured above); an EIP-712 signature from a custody wallet is *not*
   implemented, and would matter only for accounts whose custody key is held in a
   browser wallet rather than by their Farcaster app.
4. **Deploying the service's half where the client expects it.** `/api/fiddy/connect`
   answers live on fiddy.fun today (measured), but the control plane revision
   serving it and the nginx locations are an operator step recorded on
   `t_bf774a5b`.