# Farcaster Agent Deploy — canonical procedure for every fiddy agent

Source rules from the owner's note (`lc/Fiddy/Fiddy Deploy Details.md` in Obsidian):
1. **Read nodes accept writes** and forward them to validators ([snapchain PR #1034](https://github.com/farcasterxyz/snapchain/pull/1034), [node-types docs](https://snapchain.farcaster.xyz/node-types#message-submission-and-the-mempool)).
2. **App keys are gasless** — no Optimism transaction for signers ([guide](https://snapchain.farcaster.xyz/guides/writing-messages), [snapchain PR #989](https://github.com/farcasterxyz/snapchain/pull/989)).
3. We do **not** run our own node (34.101.47.167 is off). Use a public node (`crackle.farcaster.xyz`) or Neynar.

## Deploy sequence (proven 2026-10-20 with fiddy-one, FID 3356372)

1. **Wallet**: generate with viem, **persist to `/etc/<agent>/app.env` (mode 600) BEFORE any onchain action**. Generation and persistence are one atomic step — a crash between keygen and persistence burns whatever the key controls.
2. **Fund**: ~$1.50 ETH bridged Base→Optimism via Relay (`POST https://api.relay.link/quote`, deposit contract `0x4cd00e387622c35bddb9b4c962c136462338bc31` — verify against Relay docs each time). Registration costs ~0.00008 ETH.
3. **FID**: `IdGateway.register(recovery, 0)` on Optimism (`0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69`). Verify with `IdRegistry.idOf(address)`. (FID transfers are frozen — never plan on moving an FID; get custody right the first time.)
4. **Signer (gasless)**: ed25519 keypair persisted to `/etc/<agent>/signer.key` first; `makeKeyAddBody` (hub-nodejs ≥0.17) with scopes (never KEY_ADD/KEY_REMOVE), TTL 90d sliding, nonce = `currentUserNonce + 1` from `GET /v1/signersByFid?fid=`; custody EIP-712 via `ViemLocalEip712Signer`; envelope signed by the new key.
5. **Submit messages**: `POST https://crackle.farcaster.xyz:3381/v1/submitMessage`, `Content-Type: application/octet-stream`, body = `Message.encode(msg).finish()`. JSON bodies are rejected. gRPC on :3383 is password-gated.
6. **fname**: `POST https://fnames.farcaster.xyz/transfers`, EIP-712 domain `Farcaster name verification` v1 with **chainId 1** (the docs' 10 is wrong), verifyingContract `0xe3be01d99baa8db9905b33a3ca391238234b79d1`. Wait ~1 min before submitting the `USERNAME` UserDataAdd — snapchain validates it against fname state.
7. **Profile + first cast**: `makeUserDataAdd` (DISPLAY, BIO, PFP, USERNAME) and `makeCastAdd`, same octet-stream submit path.

## Never again
- IdRegistry `transfer()` reverts (registry frozen post-Snapchain) — don't attempt FID rotation; if a custody key leaks, register a fresh FID and abandon the old one.
- Don't let a key exist only in process memory, ever.
- Cloudflare fronts poidh staging: send a browser-like User-Agent from non-browser clients (Error 1010 otherwise).
