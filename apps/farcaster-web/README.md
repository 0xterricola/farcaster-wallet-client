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

Ethereum reads use a browser-compatible public RPC by default. Deployments may
override it with their own endpoint:

```env
VITE_ETHEREUM_RPC_URL=https://your-ethereum-rpc.example
```

Arbitrum One reads use its browser-compatible official RPC by default. An
optional override is also available:

```env
VITE_ARBITRUM_RPC_URL=https://your-arbitrum-rpc.example
```

BNB Smart Chain reads use a browser-compatible official RPC by default. An
optional override is also available:

```env
VITE_BSC_RPC_URL=https://your-bsc-rpc.example
```

Celo reads use its documented browser-compatible Forno RPC by default. An
optional override is also available:

```env
VITE_CELO_RPC_URL=https://your-celo-rpc.example
```

Monad reads use its browser-compatible mainnet RPC by default. An optional
override is also available:

```env
VITE_MONAD_RPC_URL=https://your-monad-rpc.example
```

HyperEVM reads use its browser-compatible mainnet RPC by default. An optional
override is also available:

```env
VITE_HYPEREVM_RPC_URL=https://your-hyperevm-rpc.example
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

## Cloudflare Pages deployment

Use a Git-integrated **Cloudflare Pages** project for this repository. The
deployment includes the static web app and a Pages Function for Farcaster API
requests. No mobile build is needed.

### Build settings

Connect your GitHub fork, then configure:

| Setting                | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Production branch      | `main` (or the branch containing the wallet and relay changes) |
| Framework preset       | None                                                           |
| Root directory         | Leave blank: repository root                                   |
| Build command          | `pnpm build:packages && pnpm --filter farcaster-web build`     |
| Build output directory | `apps/farcaster-web/dist`                                      |

Do not set the root directory to `apps/farcaster-web`: this repository keeps
`functions/` at the repository root. Pages discovers Functions relative to the
project root, not the static output directory. Use Git integration rather than
uploading the `dist` folder through the dashboard. See Cloudflare's
[Functions deployment guide](https://developers.cloudflare.com/pages/functions/get-started/).

### Build environment variables

Set these in Cloudflare before deploying:

| Variable                        | Value                     |
| ------------------------------- | ------------------------- |
| `NODE_VERSION`                  | `20.19.5`                 |
| `PNPM_VERSION`                  | `10.8.1`                  |
| `VITE_WALLETCONNECT_PROJECT_ID` | Your own Reown project ID |

`VITE_ETHEREUM_RPC_URL` is optional. Set it to a browser-compatible Ethereum
RPC if you do not want to use the public default. Because it is exposed to the
browser, do not place a secret RPC credential in this variable unless the
provider restricts it by origin and treats it as public client configuration.

Cloudflare does not receive your ignored `.env.local` file. The `VITE_` project
ID is public client configuration and is embedded at build time; redeploy after
changing it. Never put private keys or secret API credentials in `VITE_`
variables. Configure Preview variables separately if you use branch previews.
See Cloudflare's [build environment reference](https://developers.cloudflare.com/pages/configuration/build-image/).

Deploy, then add the resulting origin (for example,
`https://YOUR_PROJECT.pages.dev`) to your Reown project's allowed origins.
Include custom domains and preview origins you intend to test. This setting
controls WalletConnect access; it does not fix Farcaster API CORS errors.

The project's production `pages.dev` URL stays the same across deployments.
Pushes to the configured production branch trigger production builds; an
unmerged feature branch does not update `main`'s deployment. When switching
the production branch, ensure it includes both wallet changes and the relay.

### Why the API relay is required

Direct browser requests from our hosted domain to
`https://farcaster.xyz/~api` were rejected by the upstream CORS policy, which
prevented login. Production builds now request `/~api/...` on their own origin.
The Pages Function at [`functions/~api/[[path]].ts`](../../functions/~api/[[path]].ts)
forwards those requests to the fixed Farcaster upstream host.

- Development mode still uses the upstream API directly by default.
- Production API routing is selected in [`src/constants/api.ts`](./src/constants/api.ts).
- WebSockets still connect directly to `wss://ws.farcaster.xyz/stream`.
- WalletConnect, LI.FI, and chain RPC requests are not routed through this relay.
- No database, storage binding, or extra relay secret is required by this code.

The relay forwards authorization and Farcaster device headers transiently. It
removes cookies and the listed origin/forwarding headers from requests, strips
upstream `Set-Cookie` and CORS response headers, and returns
`Cache-Control: no-store`. It does not explicitly log or persist request bodies
or credentials. That is not a claim that the whole deployment has no logging:
the host processes authentication tokens, platform request logs may exist, and
the upstream client's analytics remain separate from the relay.

This is an independent client using Farcaster's production services, not an
isolated test backend. Logins and account actions are real, and availability
depends on upstream access. Static-only hosts such as GitHub Pages cannot run
this Function; another host needs an equivalent server-side relay.

### Verify a deployment

1. Confirm the successful deployment uses the intended branch and commit and
   includes the Pages Function, not just static files.
2. Open the production URL and test Farcaster sign-in.
3. In the browser's Network panel, confirm API calls use your domain's
   `/~api/` path and return API responses, not the app's HTML page. Do not share
   authorization headers or login tokens when reporting errors.
4. Connect an external wallet, confirm the dashboard address, and test that a
   compatible miniapp sees the same account. Reject a transaction request to
   check the approval flow without spending funds.
5. Refresh and check session restoration. Also test direct navigation to a
   client route.

Serving a production build with a static-only preview server does not run
Pages Functions, so it is not a complete test of hosted login.

### Miniapp domain compatibility

The relay fixes our client's Farcaster API requests, not every miniapp's domain
requirements. A miniapp may restrict embedding through CSP `frame-ancestors`
or `X-Frame-Options`, enforce trusted origins in its messaging, or restrict API
access with CORS. Inspect the actual browser error before choosing a fix.

Miniapp owners may need to allow your client origin. Adding the origin to
Reown does not grant that permission. Do not strip third-party security headers
or assume every miniapp will work on a fork's domain.

## Wallet behavior

- The active external wallet is persisted as the preferred wallet.
- The same provider and address are used by the wallet dashboard and miniapps.
- Installed EIP-6963 wallets appear as direct choices.
- WalletConnect remains available for QR, mobile, browser, and hardware-wallet
  workflows.
- Disconnecting returns the dashboard to the connection choices.
- Private keys and seed phrases never enter the Farcaster client.

## Built-in wallet actions

- View the connected address, native ETH, and Base ERC-20 balances
- Receive with an address QR code
- Send ETH and ERC-20 tokens on Base with exact integer amounts and live checks
- Swap ETH and arbitrary ERC-20 tokens on Base
- View Arbitrum One balances, receive guidance, send ETH or ERC-20 tokens, and
  swap through LI.FI using Circle-issued Arbitrum USDC as the default stablecoin.
- View BNB Smart Chain BNB and BEP-20 balances, receive guidance, send BNB or
  BEP-20 tokens, and swap through LI.FI. The default stablecoin is verified
  Binance-Peg USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, 18
  decimals), not Circle-issued native USDC.
- View Celo CELO and token balances, receive guidance, send CELO or ERC-20
  tokens, and swap through LI.FI using Circle-issued Celo USDC
  (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`, 6 decimals) as the default
  stablecoin.
- View Monad MON and token balances, receive guidance, send MON or ERC-20
  tokens, and swap through LI.FI using verified Monad USDC
  (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, 6 decimals) as the default
  stablecoin.
- View HyperEVM HYPE and token balances, receive guidance, and send HYPE or
  ERC-20 tokens. Trade remains disabled until its HyperEVM transaction path is
  enabled. Native USDC is `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
  with 6 decimals.

Base swap quotes and transaction requests use LI.FI's public quote API. Token
approval and swap signing always occur in the connected wallet.

## Wallet data sources

The built-in Base wallet uses LI.FI, not Farcaster's wallet positions API:

- `GET https://li.quest/v1/wallets/{address}/balances?extended=true` discovers
  token contracts and estimated USD prices. Only Base entries are displayed.
- `GET https://li.quest/v1/token?chain=8453&token={contract}` resolves tokens
  entered manually in Send or Trade. Unsupported tokens produce an error, not
  a fabricated zero balance. LI.FI native ETH is the zero-address marker.
- LI.FI indexed quantities are **not** used as spendable balances. Base RPC
  reads verify native balances, ERC-20 `balanceOf`, and token decimals.
- Portfolio, the ETH header, Send, and Trade use the same React Query balance
  cache keyed by chain ID, wallet address, and contract. Fresh preflight checks
  publish into this cache. Confirmed sends/swaps invalidate the wallet cache.
- Balance reads refresh every 30 seconds while observed; discovery every 60
  seconds. The portfolio checks 20 token rows at a time, with Show more.
- USD values are live quantities multiplied by LI.FI's estimated token prices.
  Unknown prices and failed balance reads show unavailable/`—`, not zero.

No LI.FI API key or new build variable is added by this integration. Requests
use the public REST API directly, as swaps already did; rate limits or service
changes can affect availability. Farcaster authentication is not required by
the wallet-data hooks, although the surrounding client still uses Farcaster
for social features and login. LI.FI receives the public wallet address and
requested contracts; chain RPC providers receive balance queries. No Farcaster
auth headers, cookies, private keys, or seeds are sent to LI.FI.

LI.FI discovery can be incomplete or delayed. Its verification labels are not
a security guarantee. Unverified tokens are hidden by default and can be shown
explicitly. Known zero balances are omitted from portfolio rows; RPC failures
remain visible as unavailable. Contract entry in Send/Trade supports tokens
recognized by LI.FI but does not persist a custom token list yet.

Live checks cannot guarantee a later transaction succeeds: funds can move,
fees can change, and tokens can impose restrictions. Signing remains external.
Swap approvals are exact-amount; approval receipts must succeed before a swap.
If a refreshed quote worsens the reviewed minimum or changes spender, the user
must obtain and review a new quote. Submission is distinguished from receipt
confirmation. This patch does not add multichain transfers or portfolio history.

## Troubleshooting

- If WalletConnect is unavailable, verify
  `VITE_WALLETCONNECT_PROJECT_ID` and the allowed Reown project origins.
- If Ethereum balances are unavailable, confirm that `VITE_ETHEREUM_RPC_URL`
  accepts JSON-RPC requests from the deployed site's browser origin.
- If Arbitrum balances are unavailable, confirm that `VITE_ARBITRUM_RPC_URL`
  accepts JSON-RPC requests from the deployed site's browser origin.
- If BNB Smart Chain balances are unavailable, confirm that `VITE_BSC_RPC_URL`
  accepts JSON-RPC requests from the deployed site's browser origin.
- If Celo balances are unavailable, confirm that `VITE_CELO_RPC_URL` accepts
  JSON-RPC requests from the deployed site's browser origin.
- If Monad balances are unavailable, confirm that `VITE_MONAD_RPC_URL` accepts
  JSON-RPC requests from the deployed site's browser origin.
- If HyperEVM balances are unavailable, confirm that `VITE_HYPEREVM_RPC_URL`
  accepts JSON-RPC requests from the deployed site's browser origin.
- If a browser wallet does not appear, confirm it supports EIP-6963 and is
  enabled for the local site.
- If a stale local Farcaster login produces repeated `401` responses, clear
  website data only for the affected client origin, reload, and sign in again.
- If hosted login reports CORS errors for `farcaster.xyz/~api`, check that the
  deployed commit includes the relay and production API routing. Rebuilding
  with only a Reown origin change will not resolve this.
- If your domain's `/~api/` requests return `404` or HTML, check the Pages root
  directory and Function deployment. A green static build alone is not enough.
- If the app works locally but WalletConnect is missing on the hosted site,
  set the build variable in Cloudflare and redeploy.
- If only a miniapp is blank, inspect its embedding/trusted-origin errors; see
  [Miniapp domain compatibility](#miniapp-domain-compatibility).
- When testing arbitrary tokens, confirm the contract is on Base and has a
  viable route and sufficient liquidity.
