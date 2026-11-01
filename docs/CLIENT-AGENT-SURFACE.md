# The agent surface and the node pill (client v1)

Two differentiators ship in this client, and both are visible from the shell
rather than buried: **reads come from your own Snapchain node** (with a
persistent pill that says so) and **your own agent lives inside the client**.
This file is the contract for both — what is wired, what is honestly labelled
as not wired, and the rules the code must keep.

## 1. The node status pill

`src/components/snapchain/NodeStatusPill.tsx`

Persistent chrome: top of the left sidebar (desktop, dot-only when the sidebar
is collapsed) and in the phone top bar. Every state links to the node surface
(`/~/settings/node`: health, app key, composer, feed, client filter).

| state | when | copy |
| --- | --- | --- |
| `served` | a node is configured and `/v1/info` answered | "Served by your node · v0.13.5 · 2 shards" |
| `unreachable` | configured, but the last health call failed | "Your node unreachable" |
| `checking` | configured, first call in flight | "Checking your node…" |
| `relay` | no `VITE_SNAPCHAIN_HTTP_URL` in this build | "Public relay" |

Rules the pill must keep, and the tests that hold them
(`src/components/snapchain/__tests__/NodeStatusPill.test.tsx`):

- It never says "your node" when no node is configured, even if a stale healthy
  reading is lying around.
- A failed refresh reports failed, not the memory of success. Falling back to
  the public relay is never silent.
- The state machine is a pure function (`nodePillState`) so the claims are
  testable without a browser.

`isNodeExplicitlyConfigured()` in `src/snapchain/nodeEnv.ts` is what separates
"you pointed us at a node and it is down" from "this build never had one".

### Where the feed actually comes from

- **The node-backed feed** is `NodeFeed` on the node surface: the follow graph
  and each followee's casts are read from your node over `/v1/*` and merged
  locally on the Farcaster timestamp, because a read node has no indexer and no
  home-feed endpoint. Likes, recasts and follows are signed by the client's
  app key and submitted to the same node.
- **The default home feed** is still the public relay's view. That is why the
  pill exists: it names the source of what you are looking at instead of
  implying everything came from your own box.

## 2. The agent surface

`src/pages/agent/` + `src/components/agent/` + `src/lib/agentService.ts`

Route: `/~/agent` (registered in `Router.tsx`; the sidebar entry, the phone
menu entry and the hatch card all land there). Three states, no fake ones:

1. **Not paired** — the egg, one hatch action, the honest line about whether
   hatching is open, and a receipt for what a hatched agent ships with (the
   live Hermes catalog counts, fetched anonymously).
2. **Pairing** — the address of the *agent service* plus a session token. Both
   fields are validated: a bare `https` origin, and an opaque single-line
   token. A typo is refused, never silently repaired.
3. **Paired** — the agent's identity and lifecycle (start / stop / restart /
   destroy), then three tabs: **Chat**, **Scheduled tasks**, **Channels**.

### The service contract

The client talks to an *agent service* — a Hermes control plane — and to
nothing else. Endpoints, all JSON, all under one origin:

```
GET    /api/health                              service liveness + mode
GET    /api/agents/instances                    the agents this owner has
POST   /api/agents/instances/:id/:action        start | stop | restart
DELETE /api/agents/instances/:id                destroy (stops all billing)
POST   /api/agents/instances/:id/chat           one message, one reply
GET    /api/agents/instances/:id/integrations   channel toolkits + links
POST   /api/agents/instances/:id/integrations   begin a channel connection
GET    /api/fiddy/hatch-quote                   price certificate (opt-in)
GET    /api/hermes/catalog                      the live Hermes catalog
```

Default origin: `VITE_AGENT_SERVICE_URL` (built in as
`DEFAULT_AGENT_SERVICE_URL`), overridable per user in the pairing screen so
anyone can point the client at their own control plane.

This is the `legitmate-farcaster` control plane under `mate.legitclub.com`
(`/api/agents/instances/*`, `/api/hermes/catalog`). The `fiddy/*` routes exist
in that repo but are **not deployed yet**: a 404 there is treated as "hatching
is not offered on this service", not as a crash, and the empty state says so.

### Rules the surface must keep

- **Provider-neutral naming.** Nothing in the surface names the vendor behind
  the service. `src/pages/agent/__tests__/agentSurfaceInvariants.test.ts`
  reads every surface file and fails on `agent37`, provider names, or
  `X-Agent37-Key` style headers.
- **Never a provider key in the browser.** The token in the pairing screen is
  the owner's *service* session token — it authorises managing their agents and
  grants nothing at the model provider. The module reads no `*_API_KEY` from
  the environment, stores no key, and sends exactly two headers (`accept`,
  `authorization`). The invariant test enforces the "reads no key" half.
- **One approval per channel.** A channel row starts unapproved; approving is
  its own click; only then does the client ask the service for a URL and open
  it for the owner to finish. The client never receives a channel credential.
- **A request log is not a scheduler.** The control plane exposes no scheduling
  endpoint, so the Scheduled tasks tab sends the plain-English request to the
  agent over chat (the agent writes its own cron entry on its machine) and
  keeps a local record of what was asked and what came back. It says
  "sent · waiting", "agent answered", "did not send" — never "running".
- **Nothing claims a capability the service has not confirmed.** Channels the
  service has not exposed carry a `· soon` tag (`iMessage`, `WhatsApp`,
  `Email`, `Web / API`).

## 3. WIP decision: what was kept, what was thrown away

The tree carried untracked work from an earlier attempt at this surface. The
decision, per file, is part of the change:

| file | decision | why |
| --- | --- | --- |
| `src/components/agent/AgentCard.tsx` | **adopted, rewritten** | The three-state visual language (egg, chartreuse identity card) matches the design brief. Rewritten because its pairing state was a fake `searching → found → confirming` stepper — nothing is being searched, the owner pastes an address — and its copy was not honest about what is wired. Now: honest hatch availability, live catalog receipt, real lifecycle actions. |
| `src/components/agent/AgentNavItem.tsx` | **adopted, rewritten** | The egg-state nav idea is right. Rewritten as a real `NavLink` (accessible routing, current-route highlighting) driven by actual session state instead of decorative props; the fake "PAIRING" pulse is gone. |
| `src/components/agent/AgentDashboard.tsx` | **discarded** | A thin wrapper around a card the page composes itself; it added a layer with no behaviour. |
| `src/components/agent/AgentStatusBadge.tsx` | **discarded** | Superseded: it was a node badge that duplicated the status pill and could only render in one place. The pill is persistent chrome and linkable. |
| `src/lib/nodeClient.ts` | **discarded** | Duplicate of the committed `src/snapchain/useNodeClient.ts` + `nodeEnv.ts` (which have tests), and it read `VITE_SNAPCHAIN_HTTP_URL` directly — bypassing the same-origin `/snapchain-api` proxy that exists because the node's CORS set-up blocks `submitMessage` from a browser. Keeping it would have shipped a second, broken path to the node. |

## 4. What is live vs not, today

| capability | state |
| --- | --- |
| reads/writes through your own node, gasless app key, revoke, client filter, node feed | live (`/~/settings/node`, verified against a real node — see `docs/NODE-CLIENT.md`) |
| node status pill in the shell | live |
| agent surface route, pairing, chat, lifecycle, channels, catalogs | live against the control plane's deployed routes |
| hatching a new agent | **not open**: the control plane's hatch flow is gated (`hatchEnabled: false` / route not deployed). The client says so and offers pairing instead. |
| per-channel connections | live where the service exposes toolkits; the rest are labelled `soon` |
| scheduled tasks | request-through-chat + local log; no scheduling endpoint exists to call |
| external wallets (WalletConnect EVM + Solana, EIP-6963, MetaMask) | inherited from the fork, untouched |