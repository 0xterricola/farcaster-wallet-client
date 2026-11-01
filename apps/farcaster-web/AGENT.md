# Fiddy Agent Surface

This document describes the Fiddy Agent page surface and its client-side storage.

## Route

- **URL**: `~/agent` (resolves to `/#/agent` or `/agent` depending on router config)
- **Component**: `src/pages/agent/AgentPage.tsx`
- **Route definition**: `src/constants/routes.ts` → `routes.agent`

## Features

### 1. NOT_HATCHED State

Landing state for users who haven't set up a Fiddy Agent.

- Hero copy describing 24/7 Hermes agent capabilities
- List of available channels (Farcaster, iMessage, Discord, Telegram, WhatsApp, Email) — each behind owner approval
- "Hatch your Fiddy" CTA → opens https://fiddy.fun/start in a new tab (`target="_blank" rel="noopener"`)
- "Already have an agent? Pair it" link

### 2. PAIRING State

Allows users to manually connect to an existing agent instance.

- **Instance URL** input — validates against `^https://[a-z0-9-]+\.agent37\.app$`
- **Agent Key** input — password field
- Honest copy: "This key stays in this browser only"

### 3. CONNECTED State

Active chat session with the paired agent.

- **Header**: Shows "Fiddy Agent" title + Disconnect button
- **Chat Panel**:
  - Message list with user/agent messages
  - Input composer with Send button
  - User messages use chartreuse background (`#d4ff3f`, dark text)
  - Agent messages use dark glass pane style
- **Error Handling**:
  - Inline error display with red styling
  - "Re-pair" action button to return to pairing state
- **Scheduler Helper**:
  - Text field with "Schedule" button
  - Sends message: "Please schedule this recurring task: <text>"

### Chat API

- **Endpoint**: `<agent_url>/v1/responses`
- **Method**: POST
- **Headers**:
  - `Content-Type: application/json`
  - `X-Agent37-Key: <agent_key>`
- **Body**: `{ "input": "<message>" }`
- **Response handling**: Renders `payload.output_text` or falls back to `JSON.stringify(payload)`

## Storage Keys

All data is stored in browser `localStorage`:

| Key | Value | Description |
|-----|-------|-------------|
| `fiddy.agent.url` | string | Agent instance URL (e.g., `https://my-agent.agent37.app`) |
| `fiddy.agent.key` | string | Agent authentication key |

The `Disconnect` button clears both keys.

## Brand Styling

The page uses Fiddy brand colors defined in `BRAND.md`:

- **Background**: `#161715` (dark)
- **Accent/Brand**: `#d4ff3f` (chartreuse)
- **Text on Chartreuse**: `#1a1c10` (dark ink)
- **Glass panes**: `.solid-glass-pane` class

## Dependencies

- Client-side only — no new npm dependencies
- Uses React hooks: `useState`, `useEffect`
- Uses native `fetch` for API calls
- Uses `localStorage` for persistence