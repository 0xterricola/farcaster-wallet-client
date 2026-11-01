# Together — work with your people

One project, one board, everyone on the same page. You bring your Farcaster
identity; the people you invite bring theirs. Nobody creates an account, because
membership **is** the FID you already have.

Two routes, both reachable signed out:

| Route | What it is |
|---|---|
| `/~together` | where a session starts: sign in with Farcaster, then create a space or open one you are in |
| `/~together/join/:token` | the other end of an invite link — says whose space it is, then asks for nothing but Farcaster |

The ELI5 in the page header is the spec: *"One project, one board, everyone on
the same page… Each of you works the cards in your own Hermes — nobody shares a
key."*

## Where the data lives

Not in this app. A collaboration service (`/spaces/*`, the `hermes-multiplayer`
alpha) owns the space, its members and its cards. `src/lib/together.ts` is the
whole client: plain `fetch` against that service's origin, so a self-hosted
space and a hosted one take the same code path. In production the client and the
API share an origin (`VITE_TOGETHER_API_URL=''` means "same origin"); the dev
probe proxies `/spaces` instead.

The board refreshes by asking what changed every 3 seconds (the event stream,
not a full re-read). Live typing and websockets are **soon**.

## What the page does

- **Sign in with Farcaster**: the service creates the challenge, so the nonce it
  gets back is bound to the request it started. This app only carries the
  channel URL to the QR and polls for the answer.
- **Start a space**: a name and a channel (`#fiddy`). The space then has a board
  with To do / Doing / Done.
- **Invite someone**: the owner mints a link; it lands on `/~together/join/<token>`.
- **Work a card**: start it, finish it, or send it back. Every move carries the
  card's version, so a card somebody else moved answers `409` instead of
  overwriting their change.
- **Cast it to the channel**: a finished card can be queued for the channel. The
  space does not post it — a member's own Hermes does, with that member's own
  signer.

## How it is verified

`scripts/verify-together-surface.mjs` drives a real browser against the real
service, at both widths the surface has to work at. Nothing in the page is
stubbed; the probe plays the phone for the sign-in handshake (the service's
dev-only approve endpoint) and reads back what actually rendered.

```sh
# 1. the service, with its offline verifier, minting links back at the app
cd ~/Projects/hermes-multiplayer
HERMES_MULTIPLAYER_SIWF_MODE=trusting \
HERMES_MULTIPLAYER_DB_PATH="$PWD/.runtime/together-probe.db" \
HERMES_MULTIPLAYER_INVITE_BASE_URL="http://localhost:5199" \
  .venv-verified/bin/python -m uvicorn server.service:app \
  --host 127.0.0.1 --port 8767 --no-access-log

# 2. the app, with the probe's own vite config (own dep cache + /spaces proxy)
cd ~/Projects/fiddy/apps/farcaster-web
HTTPS=false VITE_TOGETHER_API_URL='' \
  npx vite --config scripts/together.vite.config.mjs --port 5199 --strictPort

# 3. the probe
TOGETHER_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
TOGETHER_SERVER=http://localhost:5199 TOGETHER_SERVICE_URL=http://127.0.0.1:8767 \
  node scripts/verify-together-surface.mjs
```

Recorded 2026-10-21: **44/44 checks**, at 390×844 and 1440×900 — the headline and
the honest note, no horizontal overflow, the dark brand ground, a real QR from
the service, the create-space form, three columns laid out per width, every
visible button ≥40px, a card added by the owner, an invite link that really is a
URL into this app, a **second identity** in a second browser context joining and
seeing **both members and the owner's card**, that member moving the card to
Done, and the owner's never-reloaded page **converging on its own** — plus zero
console and page errors in either context.

The probe earned its keep: it caught a real bug on the first green run — after
creating a space the page kept the *sign-in* token, which carries no space, so
every write answered "Join a space first" even though the board rendered. The
fix swaps the session's token for the one the create call returns (and persists
it) before the board mounts.

## Running it by hand

The service needs its offline verifier for local work
(`HERMES_MULTIPLAYER_SIWF_MODE=trusting`) — that mode accepts the FIDs a dev
endpoint asserts and is not a production identity path. Without it, sign-in goes
through Farcaster's relay. Do not expose the alpha service publicly: single
process, SQLite, no per-space rate limits.

## Not here yet (say "soon", not "done")

- Live typing, websockets, notifications when someone moves your card.
- Switching between several spaces from the board (the space list exists; the
  switcher is not wired).
- Per-card comments, attachments, assignee pickers.
- Any Together panel inside the Hermes plugin's dashboard page — the plugin's
  surface today is its seven `fiddy_spaces_*` agent tools (see
  `plugins/fiddy/docs/MULTIPLAYER.md` in `ivcained/legitmate-farcaster`).
