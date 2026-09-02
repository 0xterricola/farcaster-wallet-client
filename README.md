# Farcaster Wallet Client

A fork of the [Farcaster client snapshot](https://github.com/farcasterxyz/client)
that adds a non-custodial wallet experience to the web client.

The original snapshot intentionally excludes the Farcaster Wallet
implementation. This fork fills that gap with external wallets: users keep
control of their keys and approve every connection, signature, and transaction
in their own wallet.

## Wallet features

- WalletConnect support for QR, mobile, browser, and wallet-directory flows
- Automatic discovery of modern EIP-6963 browser wallets
- One persistent wallet across the dashboard and Farcaster miniapps
- EIP-1193 provider support for miniapp signatures and transactions
- Connected address, native balance, and token portfolio on eight EVM networks
- Receive address with QR code and copy action
- Native-asset and ERC-20 sending with live balance checks
- Same-chain swaps between native assets and arbitrary ERC-20 contracts
- Quote, route, minimum received, allowance, approval, and transaction handling
- Five-item network activity page with transaction and explorer links
- Explicit disconnect and reconnect flow

## How it works

The web client uses Wagmi for connection state and exposes the selected wallet
through the client's existing wallet context. Miniapps, the wallet dashboard,
sends, and swaps all consume that same provider and address.

WalletConnect is the universal fallback. Compatible browser extensions are
discovered through EIP-6963 and displayed as direct connection options. No seed
phrase or private key is created, requested, or stored by this client.

Swap quotes and transaction requests come from the public LI.FI quote API.
The connected wallet remains responsible for approvals and transaction signing.

LI.FI also supplies wallet token discovery, token metadata, and estimated prices.
Portfolio, Send, and Trade share one cache keyed by chain + wallet + token contract.
Displayed quantities are checked onchain rather than trusting indexed holdings;
preflight reads update that same cache before sending or swapping. Farcaster's
wallet positions API is not used by these screens. See the web README for
[wallet data sources and limitations](apps/farcaster-web/README.md#wallet-data-sources).

The wallet currently supports Base, Ethereum, Arbitrum One, BNB Smart Chain,
Celo, Monad, HyperEVM, and Robinhood Chain. Base remains the default network.

## Requirements

- Node.js 20.19.5 (see `.node-version`)
- pnpm 10.8.1 (declared in `package.json`)
- A Reown project ID for WalletConnect
- An Etherscan API key for complete activity on supported Etherscan networks

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

The wallet flows have also been exercised manually with WalletConnect, a
browser with no injected wallet, detected browser wallets, page refreshes,
miniapp transactions, sends, swaps, and rejected approvals.

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
  target the eight documented EVM networks. Miniapps continue to use the shared
  wallet provider for their own supported networks.
- Token discovery/pricing depends on LI.FI coverage; unknown tokens or prices may
  be unavailable. Complete recent history depends on Etherscan or Blockscout;
  locally submitted transactions remain visible while an indexer catches up.
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
