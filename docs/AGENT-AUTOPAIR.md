# Waking your agent, without a URL and a token

`docs/CLIENT-AGENT-SURFACE.md` describes the agent surface and the node pill.
This file adds the one thing that surface was missing: the way a signed-in owner
gets an agent session at all.

## What was wrong

Somebody names their agent, picks the built-in brain, signs in with Farcaster —
and `/~/agent` shows **"Hatch your Fiddy · soon"** and a form asking for an agent
service address and a session token. A non-technical owner has neither. The
service they are talking about is _ours_; the identity they signed in with is the
only thing either side needs.

## What happens now

| who                                                                    | what `/~/agent` does                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| signed in, brain `fiddy` or `surp`                                     | asks the service for their owner session on arrival, then lands in **Chat**: the name they chose, the conversation they already had before signing in, and a real input. No address field, no token field. |
| signed in, brain `fiddy`/`surp`, and the service cannot start an agent | same chat shape, and **one sentence** in the header — the service's own words when it sent any. The form does not exist until the owner asks for it.                                                       |
| signed in, any other brain (their own service, their own key)          | unchanged: the hatch card and the pairing form, which is the right screen for a self-hoster.                                                                                                               |
| not signed in                                                          | unchanged: the hatch card.                                                                                                                                                                                 |

The pairing form (`AgentPairPanel`) is now reached from **"I run my own agent
service — pair it"**, on the warm surface and on the hatch card, and its copy says
who it is for.

## The pieces

| file                                                    | job                                                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/siwfSession.ts`                                | keeps the SIWE message + signature a completed sign-in produces, in `sessionStorage`, for 30 minutes, consumed once (`saveSiwfProof` / `loadSiwfProof` / `clearSiwfProof`) |
| `src/lib/fiddyAgentAutopair.ts`                         | decides whether this setup may be paired automatically, asks for the session, reads the answer, and owns the sentences for every failure                                   |
| `src/pages/agent/AgentPage.tsx`                         | runs that once per visit, pairs, lands on Chat, and adopts the pre-login exchange                                                                                          |
| `src/lib/trialChat.ts`                                  | already kept the pre-login exchange (`fiddy.trial`); the page now reads it, shows it first, then deletes it                                                                |
| `src/pages/agent/Component/AgentChatPanel.tsx`          | an optional `awaiting` prop: the sentence takes the place of the input instead of a field that would swallow a message                                                     |
| `legitmate-farcaster` → `POST /api/fiddy/owner-session` | mints the owner session from the proof, verified against Farcaster's own contracts. See that repo's `docs/fiddy/OWNER-SESSION.md`                                          |

## Rules this keeps

- **Never a fabricated session, and never a fabricated sentence.** A failure is
  the service's own message, or a local sentence from `AUTOPAIR_SENTENCES` — one
  per code, and two of them say _nothing was changed_.
- **The proof is not a credential to keep.** `sessionStorage`, thirty minutes,
  deleted the moment the exchange has spent it. It is replayable, and it is
  treated that way.
- **The session is the owner's, not the browser's idea of one.** A successful
  answer must carry a usable token and a usable service address; anything else
  counts as malformed and nothing is paired.
- **Provider-neutral naming.** `src/lib/fiddyAgentAutopair.ts` is in
  `agentSurfaceInvariants.test.ts`'s file list, so it cannot start naming the
  vendor behind the service or reading a provider key.
- **The pairing form is not deleted.** Somebody who runs their own control plane
  needs it, and it is one disclosure away — never on the way in.

## Where the request goes, and the one operator step

The browser posts to **its own origin** (`/api/fiddy/owner-session`, overridable
with `VITE_FIDDY_OWNER_SESSION_URL`), because the agent service sends a browser no
CORS headers at all (measured: no `access-control-allow-origin` on
`mate.legitclub.com/api/health` or `/api/agents/instances`). The host is expected
to proxy that path to the control plane, exactly as `/api/fiddy/trial-chat` is
expected to be proxied — one nginx location covers both.

That also means the session's later calls (`/api/agents/instances`, chat) must be
reachable from the browser: either the host proxies them too, or the control plane
answers with CORS for this origin. Until one of those is true, the surface says —
truthfully — that the service did not answer. This is the same topology question
as the trial route, and it is not something this card can settle from the client.

## How it is verified

- `src/lib/__tests__/fiddyAgentAutopair.test.ts` — which setups are paired
  automatically, what is sent, and every way an answer can be unusable.
- `src/pages/agent/__tests__/agentAutopairLanding.test.tsx` — the surface a
  signed-in owner actually gets: Chat with the adopted exchange, or one sentence
  and no form.
- `scripts/verify-agent-autopair.mjs` — the real app in Chrome: the way in, the
  pre-login message, the Farcaster sign-in (relay stubbed with a _real_ signed
  SIWE message), `/~/agent` with a minted session, with a refusal, and with an
  unreachable service. Screenshots land in `$AUTOPAIR_SHOT_DIR`.

### Running that probe — three measured traps

1. **The client under test must be node-backed.** A client started without
   `VITE_SNAPCHAIN_HTTP_URL` sends a signed-in session to the device-only landing
   (`~/components/session/useDeviceOnlySession`), so `/~/agent` never renders an
   agent surface and every check reads that landing instead. Start it the way the
   release does:

   ```
   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com HTTPS=true \
     npx vite --port 5266 --strictPort
   AUTOPAIR_ORIGIN=https://localhost:5266 node scripts/verify-agent-autopair.mjs
   ```

   The check _"the client under test is node-backed"_ fails loudly when a run
   forgets this.

2. **The trial box is an input, not a textarea.** `TrialChat` renders
   `<input data-trial="input">` and `<button data-trial="send">`; a probe that
   looks for `[data-fiddy="trial"] textarea` finds nothing and silently skips the
   whole pre-login step (`trialFieldFound: false` in the failure detail is that
   mistake, not a product bug).
3. **Measure the whole surface.** The shell's navigation precedes the agent panel
   in the document, so a truncated body text measures the sidebar. Claims like
   "the exchange they already had is on screen" are read off the full page text.

15/15 checks, in Chrome, on the client under test (`2026-10-22`): the exchange
was kept before sign-in and adopted by the signed-in chat, the service was asked
for the owner session with the proof and the chosen name, the session that came
back is what the agent API was called with, the surface is a chat with an input
and no URL or token field, a refusal is the service's own sentence with the name
still on screen and the conversation still shown, an unreachable service says so
in one sentence, and the self-hoster's form appears only when asked for.

## Released, and what live shows today

`fiddy.fun` serves `1d993e32c396623a4b15e7b6ee0a30fd2176bd29` (released on
2026-10-22 with `scripts/release-client.sh`; the served bundle was byte-identical
to the build, rollback target `5d77be6e…`). The chunk the agent surface lives in
(`assets/AgentPage-C6C6Fm2n.js`) is byte-identical to the build too, and carries
the owner-session path, the _"I run my own agent service"_ copy and every
sentence above.

**The server half is not deployed, and the surface says so.** Written with the
client: `legitmate-farcaster` main is `70678fa` (PR #3, CI success) — but
`/opt/fiddy-auth/releases/<sha>` still stops at the staged build, and the live
vhost has no location for the route. Measured the same day:

```
curl -X POST https://fiddy.fun/api/fiddy/owner-session
→ 404, text/html, nginx's own page
```

So a signed-in owner whose setup names the built-in brain currently sees
_"The agent service did not answer. Nothing was changed — you can try again, or
pair your own."_ over the chat and the pre-login conversation: no form, no
spinner, no invented session. The nginx location `/api/fiddy/trial-chat` needs
covers this route as well, and `/api/agents/*` needs a proxy or CORS for the
minted session to be usable afterwards. That decision is the topology card
(`t_bf774a5b`), which owns it and now carries this measurement.
