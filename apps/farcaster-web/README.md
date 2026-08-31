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

## Cloudflare Pages deployment

Use a Git-integrated **Cloudflare Pages** project for this repository. The
deployment includes the static web app and a Pages Function for Farcaster API
requests. No mobile build is needed.

### Build settings

Connect your GitHub fork, then configure:

| Setting | Value |
| --- | --- |
| Production branch | `main` (or the branch containing the wallet and relay changes) |
| Framework preset | None |
| Root directory | Leave blank: repository root |
| Build command | `pnpm build:packages && pnpm --filter farcaster-web build` |
| Build output directory | `apps/farcaster-web/dist` |

Do not set the root directory to `apps/farcaster-web`: this repository keeps
`functions/` at the repository root. Pages discovers Functions relative to the
project root, not the static output directory. Use Git integration rather than
uploading the `dist` folder through the dashboard. See Cloudflare's
[Functions deployment guide](https://developers.cloudflare.com/pages/functions/get-started/).

### Build environment variables

Set these in Cloudflare before deploying:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `20.19.5` |
| `PNPM_VERSION` | `10.8.1` |
| `VITE_WALLETCONNECT_PROJECT_ID` | Your own Reown project ID |

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
