# Fiddy — Farcaster Client + Read Node + 3-Command Tutorial (Bounty Spec)

## Problem Statement

Farcaster's documentation for standing up a read node and building a client is scattered across doc sites, some of it stale (it still describes onchain signer registration and claims read nodes reject writes). A developer who wants practical freedom of association — their own client on their own node, no third-party API keys — faces days of piecing together contracts, Snapchain, signers, and storage rent. Fiddy (fiddy.fun) wants to be the client that proves how easy this can be, and win the $2,048 bounty by getting it down to three commands.

## Solution

Ship three things as one coherent product:

1. **The Fiddy client** — a fork of `0xterricola/farcaster-wallet-client` (itself a fork of the Farcaster client snapshot with external wallet support), rebranded with the Fiddy identity (chartreuse / #161715, Solid Glass + Awwwards-grade UI), reading from the user's own Snapchain read node and writing through it (read nodes gossip valid messages to validators — no API keys, no Neynar, no Alchemy).
2. **One-click node deploy** — an agent-on-cloud service: the user furnishes compute (any VPS; AWS path scripted first, ~$100/mo), Fiddy provisions and boots a Snapchain read node, then points the client at it.
3. **The tutorial microsite** — quickstart at the top (three commands), then a mobile- and desktop-friendly tutorial that teaches protocol concepts as it goes: FIDs, custody addresses, app keys (gasless `KEY_ADD`), Snapchain messages, read nodes vs validators and the mempool path, storage rent, seed-phrase safety.
4. **The Fiddy Agent (the differentiator)** — every client user can hatch their own autonomous Hermes agent, hosted on Agent37 cloud, living inside the client. Not a chatbot bolt-on: a real Hermes instance with its full feature set — scheduled tasks (cron), skills, memory, and every messaging channel Hermes supports (Farcaster first, then iMessage, Discord, Telegram, WhatsApp, email, web/API) — with owner approval on every channel connection. No other Farcaster client ships an agent that works for you 24/7 across your whole communication surface.

Submission: reply to the bounty cast with (1) microsite URL, (2) github.com/ivcained/fiddy (MIT), (3) a voucher's public Farcaster endorsement. Cast: https://farcaster.xyz/balajis.eth/0x50184b62, posted 2026-10-17T14:47:30Z → hard deadline 2026-10-24T14:47:30Z (verified; see `docs/BOUNTY-DEADLINE.md`; the earlier "~2026-10-25" estimate and the 10X Chris attribution were both wrong).

## User Stories

### Quickstart & tutorial
1. As a developer, I want a quickstart at the very top of the page with exactly three commands, so that I know the whole shape of the task before reading anything.
2. As a developer, I want command (0) to provision compute via script, so that I don't click through a cloud console.
3. As a developer, I want command (1) to set up a Snapchain read node on that compute, so that it syncs the network with no API keys from anyone.
4. As a developer, I want command (2) to create a client that reads from my node, so that I see my own infra serving real Farcaster data.
5. As a developer, I want the tutorial to explain FIDs, custody addresses, app keys, Snapchain messages, read nodes vs validators, and storage rent inline as I encounter them, so that I learn the protocol instead of cargo-culting commands.
6. As a developer, I want the tutorial to explain that read nodes accept `submitMessage` and gossip to validators (no mempool of their own), and that a successful response means "accepted for relay, not in a block" — so that I confirm inclusion via `MERGE_MESSAGE` events or query-back instead of assuming.
7. As a developer, I want the tutorial to work on my phone and my desktop, so that I can follow along from either.
8. As a developer evaluating the tutorial, I want prominent seed-phrase safety guidance — use a test account only, never paste a seed into software from devs you don't trust, prefer delegated signer authorization — so that I don't burn a real account.
9. As a non-English speaker, I want at least a Chinese translation, so that I can follow the tutorial (extra-mile).
10. As a skimmer, I want a ~59s vertical video showing the three commands running, so that I believe it's real before investing an hour (extra-mile).

### Client
11. As a user, I want to import an existing seed phrase for an account that already has storage, so that I don't pay for a new FID.
12. As a user, I want the client to issue itself its own app key via gasless `KEY_ADD` (EIP-712 from my custody address, no Optimism transaction, no ETH), so that posting works in seconds.
13. As a user, I want to read my feed from my own read node, so that no third party mediates my reads.
14. As a user, I want to post casts, follow, and react, so that the client is genuinely usable.
15. As a user, I want to include/exclude casts from any other client, so that I control my experience.
16. As a user, I want external wallet support (WalletConnect EVM + Solana, EIP-6963 discovery, MetaMask Connect) — inherited from the upstream fork — so that I keep control of my keys.
17. As a user, I want the Fiddy brand (chartreuse on #161715, glass surfaces, award-level polish) so that the client feels like Fiddy, not a reskin of Warpcast.
18. As a user, I want one-click deploy of my own read node to cloud as a service, so that the client is self-sufficient without me babysitting a server.
19. As a user, I want the app-key scopes and 90-day sliding TTL explained at the moment I create one, so that I understand what the client can and cannot do in my name.
20. As a user, I want to revoke the client's app key (`KEY_REMOVE`) from the UI, so that I can cut access without onchain transactions.

### Fiddy Agent (Hermes on Agent37)
21. As a user, I want to hatch my own Fiddy agent from inside the client — one click provisions a dedicated Hermes instance on Agent37 cloud — so that I have an autonomous agent without touching a server.
22. As a user, I want to chat with my agent inside the client, so that it feels native, not like a separate app.
23. As a user, I want to schedule tasks for my agent (cron-style: "check my mentions every morning", "draft a weekly recap cast"), so that it works while I sleep.
24. As a user, I want to connect my agent to iMessage, Discord, Telegram, WhatsApp, email, and web/API — every channel Hermes supports — with an explicit approval step per channel, so that my agent meets people where they are and I stay in control.
25. As a user, I want my agent to act on Farcaster under its own identity (its own FID + gasless app key), so that its casts, replies, and follows are clearly the agent's, with me able to revoke its key at any time.
26. As a user, I want the agent's capabilities presented honestly as Hermes' full feature set — skills, memory, tools, scheduling — so that the offering is "a real Hermes instance that is yours," not a wrapped chatbot.
27. As a user, I want my agent to grow with me — persona drafted from my casts, memory persisted across sessions — so that it becomes more useful over time.
28. As the maintainer, I want the agent to dogfood the client's own read node, so that the agent proves the infra story end to end.

### Bounty operations
29. As the maintainer, I want the repo MIT-licensed with all code open, so that the entry qualifies.
30. As the maintainer, I want at least one human to complete the tutorial and publicly vouch on Farcaster, so that the entry qualifies — and more vouches as the strongest signal.
31. As the maintainer, I want stale upstream docs fixed via PRs to farcasterxyz repos when found (hand-written, not AI slop), so that the entry stands out and other devs benefit.
32. As the maintainer, I want fiddy.fun and the LC gateway VPS synced with the client work, so that the tutorial microsite and one-click deploy land on existing infra.

## Implementation Decisions

- **Repo**: `github.com/ivcained/fiddy`, forked from `0xterricola/farcaster-wallet-client` (done). MIT license retained. Upstream remote kept for snapshot review before merges.
- **Monorepo layout (inherited)**: `apps/farcaster-web` (Vite web client — primary target), `apps/farcaster-mobile`, `apps/farcaster-ssr`, plus shared packages (`farcaster-client-hooks`, `farcaster-client-data`, `farcaster-cryptography*`). pnpm 10.8.1, Node 20.19.5, turbo.
- **Node target**: Snapchain read node (`read_node = true`) via `snapchain-bootstrap.sh` in Docker. Default cloud path: AWS EC2 per official guide (~$100/mo); the provision script must be provider-pluggable so any VPS works (LC gateway VPS is the dogfood target).
- **Three-command contract**:
  - (0) `fiddy provision` — script provisions compute (cloud-init / user-data carrying Docker).
  - (1) `fiddy node up` — installs Docker + Snapchain read node, waits for sync health, prints the node's HTTP/gRPC endpoints.
  - (2) `fiddy client up` — boots the client configured with `SNAPCHAIN_HTTP_URL` pointing at the user's node.
  - These wrap the official bootstrap; we do not reimplement Snapchain.
- **Writes**: client submits to its own read node's `POST /v1/submitMessage`; the tutorial teaches the gossip path, the lack of read-node mempool, and `MERGE_MESSAGE`/query-back confirmation. Under load the client offers "submit to a validator endpoint" as a fallback toggle, with the trade-off explained.
- **App keys**: gasless signers only — `makeKeyAddBody`/`makeKeyAdd` + `getGaslessSignedKeyRequestMetadata` from `@farcaster/hub-nodejs` (pin a version that exports them; the upstream PR notes some published versions lack them). Never the onchain key gateway for new keys. Scopes minimal (casts, reactions, links, user data); per-fid nonce strictly increasing; 1000-key cap noted.
- **Seed phrase import**: BIP-39 import of an existing custody address, with a blocking test-account warning screen. Custody key never leaves the client; it signs exactly two things: the EIP-712 `KEY_ADD` authorization and (optionally) fname transfers. All day-to-day signing is the app key.
- **Client filtering (include/exclude casts from other clients)**: filter on the cast's `client` metadata where available / signer-known-client mapping, as a view-layer preference — never a protocol-level claim.
- **One-click deploy service**: an agent (Hermes, on the LC gateway VPS) that accepts cloud credentials or an SSH target, runs the same provision + node scripts, and reports health back to the client UI. Self-hosted by default; no custody of user keys server-side.
- **Fiddy Agent backend**: Agent37 cloud API (`api.agent37.com/v1/instances`) provisions one dedicated Hermes instance per user. The client talks to the instance over the Hermes gateway API (`/v1` chat + profile multiplexing). Channel connections (iMessage/Discord/Telegram/WhatsApp/email) are initiated from the client UI but completed on the instance side, each behind an explicit owner-approval screen — matching the existing fiddy.fun "with your approval on every channel" promise. The agent's Farcaster identity is its own FID with a gasless app key; the owner can revoke it from the client (same `KEY_REMOVE` surface as the client's own app key). Scheduling maps to the instance's cron system; the client exposes a plain-English scheduler UI that writes cron entries. Agent37 keys live server-side only (pattern from `AGENT37-SETUP.md`: hidden prompt, stdin handoff, mode-0600 `.env.local`, status-only checks).
- **Microsite**: static site in `apps/docs-site` (or `site/`), deployed on the LC VPS (fiddy.fun infra, e.g. `client.fiddy.fun` or `fiddy.fun/client`). Quickstart hero on top; tutorial pages beneath; i18n scaffold with zh as first translation.
- **Design**: Solid Glass skill theme tokens + Awwwards skill bar; Fiddy brand assets from `/Users/lc/legitmate-farcaster` (chartreuse, #161715, mascot). Mobile-first CSS verified with the project's existing Playwright mobile config pattern.
- **fiddy.fun sync**: the microsite and deploy agent live on the existing LC gateway VPS alongside the current Fiddy app; the existing Farcaster manifest work (fiddy.fun domain manifest) is untouched by this spec.

## Testing Decisions

- Test external behavior only: node health/sync endpoints respond; `submitMessage` returns success and the cast is queryable back from the node (the real `MERGE_MESSAGE` confirmation path); gasless `KEY_ADD` is accepted and appears in `GET /v1/signersByFid`; client renders feed from the local node with third-party APIs disabled (offline-Neynar test).
- Seam: the node HTTP/gRPC API is the single highest seam — the client never imports node internals. UI tests sit behind the client-data hooks package seam (existing pattern in the monorepo).
- Prior art: the fork's existing package tests and the hello-world example scripts in `farcasterxyz/hub-monorepo`.
- The three commands themselves get an end-to-end smoke script run on a fresh VPS before submission — this is the bounty judge's exact path.
- A human voucher run-through is a launch gate, not an afterthought: recruit early, fix what they trip on.

## Out of Scope

- Running a validator (requires validator-set keys; read node only).
- Onchain account creation / storage purchase flows beyond importing an existing provisioned account (tutorial links out for that).
- Farcaster Mini App / manifest work for fiddy.fun apex (separate pending item).
- Mobile native client polish — web-first; the inherited mobile app stays buildable but is not a bounty deliverable.
- Any custodial handling of user seed phrases server-side. Never.

## Further Notes

- Bounty corrections already incorporated: (1) read nodes DO accept writes and gossip them (snapchain PR #1034); (2) app keys are gasless `KEY_ADD` since mainnet V16 (PR #989) — no Optimism transaction; (3) seed-phrase hygiene is a first-class tutorial section, Unix-`rm` style: powerful, dangerous, test-account-only.
- Known upstream doc gaps worth PR-ing if confirmed while building: the `hello-world` example repo still registers signers onchain; no HTTP API reference page for `/v1/signer` or `/v1/signersByFid`; the step-3/5 snippet variable mismatch (`signer` vs `signerPrivateKey`) flagged by Copilot on PR #989.
- Extra-mile items ranked by signal: more human vouches > Chinese translation > 59s vertical video > anything else.
- Prize: $2,048 / $512 / $128 honorable mentions, USDC to the public Farcaster wallet. Entry = reply cast with microsite URL + repo URL + voucher endorsement URL, within 7 days of the bounty post.
