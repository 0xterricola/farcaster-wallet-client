# "Add a brain" — the client half

Status 2026-10-21. The sheet is one component used in two places, so a screen
cannot say one thing on the way in and another afterwards:

| where | route |
| --- | --- |
| step 1 of the setup flow (with the agent's name, on one screen) | `/welcome/name` (`fiddyWelcomeName`) and `/welcome/brain` (`fiddyWelcomeBrain`) |
| the Agent screen's own page | `/brains` (`fiddyBrains`) |

The setup flow is two steps: the greeting (no number), **step 1 of 2** — the
name and this sheet on one screen, with Fiddy's built-in brain already picked so
the step can be finished in one press — and **step 2 of 2**, the ready screen.
`/welcome/name` and `/welcome/brain` are two addresses for that one step, so an
older link to the brain half still lands on the picker rather than on a screen
that no longer exists. The apps step that used to sit between them is gone:
`/welcome/apps` redirects to the last step, and connecting apps lives at
`/~/agent/apps` inside the shell, where a channel can actually start working.

Both are reachable signed out as well as inside the shell, because choosing a
brain needs no account.

## What the cards are

| card | what the owner brings |
| --- | --- |
| **Fiddy** — "Works out of the box — Fiddy's built-in brain" | nothing |
| **ChatGPT** (OpenAI) | one key, one model name |
| **Claude** (Anthropic) | one key, one model name |
| **Gemini** (Google) | one key, one model name |
| **OpenRouter** | one key, one model name |
| **Nous Portal** | one key, one model name |
| **Your own AI service** | an address, a key, a model name |

An account card never asks for an address: the address is ours, it is shown on
the card (`api.openai.com` and so on), and the agent service fills it in itself.
`"Your own AI service"` is the only card with an address field, and it is the
only place the three fields appear in that order — address, key, model — so the
sentence a missing field produces matches the field it is about.

## What happens when the owner presses a button

**Test connection** asks the agent service to read the service's model list once
(`POST /api/agents/brains/probe`). It runs on the service, not in this browser,
because the big providers answer a page's cross-origin request with no CORS
headers at all — a browser-side check would fail for every owner and blame their
perfectly good key. When the service lists models, the sheet offers them as
picks, so nobody has to guess a model name.

**Use this brain** / **Save this choice** depends on whether the client is paired
with an agent service:

- paired: it points the chosen agent at the chosen service for real
  (`PUT /api/agents/instances/:id/brain`) and says which agent changed. The
  agent list comes from the service; a failure to list is not an error on this
  screen, it just means the sheet cannot apply anything yet;
- not paired (this is also the setup step): the choice is kept on this device and
  the copy says exactly that.

## The key

The key is component state. It is sent to the agent service for the check and for
the apply, and it is never written to the setup file, to browser storage, or to
any copy on the screen — `saveFiddySetup` writes a whitelist of fields, so a
caller that passes a key by mistake cannot smuggle it in, and
`src/lib/__tests__/fiddySetup.test.ts` asserts exactly that.

`src/lib/fiddySetup.ts` does keep the service address and the model name, which
is what makes "come back to this step" honest. Older builds' answers are carried
forward rather than reset: `claude` → `anthropic`, `gemini` → `google`,
`other` → `custom`.

## What the words may not say

The sheet is product copy: no `api key`, no `endpoint`, no `bearer`, no
`protocol`, no `scope`, no `node`. The key field is "The key it gave you", the
address field is "Its address", the model field is "Which model?". Failures say
what failed: a refused key says the key was not accepted, a private address says
the address is on a private network and to use the public one, a service that
publishes no model list says so and says it may still work.

## Verification

| claim | where |
| --- | --- |
| the cards, the fields per card, the plain words, the storage that is and is not written | `src/components/fiddy/__tests__/BrainSheet.test.tsx` |
| the setup file keeps a choice and refuses to keep a credential; older answers carry forward | `src/lib/__tests__/fiddySetup.test.ts` |
| the two service calls, with and without a pairing | `src/lib/__tests__/agentService.test.ts` |
| the sheet in a real browser, on the real route | `apps/farcaster-web/scripts/verify-fiddy-brains.mjs` |
| the way in as a two-step walk, in a real browser: name + brain on one screen, one press to the last step, no apps sheet, and the two old step addresses still resolving | `apps/farcaster-web/scripts/verify-onboarding-two-step.mjs` |

The browser harness is a probe, not a CI gate (the same rule as the other
`scripts/verify-*.mjs` files — they need a running client). It stubs the answer
from the agent service, because that is a different deployment; everything the
client does with the answer is real. The service's own behaviour is verified
against the real route in the control plane repo.