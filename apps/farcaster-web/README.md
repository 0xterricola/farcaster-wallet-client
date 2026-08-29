# Farcaster Web

The Farcaster web client with external wallet support through WalletConnect and
detected EIP-6963 browser wallets.

## Setup

Install and build the workspace from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:packages
```

Copy the example environment file:

```sh
cp apps/farcaster-web/.env.example apps/farcaster-web/.env.local
```

Add the public project identifier from the
[Reown dashboard](https://dashboard.reown.com/):

```env
VITE_WALLETCONNECT_PROJECT_ID=your_reown_project_id
```

The local file is ignored by Git. Configure the same variable in the production
hosting environment and allow the relevant local and production origins in the
Reown project settings.

WalletConnect requires this project ID. Modern browser extensions can also be
discovered automatically through EIP-6963.

## Development

From the repository root:

```sh
pnpm --filter farcaster-web dev
```

Open the URL printed by Vite. If you are editing shared workspace packages, run
`pnpm watch` in another terminal.

## Commands

```sh
# Development server
pnpm --filter farcaster-web dev

# Development server with HTTPS enabled explicitly
pnpm --filter farcaster-web start

# Tests and static checks
pnpm --filter farcaster-web test
pnpm --filter farcaster-web typecheck
pnpm --filter farcaster-web lint

# Production build
pnpm --filter farcaster-web build
```

## Wallet behavior

- The active external wallet is persisted as the preferred wallet.
- The same provider and address are used by the wallet dashboard and miniapps.
- Installed EIP-6963 wallets appear as direct choices.
- WalletConnect remains available for QR, mobile, browser, and hardware-wallet
  workflows.
- Disconnecting returns the dashboard to the connection choices.
- Private keys and seed phrases never enter the Farcaster client.

## Built-in wallet actions

- View the connected address and native balance
- Receive with an address QR code
- Send the connected chain's native token
- Swap ETH and arbitrary ERC-20 tokens on Base

Base swap quotes and transaction requests use LI.FI's public quote API. Token
approval and swap signing always occur in the connected wallet.

## Troubleshooting

- If WalletConnect is unavailable, verify
  `VITE_WALLETCONNECT_PROJECT_ID` and the allowed Reown project origins.
- If a browser wallet does not appear, confirm it supports EIP-6963 and is
  enabled for the local site.
- If a stale local Farcaster login produces repeated `401` responses, clear
  website data only for the local Vite origin, reload, and sign in again.
- When testing arbitrary tokens, confirm the contract is on Base and has a
  viable route and sufficient liquidity.
