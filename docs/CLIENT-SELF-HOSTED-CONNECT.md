# Signing in on a copy of Fiddy you run yourself: a QR, a phone, and no phrase

Status: **implemented on branch `t_745ed5be-connect-qr`** (client). This file is
the design record: what a person sees, where every credential lives, what the
protocol does and does not allow, what was measured, and what is still a
decision rather than a bug.

Everything marked MEASURED was read off a real request, a real signature, or the
committed source. Anything not measured says so.

---

## 1. The problem this closes

On fiddy.fun, connecting an account is one tap: Fiddy's control plane asks
Farcaster for a posting key, the person approves it in their own app, and the
client writes as them. **A copy of Fiddy a person runs themselves has no control
plane**, so `/api/fiddy/connect` answered 404 there — the one-tap approval did
not exist at that address, and pressing Cast walked the person to Advanced, whose
only key path wanted their recovery phrase (card t_b4f0752a, which routed that
case away from a dead button; this is what it routes *to*).

Nobody should ever be asked for a recovery phrase to sign in. So on a
self-hosted instance:

- **Signing in** is the QR (`~/components/login/LoginWithMobile`): the Farcaster
  app on the phone signs a message, and the instance's **own node** names the FID
  that signature belongs to (§3).
- **Getting a posting key** is the same QR sheet with a second, protocol-level
  request (**§4**): `ConnectSheet` asks this instance's own service, the person
  approves in their app, and the client ends up able to post.
- **The phrase path stays where it belongs**: Advanced, for test accounts and
  developers. It is not a gate anywhere.

## 2. Where the credentials live

| thing | where | why there |
| --- | --- | --- |
| the instance's own Farcaster account (`FIDDY_INSTANCE_APP_FID` + `FIDDY_INSTANCE_APP_KEY`) | the machine running the instance, in its environment | it is what *asks* for a key on the person's behalf, and Farcaster's API checks the request signature against that FID's custody address. It is configuration, like a server's own identity — never the person's key (and optional: see §6) |
| the signature the project lends when the instance has no account of its own | over the wire from `FIDDY_SIGNER_REQUEST_URL` (default `https://fiddy.fun/api/fiddy/signer-request`) | the protocol needs an account to ask with and a self-hoster usually has none: the reply is a signature over the key **this instance minted**, plus the FID of whoever lent it. Nothing else crosses; no key, no token, no state |
| the posting key this approval produces | minted by the instance's server, handed to the person's browser, stored where every other device key is (`~/snapchain/appKeyStorage`) | the client signs its own writes through the node it is already pointed at: one code path (the one Advanced uses), and it keeps working when the service restarts |
| the person's account, custody key, recovery phrase | their Farcaster app, untouched | the point of the whole design. No phrase is requested, stored or asked for anywhere in this flow |
| the caller's handle | an **HttpOnly** cookie on the instance's own origin | the same shape fiddy.fun uses; no script can read it |

The instance's server keeps a record per caller (`~/.fiddy-instance/connect.json`,
mode 0600, `FIDDY_INSTANCE_STATE_DIR` overrides) so a dev-server restart does not
force the person to approve again.

## 3. The sign-in: the relay carries, the node decides (fatline's step 4)

MEASURED and unchanged: the phone app implements SIWF against
`https://relay.farcaster.xyz`, and the client verifies the SIWE message locally
(domain, nonce, signature recovery). What the relay does **not** prove is which
FID the signing address owns — it only carries messages
(`~/lib/siwfSession`'s own note).

So `confirmFidOnNode` asks the server this copy of Fiddy reads from:

```
GET <node>/v1/onChainIdRegistryEventByAddress?address=0x…
→ { fid, idRegisterEventBody: { to } }     // the address must BE `to`, and name this fid
```

Three answers, all used as they are (`~/lib/siwfSession`):

- **confirmed** — the instance's node names this FID for this address. The screen
  says so ("Confirmed by your own setup"), and this is the only case where the
  identity is presented as proven.
- **mismatch** — the node names a *different* FID for that signature. The sign-in
  is refused, in place, with both numbers named.
- **none/unavailable** — the address owns no account that node knows, or the node
  could not answer. The session stays the device-only one it always was, and the
  screen says which of the two happened. It never claims more than it has.

Clean-room: the lookup and the rule ("the event's `to` must equal the address")
are ported from `jpfraneto/fatline`'s `indexer/src/identity.mjs` (`fidOfCustody`),
MIT, without its code.

## 4. The posting key: what the protocol allows, and what it does not

MEASURED (Farcaster's own reference implementation and this repo's protocol
client), and the reason this feature has the shape it has:

1. A **gasless KEY_ADD** (`KeyAddBody`) requires an EIP-712 `KeyAdd` signature
   from **the account's own custody address** — the key that lives in the
   person's Farcaster app. A SIWF signature is over a different message and
   cannot be reused for it.
2. Adding a signer **without** that signature means asking the phone to do it:
   Farcaster's client API (`POST /v2/signed-key-requests`) takes a key plus an
   EIP-712 `SignedKeyRequest` signature **from the requesting application's FID**,
   answers a deeplink the Farcaster app opens, and performs the on-chain addition
   when the person approves there. That is the flow the hosted service uses
   through Neynar, and it is the only phone-driven way to end up with a key.
3. Therefore an instance needs **an account of its own** to ask with. There is no
   zero-configuration variant; not having one is a configuration state, and it is
   reported as one (§6).

WHO SIGNS THE REQUEST does not change what the request is (see §6): the instance's
own account if it has one, otherwise the project's signer, which signs a
`SignedKeyRequest` over the key *this* instance minted and returns the signature.
Either way Farcaster receives the same three fields, and either way the key is
minted here and delivered to the browser below.

On fiddy.fun the key never leaves the service. **On a self-hosted instance the
key is handed to the browser** — deliberately, and the trade is written down
where it happens (`server/instance/connect.mjs`, `statusBody`): it is signed
locally, through the node the client already uses, with no second implementation
of the protocol inside a dev server; it can cast, react and follow for one FID;
and it is delivered only to a caller holding the HttpOnly handle cookie.

## 5. What was measured, and what is scripted

**Measured, in the repo's own gates:**

- the request signature is a real EIP-712 `SignedKeyRequest` by the instance's
  account over the exact `{requestFid, key, deadline}` Farcaster receives —
  verified by recovery (`src/__tests__/instanceConnect.test.ts`);
- the minted key is the one Farcaster is asked about: the public half is derived
  back out of the private hex **with the same library the browser signs with**,
  and compared;
- the node is the thing that decides identity and completion: the service says
  `connected` only when both Farcaster's API and the instance's node agree, never
  for another account, and never for the instance's own account;
- a proven sign-in is required to bind a request to an account, and a proof
  signed for another host, another FID, or with tampered bytes is refused;
- **the real network, measured once (2026-10-24):** an instance with no account of
  its own asked `https://fiddy.fun/api/fiddy/signer-request` and got a signature
  that recovers (`recoverTypedDataAddress`) to `0x029d612ECF1454bF507e6D7f3602649716FE8bf4`,
  which a real node (`haatz.quilibrium.com`) reports as owning FID 3356372 — the
  app account that asked. Farcaster's API accepted the same three fields and
  answered a real deeplink and token (`pending`), and the instance service, driven
  with the config a self-hosted instance has by default, answered `200 waiting`
  with that deeplink and **no key**. What is left is one person's tap;
- `verify-instance-connect.mjs` drives the whole flow through the **real client**
  in a browser: the QR sheet appears on a copy of Fiddy run locally, the approval
  completes with no second press, the sheet names the account the node names, the
  waiting cast is submitted to the node signed by the key the approval produced
  (checked in the message's own bytes), and the client reads it back before
  calling it posted. Only the phone, Farcaster's API and the node are scripted.

**Not measurable by a worker, and therefore stated rather than implied:**

- the approval tap itself: a person, in their own Farcaster app, on their phone.
  The probe stands in for it (the scripted API flips to `completed`), which is
  the scripted equivalent the card asked for;
- a real on-chain addition, and a real cast on a real FID: that needs a real
  account's approval, and this repo's rule is that a probe never posts to
  mainnet.

## 6. Who asks: nothing to configure, or an account of your own

**The approval works with nothing set up.** The protocol needs somebody to sign
the request, and a self-hoster usually has no spare Farcaster account, so an
instance with no account of its own asks the project's signer
(`https://fiddy.fun/api/fiddy/signer-request`; the control plane's
`docs/fiddy/SIGNER-REQUEST.md`) for a signature over the key **it** minted. The
key stays on this machine, the approval is unchanged, and the only difference is
whose name the phone shows. Farcaster's API pays for the on-chain addition, the
signature is bounded per caller and per day, and nothing else crosses the wire.

To ask with an account of your own instead (nothing else about the flow changes):

```
FIDDY_INSTANCE_APP_FID=3356372
FIDDY_INSTANCE_APP_KEY=0x…            # that FID's custody key, or its twelve words
```

...or to refuse to ask anybody at all (no account of your own, no project
signer), set `FIDDY_SIGNER_REQUEST_URL=` to an empty value, which is a deliberate
refusal rather than an unset one. Then pressing Connect answers, in one sentence,
exactly what is missing and how to set it (`CONNECT_UNAVAILABLE`, 501 → the
sheet's own fallback, which still walks the reader to Advanced).

`fiddy client up` needs no change: the dev server (and `--build`'s preview
server) mounts the service on the same origin as the client. When the project's
signer cannot be reached or refuses, the sheet says which of the two it was and
names both ways forward (`CONNECT_UNREACHABLE`, `CONNECT_SIGNER_REFUSED`) rather
than leaving a dead button.

**Decided (this was an open question).** Whose FID a self-hosted instance asks
with: the instance's own if it has one, the project's signer otherwise. A reader
following the tutorial gets a working approval with no setup, and an operator who
wants their own account's name on the approval sets two values.