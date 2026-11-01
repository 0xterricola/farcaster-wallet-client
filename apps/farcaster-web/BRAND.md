# Fiddy Brand Guidelines

This document tracks the Fiddy brand changes applied to the web client (`apps/farcaster-web`).

## Colors

### Background & Neutrals
| Token | Light | Dark (Fiddy) |
|-------|-------|--------------|
| `neutrals.dark.black` | `#121212` | `#161715` |
| `background.dark.default` | — | `#161715` |
| `background.dark.primary` | — | `#161715` |
| `border.dark.primary` | varies | `#24292e` |

**CSS Custom Properties** (defined in `tailwind.config.js` → generated as CSS vars):
- `--bg-app` resolves to `neutrals.dark.black` in dark mode (#161715)
- `--text-default` resolves to white in dark mode

### Accent (Chartreuse)
| Token | Light | Dark |
|-------|-------|------|
| Brand | `#7959ff` | `#d4ff3f` |
| Brand Light | `#eee9ff` | `#ccff5c` |
| Brand Medium | `#ddd4ff` | `#b8e618` |
| Brand Disabled | `#5d42d6` | `#7ea600` |

The accent color changed from **violet** (`#866aff` in dark) to **chartreuse** (`#d4ff3f` in dark).

**Text on Chartreuse**: Never use light text on chartreuse fills. Always use dark ink `#1a1c10`.

**Text/Icons on Dark**: Use `#d4ff3f` directly, or `#7cb518` if pure chartreuse fails contrast.

## CSS Classes Added

### Tailwind Config
- Added `chartreuse` color scale (10 shades: chartreuse100–chartreuse950)
- Mapped `background.dark.brand` → `chartreuse500`
- Mapped `text.dark.brand` → `chartreuse500`
- Mapped `bg-action-primary` → chartreuse

### Custom CSS (index.css)
- `.solid-glass-pane` — Solid Glass material with top rim light, outer hairline, shade below
- `.bg-action-primary` — Chartreuse background with dark text
- `.text-action-primary` / `.fill-action-primary` — Chartreuse text/icons
- `.text-action-primary-lowcontrast` / `.fill-action-primary-lowcontrast` — `#7cb518` fallback

## Files Modified

1. **`tailwind.config.js`**
   - Changed `neutrals.dark.black` from `#101010` to `#161715`
   - Added `chartreuse` color scale
   - Changed `background.dark.brand*` to use chartreuse
   - Changed `text.dark.brand*` to use chartreuse
   - Changed `border.dark.highlight` to chartreuse

2. **`index.css`**
   - Added Solid Glass pane styles
   - Added chartreuse utility classes

3. **`index.html`**
   - Changed `<title>` to "Fiddy"
   - Changed `background-color` for dark mode to `#161715`

4. **`src/components/page/PageMeta.tsx`**
   - Changed `og:site_name` to "Fiddy"

5. **`src/pages/homeFeed/HomeFeedPage.tsx`**
   - Changed page titles from "Farcaster / Home" to "Fiddy / Home"

6. **`src/pages/homeFeed/ComposePage.tsx`**
   - Changed page title to "Fiddy / Home"

7. **`src/pages/proUpsell/ProUpsellPage.tsx`**
   - Changed page title to "Fiddy / Home"

8. **`src/pages/farcasterConnect/FarcasterConnectPage.tsx`**
   - Changed page title to "Fiddy / Sign in with Fiddy"

9. **`src/pages/signInWithFarcaster/SignInWithFarcasterPage.tsx`**
   - Changed page title to "Fiddy / Sign in with Fiddy"

## What Was NOT Changed

- **Protocol references**: "Farcaster" when referring to the protocol (e.g., "Farcaster account", "Farcaster API")
- **Package names**: `farcaster-client-hooks`, `farcaster-analytics`, etc.
- **Warpcast references**: "Warpcast" when referring to the official mobile app (redirect hooks, contexts, etc.)
- **Developer docs links**: "Farcaster protocol embeds spec", "Farcaster Docs"
- **Page titles with "Farcaster" that denote the protocol**: e.g., settings pages showing "Casts & Users / Fiddy" were intentionally left as "Farcaster" in some places where it refers to the protocol, not the client brand

## Solid Glass Material Rules

- **Finish at the edge**: Top rim light `rgba(255,255,255,0.14)` 
- **Outer hairline**: Subtle light/dark borders
- **Shade below**: Drop shadow implying thickness
- **Heavier panes**: Not airy, more substantial
- **Shared state**: One style for hover/chosen/held

Use `.solid-glass-pane` class on container elements to apply these styles.
## The shell (Oct 19) — design implemented, not reskinned

Source of truth: OpenDesign project `fiddy-client-4695` (`index.html` +
`tokens.css`). The values below are copied from it, not invented.

### Where the tokens live

- `src/styles/fiddy-shell.css` — the `--fiddy-*` CSS variables and the shell
  chrome classes (`.fiddy-topbar`, `.fiddy-nav`, `.fiddy-agent-card`,
  `.fiddy-tabs`, `.fiddy-welcome*`). Imported from `src/index.css`.
- `tailwind.config.js` — the same palette as a flat `fiddy` colour group
  (`bg-fiddy-bg`, `text-fiddy-accent`, …) for new components.
- `index.html` — favicon/apple-touch-icon from `public/brand/`, `theme-color`
  `#161715`, and an unset theme preference now resolves to **dark** (`system`
  was the fork's default; a light Fiddy shell does not exist).

### Dark only, on purpose

`useFiddyBrandGround()` (`src/components/fiddy/useFiddyBrand.ts`) pins the app
to dark while a Fiddy surface is mounted and writes `user-saved-theme=dark`, the
same key Settings already reads — the choice stays visible and reversible.

### What is ours now

1. **Welcome screen** (`/` unauthenticated) — `FiddyWelcomePage`: the Fiddy
   lockup, the tagline *"the agentic farcaster client"*, the four differentiators,
   and the fork's own Farcaster sign-in modals behind our buttons.
2. **Shell chrome** — `FiddyTopBar` (the 3D baby mark + wordmark, node-status
   pill, avatar), left nav ordered Feed → Agent → Wallet → Settings then the rest
   of the fork's surfaces under "More", and the agent panel at the top of the
   right column on the feed (`AgentRailPanel`, honest `soon` tags intact). The
   nav's own logo is the same baby as a still, not a second animated mark: one
   canvas per shell is the brand, and the nav sits below the fold.
3. **Phone** — `FiddyMobileTabBar`: Feed / Agent / Wallet / Settings on a fixed
   bottom bar; the node pill stays in `MobileHeader`'s top bar.

The feed's own typography and density are untouched: the rounded brand face is
chrome-only so dense text stays as readable as upstream.
