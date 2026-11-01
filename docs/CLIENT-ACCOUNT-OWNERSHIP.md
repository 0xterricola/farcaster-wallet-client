# Who owns the Farcaster account when someone signs up with Google or X

A person presses "Continue with Google". They get a real account on this device —
an Ethereum wallet Privy created and holds for them — and no Farcaster account,
because posting on Farcaster needs one. This document is the decision about who
claims that Farcaster account, what a person sees while it happens, and what is
still unmeasured about it.

It exists because the first version of this screen offered "make a Farcaster
account here instead", and that route made **a second account**: a fresh recovery
phrase generated in the browser, its own custody key, and an FID registered to
that new wallet. The Google identity stayed owning nothing on Farcaster, and
posting meant being signed in as the second account. Two accounts on the device,
one of them a wallet with no number.

## The decision

**The FID is claimed by the account the person signed up with.** The held wallet
signs the registration itself, so the registrar mints the FID to that wallet, and
the account in this device's book gains its number in place — same id, same
email, one row in the switcher.

## Why that is the mechanism, stated against the contract

The registrar this client calls is the live `IdGateway`
(`0x00000000fc25870c6ed6b6c7e41fb078b7656f69` on Optimism), and its own source
(`farcasterxyz/contracts`, `src/IdGateway.sol`) settles the question:

```solidity
function register(address recovery, uint256 extraStorage) public payable ... {
    fid = idRegistry.register(msg.sender, recovery);   // the FID goes to the SENDER
}

function registerFor(address to, address recovery, uint256 deadline, bytes calldata sig, ...) {
    _verifyRegisterSig({ to, recovery, deadline, sig });  // `to`'s own EIP-712 signature
    fid = idRegistry.register(to, recovery);              // the FID goes to `to`
}
```

So with `register`, the address that signs and pays **is** the owner: signing the
registration from the held wallet is exactly what makes `IdRegistry.idOf(held
wallet)` the new FID — the same read this client already polls to learn an
account's number. `registerFor` is the other shape, and it is what a sponsored
registration would use (see "the next step", below).

One correction that came out of reading it: the `signer` parameter of
`registerFid` in `apps/farcaster-web/src/snapchain/accounts/optimism.ts` was
documented as letting "a different signer (a wallet, a sponsor) keep the account
in `custody`'s name". That is not what `register` does — a different payer would
become the owner. The comment now says so. Nothing passed a different signer, so
nothing was broken by it; it was a trap for the next reader.

## What each third party is asked for

The wallet's words live in the sign-up provider's own secure window, and that
window answers a deliberately small set of signing methods
(`SUPPORTED_ETHEREUM_RPC_METHODS` in `@privy-io/react-auth`, the version pinned
by this repo). Two of them are all this needs, and `~/lib/heldWallet` is the one
place that asks:

| what the account needs | how it is asked for | who still decides |
| --- | --- | --- |
| the registration transaction | `eth_signTransaction` — the **signed raw transaction**, not a hash | this client: it reads the price, caps the fee and the gas, picks the nonce, and broadcasts through its own configured Optimism endpoint |
| the gasless posting key (`KEY_ADD`) | `eth_signTypedData_v4` — the EIP-712 authorisation the node requires from the owner | this client: it builds the payload, stores the key for the FID, and reads the key back off the node before reporting the step done |
| the `@name` claim | the same `eth_signTypedData_v4` (the registry's `UserNameProof`) | this client: it asks the registry whether the name is free, then reads back the transfer |

A held wallet never needs to move money, and nothing in `~/lib/heldWallet` can:
every method is a signature. The registration is the only transaction, and it is
broadcast by the client, which is what keeps the existing guards in force (a
price or gas the provider's own RPC would happily fill is still refused here).

EIP-712 is the one place where the shapes do not line up: a locally held key
takes `{ domain, types, primaryType, message }` and works out the domain type
itself, while the RPC method wants the whole payload as JSON with `EIP712Domain`
described inside `types`. `~/lib/heldWallet` derives that domain type from the
domain actually present, in the standard field order — a field that is not there
is a field that does not belong in the hash.

### The defect the probe's own stage G found

`JSON.stringify` throws on a BigInt, and the message the node's gasless KEY_ADD
builds carries `fid` as one (`buildKeyAddMessage` in `farcaster-node-client`).
The first run of stage G therefore failed with "your Google sign-up would not
sign that" — a sentence about the provider — while the provider had never been
asked anything: the recorded calls held `eth_signTransaction` and no
`eth_signTypedData_v4` at all. `~/lib/heldWallet` now converts every BigInt to
the hex quantity a quantity takes over this RPC before serialising, which is the
shape every EIP-712 implementation on the other side accepts (eth-sig-util's
`numberToBN`, viem's encoder, ethers' `BigNumberish`) and hashes as the same
uint256 a locally held key would have hashed. Pinned by a unit test that signs
the KEY_ADD-shaped payload, not a tidied-up version of it.

## What a person sees

- **The account screen** leads with "Make this a Farcaster account" and keeps "I
  already have a Farcaster account — sign in with it" as the quiet route, because
  the leading action is the one that completes the account they just made.
- **The claim itself** reuses the account-creation screens minus the phrase step:
  pick a `@name`, then one funding screen, then progress, then done. There is
  nothing to write down, because the words are held for them.
- **The fee goes to their own address** — the account they signed up with, which
  is also the account that will own the number — rather than to a brand-new
  wallet. The address is read out of the book, not generated.
- **The confirmation is the provider's own window**, and the screen says so:
  "Google will ask you to approve the registration before it is sent."
- **Afterwards, the switcher's one row changes from "no posting key on this
  device yet" to "this device can post"** once the gasless key lands on the node.
- **If the account already has its number** (signed out, after a reload), the two
  routes collapse to one: sign in as it. Telling that person they have no
  Farcaster account would be false.

## The backup notice does not change

The notice keys on `account.id` (`~/lib/seedBackup`), which is the same account
before and after the number arrives, and the held words still own the account
(recovery is the held wallet). So its promise — "the words are being looked after
for you; take your own copy from the provider's window" — stays true, and the
stake it describes ("one bad day is not the end of the account") is now a
Farcaster account rather than an empty wallet. No new promise, and nothing to
reword: what changed is what is at stake, not who holds it.

## What is NOT measured yet, and the owner's part

- **The doors are inert in every release.** No published build sets
  `VITE_PRIVY_APP_ID`, so this path is code nobody can reach yet. The probe
  (`apps/farcaster-web/scripts/verify-social-signup.mjs`, stage G) measures the
  app's own behaviour with the third parties stubbed — the sign-up window, the
  registrar, the read node and the name registry — so what is proven is this
  client's logic and its honesty, not Privy's real signature.
- **Owner action, before this can be trusted live:** turn the doors on (Privy
  dashboard → login methods and `https://fiddy.fun` as an origin; see
  `docs/CLIENT-RELEASE.md`), and while there confirm that **Optimism (chain 10)
  is enabled for the embedded wallet**, since a provider-signed transaction names
  its own chain.
- **Then the first live run is the real test** of the two provider methods. If
  either is refused, the screens say so in place ("your Google sign-up would not
  sign that") and no account is created half-done; the FID exists only if the
  registration was accepted.

## The next step that removes the funding hurdle

The fee (~$0.20 of ETH on Optimism) has to be in the held wallet, which is why
the flow still asks a person to send money to an address — the same hurdle the
device-made-account flow has always had, now at their own address instead of a
throwaway one. Removing it means Fiddy pays:

1. the held wallet signs the EIP-712 `Register(to, recovery, nonce, deadline)`
   (a signature, no gas, through the same window);
2. a funded Fiddy address calls `IdGateway.registerFor(to, recovery, deadline,
   sig, extraStorage)`, so the FID is still minted **to the person's wallet**;
3. the client keeps its own submission path and reads the same `idOf` back.

What it costs: a sponsor key with real ETH on Optimism, a relay on the control
plane to send for people (a browser cannot hold that key), and a rate limit that
survives being found by someone who wants free registrations. That is an owner
decision about money and abuse, not a client change, which is why it is written
down here instead of being half-built.

## How to verify

```sh
# unit: the mapping to the provider's two methods, and the record kept afterwards
cd apps/farcaster-web
./node_modules/.bin/vitest run src/lib/__tests__/heldWallet.test.ts \
  src/components/fiddy/accounts/__tests__/createAccountSheetHeld.test.tsx

# end to end: the app's own acceptance probe, stage G (three dev servers; the
# recipe is in the probe's own header)
SOCIAL_SIGNUP_SERVER=https://localhost:5188 \
SOCIAL_SIGNUP_PLAIN_SERVER=https://localhost:5189 \
SOCIAL_SIGNUP_CLAIM_SERVER=https://localhost:5190 \
  node scripts/verify-social-signup.mjs
```

Stage G asserts, at 390px and 1440px: the account screen leads with the claim;
the fee is asked for at the held address with no words to write down; the
registration is signed by the sign-up's own window and broadcast once, by the
app; the posting key is authorised by that same window; the device ends with
**one** account carrying the minted FID, still named by its email; and the
switcher's single row says this device can post.