# Fiddy — your own Farcaster client, on your own node, in three commands

Fiddy is a forkable Farcaster client with external wallet support that is built
to read and write through **your own Snapchain read node** — no API keys, no
Neynar, no Alchemy. You furnish the compute; the node syncs the network.

> **Read this before you vouch for the node half.** The node side is real and
> verified end to end (a mainnet read node installs over SSH, joins the gossip
> mesh and starts the snapshot bootstrap). The client's *reads* do not come from
> your node yet: the web client's data layer still calls Farcaster's hosted API,
> and `fiddy client up` says so when it runs. The node-backed data layer
> (`packages/farcaster-node-client`) exists but is not wired into the app.
> Details, evidence and the path to close it: [docs/CLIENT-NODE-GAP.md](docs/CLIENT-NODE-GAP.md)
> and [docs/RUN-REPORT-2026-10-18.md](docs/RUN-REPORT-2026-10-18.md).

Full tutorial (mobile + desktop, protocol concepts explained as you go):
**https://fiddy.fun/client** — or open `site/index.html` locally.

中文版：教程 **https://fiddy.fun/client/zh**，README 关键章节（安装 / 跑读节点 / 跑客户端 /
常见问题）见 [`README.zh-CN.md`](./README.zh-CN.md)。

## Quickstart

Two ways in — pick the one that matches where you're sitting:

**Way 1 · from your own terminal** (Mac/Windows/Linux; the CLI drives the server over SSH):

```bash
# create the machine — one click (https://fiddy.fun/client/deploy/) or:
curl -fsSL https://raw.githubusercontent.com/ivcained/fiddy/main/scripts/aws-deploy.sh | bash   # AWS, ~$285/mo
# install fiddy + Herdr/Ovis console on this computer (no local 2 TB node):
curl -fsSL https://fiddy.fun/client/install.sh | bash
fiddy provision --ssh ubuntu@<ip>     # register the box (or: --aws / --gcp / --hetzner / --ovh)
fiddy node up                         # (1) Snapchain read node on it — installs, then bootstraps
fiddy client up                       # (2) the Fiddy client, tunneled to your node
herdr                                 # or: node buttons + built-in Grafana in Ovis
```

**Way 2 · inside the VPS terminal** (you already made a server and SSH'd in — skip provision):

```bash
curl -fsSL https://fiddy.fun/client/install.sh | bash   # clone + PATH + console + node, one line
fiddy client up --tunnel                                # then, when the node answers
```

Hand the whole thing to an agent instead: `Help me run my own Farcaster node and client: https://fiddy.fun/client/skill.md` (that file is written for agents). Full tutorial: **https://fiddy.fun/client** (mobile + desktop, EN + 中文).

Other everyday commands: `fiddy doctor` (machine + network check with the fix spelled out), `fiddy node status` / `verify` / `dashboard` / `logs`, `fiddy node autoupgrade on [--every weekly|daily|hourly]` (off by default — the upstream job prunes the whole Docker host), `fiddy up` (doctor → node → client, one shot).

**Buttons instead of commands:** the same installer adds Herdr + Ovis and the
`plugins/fiddy-console` plugin. Open Ovis's command palette
(Cmd/Ctrl+Shift+K), type `Fiddy`, and use the native buttons for live status,
sync, logs, start/stop, operator FID, settings, and upgrades. The Grafana button
opens the node's real dashboard through a token-gated loopback proxy and SSH
tunnel; Shift-click its link to embed Grafana beside the terminal. Node controls
and Grafana need no AI key. The optional Surp agent/key flow is not part of this
release.

**Two networks, same idea, and you pick** (`--network snapchain|hypersnap`,
Snapchain by default). Both carry the same kind of social data and do not talk to
each other: **Snapchain** is Farcaster's own network — the one every account,
cast and follow lives on; pick this. **Hypersnap** is an independent parallel
network built by the Quilibrium community — same kind of social data, different
plumbing and different economics; it's for explorers, not where your Farcaster
account lives.

```bash
fiddy node up --network snapchain     # default: a read node on your compute
fiddy client up --network hypersnap   # read the public Hypersnap node — no node, nothing of yours runs
```

Reading Hypersnap needs no node at all. Running your *own* Hypersnap node is not
offered yet: upstream's install works but its copy of the list of who may decide
blocks is out of date, so a fresh node stops following the network while still
reporting itself healthy. `fiddy node up --network hypersnap` prints what is
known, with the upstream issue and the repair, and stops instead of installing
one. Details, with every measurement:
[docs/NETWORK-CHOICE.md](docs/NETWORK-CHOICE.md).

**Size your machine for the job.** A mainnet read node needs 4 vCPU, 16 GB RAM
and **2 TB** of disk: its snapshot bootstrap alone pulls ~468 GB of gzipped
chunks and needs ~1.66 TB peak to unpack them (`fiddy provision --aws` creates
a 2048 GB volume for this reason; `--ssh` targets are checked and refused below
the minimum unless you pass `--force`). Measured numbers, ports and failure
modes: [docs/NODE-REQUIREMENTS.md](docs/NODE-REQUIREMENTS.md).

A fresh node **does not serve its HTTP API until the snapshot load finishes** —
`fiddy node up` reports bootstrap progress and hands off to `fiddy node status`
rather than waiting for hours.

Run `bin/fiddy` directly (`bash bin/fiddy …`) or put it on your `PATH` — with
bash, not `sh` (macOS's stock `/bin/bash` 3.2 is supported).
`fiddy doctor` checks your local prerequisites; `fiddy node verify` runs the
acceptance checks against your node (`/v1/info`, reads, `/v1/signersByFid`);
`fiddy client check` reports where the client's reads actually go;
`fiddy client up --tunnel` is the default because node APIs should not be public.
The client names the network it is reading — a node does not announce one, so
whoever pointed the client at a node records it — and lets a reader switch
between the networks it can actually read, in **Advanced → your node**.

**Posting is gasless, and asking is a QR code.** On a copy you run yourself,
*Sign in* (or your first cast) shows a code: scan it with the Farcaster app,
approve there, and **your own node** confirms which account signed. The client
ends up with its own ed25519 app key, registered by a gasless `KEY_ADD` message:
no ETH, no Optimism transaction, live in about a second. The account that *asks*
on the instance's behalf is Fiddy's own signer, so this works with nothing
configured; export `FIDDY_INSTANCE_APP_FID` and `FIDDY_INSTANCE_APP_KEY` (a spare
account of yours) to have your instance ask with its own instead.
Test accounts and developers can still import a recovery phrase from the
**Advanced** screen: the seed never leaves your browser, and it only ever
authorizes the app key. See
[docs/CLIENT-SELF-HOSTED-CONNECT.md](docs/CLIENT-SELF-HOSTED-CONNECT.md), and read
[the seed-phrase safety section](https://fiddy.fun/client#safety) before
importing anything.

## What you get

- **Your own read node** — a Snapchain `read_node = true` install on your
  compute, joining gossip and serving the HTTP + gRPC APIs (`fiddy node verify`
  exercises them). Reads are served by the node's Hubble-compatible `/v1/*` API;
  wiring the client's UI onto that API is the one piece still outstanding
  ([docs/CLIENT-NODE-GAP.md](docs/CLIENT-NODE-GAP.md)).
- **External wallets, non-custodial** — WalletConnect (EVM + Solana),
  EIP-6963 discovery, optional unified MetaMask Connect. No seed phrase is
  created, requested, or stored by the client beyond the Advanced import above.
- **The Fiddy Agent (optional)** — one click hatches your own Hermes agent on
  Agent37 cloud that lives in the client and can connect to every channel
  you approve.

---

# Farcaster Wallet Client (upstream)

A fork of the [Farcaster client snapshot](https://github.com/farcasterxyz/client)
that adds a non-custodial wallet experience to the web client.

The original snapshot intentionally excludes the Farcaster Wallet
implementation. This fork fills that gap with external wallets: users keep
control of their keys and approve every connection, signature, and transaction
in their own wallet.

## Wallet features

- WalletConnect support for EVM and Solana QR, mobile, browser, and
  wallet-directory flows
- Optional Unified MetaMask mode that connects EVM and Solana atomically
  through MetaMask Connect
- Automatic discovery of modern EIP-6963 browser wallets
- Persistent EVM and Solana connections shared by the dashboard and Farcaster
  miniapps
- EIP-1193 EVM and Farcaster Solana provider support for miniapp connections,
  signatures, and transactions
- Connected address, native balance, and token portfolio on eight EVM networks
- Receive address with QR code and copy action
- Native-asset and ERC-20 sending with live balance checks
- Same-chain swaps between native assets and arbitrary ERC-20 contracts
- Quote, route, minimum received, allowance, approval, and transaction handling
- Chain-aware token embeds that open Trade with the selected token prefilled
- Five-item network activity page with transaction and explorer links
- Explicit disconnect and reconnect flow
- Independent Solana wallet support through Wallet Standard discovery and
  WalletConnect: SOL and SPL/Token-2022 portfolio, receive, send, same-chain
  swaps, and a five-item activity feed classified from real on-chain data.
  Solana connects, restores, and disconnects without affecting the EVM wallet

## How it works

The web client uses Wagmi for EVM connection state and Wallet Standard for
Solana connection state, then exposes each selected external wallet through the
client's wallet contexts. Miniapps and the corresponding EVM or Solana
dashboard flows consume the same provider and address. A Solana miniapp can
connect, sign messages, sign transactions, and sign and submit transactions
through the selected external Solana wallet.

WalletConnect is the universal fallback for both wallet families. EVM and
Solana WalletConnect sessions use isolated storage and remain independent, so
both can stay connected at the same time. A remembered Solana WalletConnect
session restores silently after refresh without opening a new pairing prompt.
Compatible EVM browser extensions are discovered through EIP-6963, while
compatible Solana extensions are discovered through Wallet Standard. No seed
phrase or private key is created, requested, or stored by this client.

Unified MetaMask is an alternative to those independent connections. It asks
MetaMask Connect for the supported EVM networks and Solana Mainnet together,
then exposes the resulting EVM provider and Solana Wallet Standard signer
through the same dashboard and miniapp pipes. The connection is atomic: both
an EVM address and a Solana address must be available and the Solana signer
must be ready before either side is published. An incomplete attempt is
disconnected instead of leaving a hidden partial wallet. Unified and
independent modes are mutually exclusive, while independent EVM and Solana
wallets may still coexist with each other.

Swap quotes and transaction requests come from the public LI.FI quote API.
The connected wallet remains responsible for approvals and transaction signing.
Structured Farcaster token embeds can pass their existing chain and contract
metadata into the external-wallet dashboard. The dashboard selects the matching
EVM or Solana family, requests an EVM network change when necessary, and opens
Trade with that token as the buy asset. It never guesses the chain for a raw
contract address or automatically requests a quote, signature, or transaction.

LI.FI also supplies wallet token discovery, token metadata, and estimated prices.
Portfolio, Send, and Trade share one cache keyed by chain + wallet + token contract.
Displayed quantities are checked onchain rather than trusting indexed holdings;
preflight reads update that same cache before sending or swapping. Farcaster's
wallet positions API is not used by these screens. See the web README for
[wallet data sources and limitations](apps/farcaster-web/README.md#wallet-data-sources).

The wallet currently supports Base, Ethereum, Arbitrum One, BNB Smart Chain,
Celo, Monad, HyperEVM, and Robinhood Chain. Base remains the default network.
Solana Mainnet is supported as a fully independent wallet family alongside
these EVM networks, using Solana RPC rather than Wagmi. See the web README's
[wallet behavior](apps/farcaster-web/README.md#wallet-behavior) section for
what Solana currently supports.

## Requirements

- Node.js 20.19.5 (see `.node-version`; the gates must run on it — see
  [Node version for local runs](#node-version-for-local-runs))
- pnpm 10.8.1 (declared in `package.json`)
- A Reown project ID for WalletConnect
- Etherscan and Alchemy API keys for complete multichain EVM activity
- A Solana RPC endpoint for hosted deployments (see the web README's
  `SOLANA_RPC_URL` documentation)

## Web quick start

Clone your fork and install the workspace:

```sh
git clone git@github.com:YOUR_ACCOUNT/farcaster-wallet-client.git
cd farcaster-wallet-client
corepack enable
pnpm install --frozen-lockfile
pnpm build:packages
```

Configure WalletConnect:

```sh
cp apps/farcaster-web/.env.example apps/farcaster-web/.env.local
```

Set the public Reown project identifier in `.env.local`:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_reown_project_id
```

Then start the web client:

```sh
pnpm --filter farcaster-web dev
```

Open the local URL printed by Vite. When actively changing shared packages, run
`pnpm watch` in another terminal.

See [`apps/farcaster-web/README.md`](./apps/farcaster-web/README.md) for web-only
commands and configuration details.

## Cloudflare Pages deployment

Demo: [farcaster-wallet-client.pages.dev](https://farcaster-wallet-client.pages.dev/).

The hosted client needs both the web build and the same-origin API relay in
`functions/~api/[[path]].ts`. Uploading only the static build is not enough for
hosted Farcaster login. The relay forwards API requests to Farcaster; this fork
does not include an independent Farcaster backend.

Use Cloudflare Pages Git integration with the repository root as the build
root. See the [deployment guide](./apps/farcaster-web/README.md#cloudflare-pages-deployment)
for exact build settings, environment variables, login checks, and limitations.

## Validation

```sh
pnpm --filter farcaster-web typecheck
pnpm --filter farcaster-web lint
pnpm --filter farcaster-web test
pnpm --filter farcaster-web build
```

### Node version for local runs

`.node-version` pins 20.19.5, the runtime CI installs through `actions/setup-node`,
and the root `.npmrc` pins pnpm to it too (`use-node-version`), so the four
commands above already run on CI's runtime. Running `vitest`, `tsc` or `eslint`
by hand with a newer Node on `PATH` does not give CI's result. In CI pnpm fetches
that version as well instead of reusing the runner's own `setup-node` copy:
measured at ~40s of extra wall time across the three gates, all three still
green.

MEASURED 2026-10-21, one tree, only the runtime changed:

- v20.19.5 (pinned, what CI installs): `Test Files 91 passed | 1 skipped (92)`,
  `Tests 959 passed | 2 skipped (961)`, exit 0 — the result the
  `test (farcaster-web)` CI job reports.
- v24.22.0: the runtime defines no `localStorage` global, so `vitest` still hands
  the jsdom test files jsdom's own storage; the wallet files pass.
- v25.0.0: `localStorage` is now the runtime's own global (a bare object), so the
  wallet files fail with `TypeError: localStorage.clear is not a function`.
- v26.10.0 (this workstation's default `node`): same shadowing, but the
  runtime's `localStorage` is `undefined` unless the process was started with
  `--localstorage-file`, so the same files fail with `Test Files 6 failed | 85
  passed | 1 skipped (92)` / `Tests 104 failed | 855 passed | 2 skipped (961)`,
  every failure `TypeError: Cannot read properties of undefined (reading
  'clear')` at the first `localStorage.clear()` in `beforeEach`.

Those Node 25+ failures are an environment artifact, not a red gate, and jsdom is
not the cause: in the same process `globalThis.jsdom.window.localStorage` is a
working storage object. What differs is which globals the test file is handed.
`@vitest/utils`'s `getWindowKeys` copies a jsdom window key onto `globalThis`
only when that key is absent there or is one of its hardcoded `KEYS`, and
`localStorage`/`sessionStorage` are not in that list (vitest 3.2.4), so the
`// @vitest-environment jsdom` docblock keeps the runtime's global instead of the
window's. Node's `sessionStorage` is shadowed the same way on 25+, which means a
jsdom test that reads `sessionStorage` there reads the runtime's storage.

If pnpm cannot fetch the pinned Node, install 20.19.5 yourself (`fnm use`,
`nvm use`, `pnpm env use --global 20.19.5`) and put it first on `PATH` before
running the gates. Do not relax or skip the wallet tests to get a green local
run: on the pinned runtime they pass unmodified.

The wallet flows have also been exercised manually with EVM and Solana
WalletConnect, Unified MetaMask Connect on mobile, a browser with no injected
wallet, detected browser wallets, page refreshes, cancelled pairings, miniapp
transactions, sends, swaps, rejected approvals, and disconnect/reconnect
cycles.

## Security notes

- Never enter a seed phrase or private key into this client.
- Verify token contract addresses before requesting swap quotes.
- Review the destination, value, chain, allowance, and calldata in the connected
  wallet before approving.
- Arbitrary tokens and external routing APIs may be unavailable, illiquid, or
  malicious.
- Use a low-value wallet while developing or testing.

## Current scope

- Wallet additions currently target the web client; the mobile client remains
  the upstream snapshot implementation.
- Portfolio, receive guidance, sends, same-chain swaps, and recent activity
  target the eight documented EVM networks, plus Solana Mainnet with the same
  feature set. EVM and Solana can connect independently or together through
  Unified MetaMask. Miniapps use the shared EVM or Solana connection according
  to the provider interface they request.
- Token discovery/pricing depends on LI.FI coverage; unknown tokens or prices may
  be unavailable. Complete recent EVM history depends on Etherscan or Alchemy;
  locally submitted EVM transactions remain visible while an indexer catches
  up. Solana Activity reads directly from Solana RPC instead of an indexer, so
  it has no equivalent local/optimistic fallback; see the web README's
  [Recent activity](apps/farcaster-web/README.md#recent-activity) section.
- Swap execution depends on LI.FI route availability and downstream liquidity.
- Local development uses the production Farcaster API directly by default;
  hosted builds use it through the same-origin relay. This is not a sandbox.
- Some miniapps restrict embedding or trusted client origins. The API relay
  does not remove those restrictions; compatibility depends on each miniapp.

## Upstream snapshot

This repository began as a snapshot of the Farcaster client monorepo. The
original snapshot is a one-way generated reference whose `main` branch may be
replaced by future snapshots. This fork maintains its wallet changes separately;
review upstream snapshot updates before merging them.

## License

MIT. See [`LICENSE`](./LICENSE).
