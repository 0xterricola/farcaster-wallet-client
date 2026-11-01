# Connecting a Farcaster account: one tap, no fee, no phrase

Status: **implemented on branch `t_662333ce-neynar-connect`** (client) with its
server half on `t_662333ce-connect-api` (control plane, `legitmate-farcaster`).
This file is the design record: what a person sees, where every credential
lives, what was measured against the real network, how this coexists with making
a *new* account rather than connecting an existing one, and what is still open.

Everything marked MEASURED was read off a real API response, a real EIP-712
signature, or the committed source on 2026-10-21. Anything not measured says so.

---

## 1. What the person does

1. Presses **Connect** on `/connect-farcaster` (or the door in the sign-in
   modal: "Already on Farcaster? Let Fiddy post for you").
2. Sees a code to scan / a link to open, and one sentence about what they are
   allowing.
3. Opens the link in their Farcaster app and approves Fiddy there.
4. The screen notices the approval **by itself** (it polls) and says what is now
   true: "Fiddy can post for you — turn it off anytime."
5. From then on, Fiddy posts, replies, likes, recasts and follows as them, with
   the key they granted. Turning it off happens either on that same screen
   ("Turn it off") or in the app's own settings.

No fee is charged to them at any point, and no recovery phrase is ever entered,
stored or asked for. Their account, its custody key and its phrase never move.

## 2. Where the credentials live

| thing | where | why there |
| --- | --- | --- |
| Neynar API key | server (`NEYNAR_API_KEY` in the control plane's env) | it is a paid credential; it must never ship in a bundle |
| Fiddy's app-account signing key | server (`FIDDY_CONNECT_APP_KEY`) | it signs the protocol's signer request |
| the signer's own identifier | server, keyed by an opaque handle | Neynar's own guidance: it is a secret, held by the backend |
| the person's *handle* | browser, in an **HttpOnly** cookie | scripts cannot read it; the client never sees the signer id |
| the person's account, key, phrase | their Farcaster app, untouched | the point of the whole design |

The browser therefore holds **no credential at all** — and the client's own copy
of this flow (`src/snapchain/accounts/managedConnect.ts`) reads a status object
and nothing else.

## 3. What was measured against the real network (2026-10-21)

`scripts/verify-fiddy-connect.mjs` in the control-plane repo drives the real
module against `api.neynar.com` with the owner's key:

- `POST /v2/farcaster/signer` → **200**, `{signer_uuid, public_key, status:
  "generated"}`. **No approval link at this state** (the field is `null`).
- `POST /v2/farcaster/signer/signed_key` **requires** an EIP-712 `signature` from
  the requesting app FID's custody key: asking without one answers
  `400 {"code":"RequiredField","message":"signature is required"}`. Neynar's
  sponsorship flag does **not** replace it. This is why the server refuses to
  half-connect anybody when the app account is not configured
  (`CONNECT_NOT_SET_UP`, 501) instead of falling back to something cheaper.
- With the app account's key, the EIP-712 `SignedKeyRequest`
  (`Farcaster SignedKeyRequestValidator`, v1, chainId 10,
  `0x00000000fc700472606ed4fa22623acf62c60553`) and
  `sponsor: {sponsored_by_neynar: true}`, registration answers a real approval
  link of the form
  `https://client.farcaster.xyz/deeplinks/signed-key-request?token=0x…` and the
  signer moves to `pending_approval`.
- `GET /v2/farcaster/signer?signer_uuid=…` answers the state, and `fid` once
  approved — which is exactly what the client polls.
- **Not measured:** the moment of approval itself. That is a person tapping in
  their own Farcaster app; the run leaves the link ready and says so. The
  client's polling path is asserted against a stubbed service instead.

Cost, stated plainly: registering a *sponsored* request is what costs the owner
money (Neynar bills the API key's account in credits for the sponsorship). The
verification run did this once, on purpose, and reuses a waiting signer rather
than creating a second one — the module's own reuse rule, and the reason the
"start" endpoint hands back an existing link instead of minting a new signer.

**Which account is Fiddy's "app" account.** Signing the request needs a
registered FID whose custody key we hold. The owner's only such account is
`@fiddy-one` (FID 3356372, deployed for the agent work). It is configured, not
hard-coded, as `FIDDY_CONNECT_APP_FID` + `FIDDY_CONNECT_APP_KEY`, so a dedicated
app account can replace it by changing two environment values — no code change.

It is the account that *asks*, never the account that *owns* the connection:
Neynar's own documentation for the managed-signer flow is explicit that the app
FID signs the request and the person who opens the link approves the key for
their own account ("The user opens the link and completes the Onchain Signer Add
Request flow... The app finds the user's fid in the polling response"). A person
who approves the request while their Farcaster client happens to be signed in as
the app account therefore approves it **for that account** — which is exactly the
wrong-account outcome the next section exists to refuse.

## 4. Whose account a connection becomes — the identity rule

**Status of the two halves.** Both halves are in. The client half is in the
client release (`t_e9657ffb-connect-identity`): it binds every connect request to
the FID this browser is signed in as, and it refuses to enter a connection that
is not the person's own. The service half is **deployed** on the control plane
(`legitmate-farcaster` main `0ab9f386`, PR #4): the same proof now travels with
the request and is checked *before* anything is created, a request is keyed with
the FID it proved, an approval for Fiddy's own account — or for an account the
request was not started for — is answered `wrong_account` with the key removed at
Neynar rather than forgotten, and a request that is not the person's own is never
handed back to them.

Measured after the cutover (2026-10-22, `fiddy-auth` on
`/opt/fiddy-auth/releases/0ab9f386…`): `GET https://fiddy.fun/api/fiddy/connect`
with no cookie answers `{ok:true,state:'none',approvalUrl:null,fid:null,username:null,forFid:null,refused:null,attempt:null,machine:false}`
(200, not 500); the live store was upgraded in place — `for_fid`, `attempt` and
`refused` added to the table that was already there — and holds no row whose `fid`
is the app account (`3356372`), the three rows it holds being the two
`pending_approval` requests and the one `approved` connection belonging to the
person's own FID; and in a real browser with nobody signed in, a tab's own label
came back on its next read (`POST {attempt}` → the waiting request was reused, no
signer minted → `GET` echoed the same `attempt`), which is what makes
`startedHere` work on a device that never signed in.

One tap can bind a browser to a Farcaster account, so the question "whose?" is
answered twice, with evidence, and never by assertion.

**What the browser proves.** A signed-in device hands the service its own SIWF
proof with the request: the FID it is signed in as, the SIWE message its
Farcaster app signed, and the signature over it. The service checks the message
names the host the request arrived on, the signature recovers to the address the
message names (`viem`'s `verifyMessage`, pure ECDSA), the proof is fresh, and
Farcaster itself says that address is that FID's own — custody address, or one of
its published verified addresses (read through Neynar, which this route already
depends on). Only then is the request *for* that FID. A FID without a proof is
never believed: the request is simply unbound, and then the approval alone
decides.

**What the service refuses.** Two facts must hold before anything is reported
`connected`, and either failure is reported as `wrong_account` — with the key
removed at Neynar, not merely forgotten:

1. the account that approved is **not Fiddy's own app account**. A key attached
   to our account is ours; a browser that adopted it would be signed in as
   Fiddy. In that case the browser is told nothing about it at all — no number,
   no handle — so there is nothing to adopt and nothing to leak.
2. an approval that contradicts the FID the request was started for (a bound
   request) is not a connection either. A connection belongs to one person.

**What the client refuses, on its own.** `ConnectSheet` adopts an identity only
when the connection is the person's own: the approval must be for the account
they are already signed in as, or — on a device nobody is signed in on — for the
request THIS tab started (`sessionStorage` label, echoed by the service). A
connection left in the cookie jar by somebody else on a shared device is named
and confirmed, never entered in one tap. And the one place a session's identity
is set (`continueAs`) refuses an account that contradicts the signed-in one, so
nothing switches silently.

**What was measured, and what is asserted.** `scripts/probe-connect-identity.mjs`
drives the running client at 390 and 1440 with a real SIWE sign-in (the relay
stubbed with a message signed by a throwaway key) and the connect service stubbed
(a probe never mints a real sponsored signer: that spends the owner's Neynar
credits). It asserts the request carries the person's own proof; that their own
approval signs them in as themselves; that the fixed service's refusal is shown
and Fiddy's own account appears nowhere on the page or in storage; and that a
service which has *not* been fixed — one that reports Fiddy's own account as the
connection — still cannot sign this browser in as it. It ran green at both
viewports on 2026-10-22 (14/14 checks) against a stubbed service; the client
under test has to be the node-backed build (`VITE_SNAPCHAIN_HTTP_URL` set),
because a device-only session never renders the connect surface at all — that is
in the probe's own header, and a run without it fails from step B down. The live
service's own record agreed with the design on 2026-10-22: the one approved
connection in its database belongs to the person's own FID (`@ivc`, 191554), and
no stored row has ever held the app account (`@fiddy-one`, 3356372); the two
other rows are both `pending_approval`. So there is nothing to clear for the
reported connection — what was wrong is that the *session* took its identity from
whatever the service answered, and that is what this release changed.

## 5. Coexisting with making a *new* account

There are two honest ways to end up with an account Fiddy can post from, and
they are different products:

- **connect an account you already have** — this branch. One tap, no fee, no
  phrase; the trade is that Fiddy holds a posting key the person granted and can
  revoke.
- **make a new account here** — the account-creation work landing separately
  (`docs/CLIENT-ACCOUNT-CREATION.md`, branch `t_bb61fcf8-quilcast-adopt`). That
  path registers a brand-new FID, which costs a registration fee the person
  pays, and the device holds the account's own recovery phrase.

They meet in exactly one place: the sign-in surface
(`src/components/modals/LoginModal.tsx`), where each is **its own block** — the
Farcaster sign-in handshake, the connect door, and (when it lands) the create
door. No block is presented as the only way in, and the connect door's own page
lives at `routes.fiddyConnect` (`/connect-farcaster`) so it can be linked,
reloaded and re-entered without touching the modal again. Nothing in this branch
renames, moves or deletes a create-account file, so the two landings do not
depend on each other's merge order.

## 6. The seam the plugin's first-run setup shares

The plugin's one-click setup (card `t_e79c416a`) needs the same thing this
branch builds — a signer for a Farcaster account, obtained with no passphrase and
no fee. There is **one implementation**, on the control plane, and both clients
call it:

```
POST   /api/fiddy/connect         start (or re-hand) the request → {approvalUrl, state}
GET    /api/fiddy/connect         what the connection is now → {state, fid, username}
DELETE /api/fiddy/connect         turn it off at the network → {state}
POST   /api/fiddy/connect/write   one write, made with the granted key
```

- A **browser** gets an HttpOnly cookie and never sees the signer identifier; it
  writes through `/write`.
- A **machine** (an operator's own setup, no `Origin` header) gets an opaque
  `handle` back once, and may read its own `signerUuid` from `GET` to store in
  its own secret store — which is exactly what the plugin's
  `FIDDY_FARCASTER_SIGNER_UUID` setting wants. The plugin then writes with
  Neynar directly, using the key it already has.

Creating a signer is the only operation that spends money, so it is rate-limited
per caller (8 per 10 minutes) and capped per day (`FIDDY_CONNECT_DAILY_CEILING`,
default 40).

## 7. What the write path does when a key was granted

`~/snapchain/nodeApi/nodeWrites.ts` carries every write in the app. It now has a
second carrier: if a granted posting key exists **for the signed-in FID**, the
write is handed to the service that holds it instead of being signed here.

- The read-back discipline is untouched: after the service says the network took
  it, the client still asks the *node* whether the account's own state shows it,
  and answers "accepted, but a node is not showing it yet" rather than "posted"
  when it does not. A provider's `200` is not evidence, here or anywhere else.
- A connection belongs to one account: it is used only when the connected `fid`
  is the signed-in `fid`, so one person's key is never used to write as another.
- When the service cannot be reached, `available()` answers **no** and the write
  falls back to this device's own key — so an unreachable service downgrades to
  the old path instead of failing the write.

## 8. What is still open

1. **The approval tap** — one person, in their own Farcaster app. The link is
   produced by the server on demand; nothing here can (or should) stand in.
2. **Deploying the server half.** The control plane (fiddy-auth on the VPS) needs
   `NEYNAR_API_KEY`, `FIDDY_CONNECT_APP_FID`, `FIDDY_CONNECT_APP_KEY` in
   `/etc/fiddy-auth/app.env`, an nginx location for `/api/fiddy/connect` (the
   vhost lists each `/api/fiddy/*` path explicitly), and the release deployed.
   All four are in place as of 2026-10-22 (see §4).
3. **A dedicated app account.** `@fiddy-one` works and is configured; a
   purpose-built app account (its own FID, its own key, its own name on the
   approval screen) is a nicer long-term answer and costs only two env values.
4. **The other write verbs for a granted key** are implemented (cast, reaction,
   follow/unfollow). The client now reaches them from the ordinary surfaces: a
   first cast, like, recast or follow with no key on the device is *held* while
   the approval sheet asks, and the granted key carries it once the person
   approves (`docs/CLIENT-INLINE-APPROVAL.md`). A live end-to-end write still
   needs an approved signer, which is (1).

## 9. A copy of Fiddy a person runs themselves (card `t_745ed5be`)

This whole document describes the service fiddy.fun runs. On an instance a person
runs themselves there is no control plane, so `/api/fiddy/connect` answered 404
at that address and the one-tap approval did not exist there. The same four
endpoints, with the same wire shape, are now answered by the **instance's own
server** (`apps/farcaster-web/server/instance/connect.mjs`, mounted by its vite
plugin in `dev` and `preview`), and every screen, poll and identity rule above is
the one that runs on it:

- **Who asks** is the instance's own Farcaster account
  (`FIDDY_INSTANCE_APP_FID` + `FIDDY_INSTANCE_APP_KEY`, its custody key, on that
  machine). It is the name the approval screen shows, the same way `@fiddy-one`
  is on fiddy.fun, and it is configuration rather than the person's key.
- **Where the granted key lives** differs by necessity: with no control plane to
  hold it, the instance hands the private half to the person's browser once the
  approval lands, and the client signs its own writes through the node it is
  already pointed at (`~/snapchain/nodeApi/nodeWrites` prefers a key this device
  holds). The identity rules are unchanged: an answer is adopted only when
  Farcaster's API and **that instance's own node** agree about which account it is,
  never for the instance's own account, and never for somebody else's request.
- **Signing in** on such an instance is the relay SIWF plus one added check: the
  instance's own node names the FID the signing address owns
  (`~/lib/siwfSession`, `confirmFidOnNode`), which is what makes the identity
  proven rather than merely relayed.
- **The recovery phrase** is not the price of any of this. It stays on the
  Advanced screen, for test accounts and developers, exactly as it does on
  fiddy.fun.

The design record for that half is `docs/CLIENT-SELF-HOSTED-CONNECT.md`; the
probe that pins it end to end (QR, round trip, key, a cast read back off the node)
is `apps/farcaster-web/scripts/verify-instance-connect.mjs`.