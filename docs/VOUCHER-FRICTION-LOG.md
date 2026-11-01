# Fiddy voucher friction log

The single place a voucher's blockers get written down. **One consumer:** the fix task (`t_2e6fcb98`), which must
be able to fix every entry here without interviewing anyone again.

Rule: an entry is worth nothing if it paraphrases. Copy the command and the output exactly as they appeared.

## 1. How entries get in here

Two intakes; the voucher never fills in a form.

1. **Live pairing** (screen-share, call, or a DM thread while they run it): whoever is with them pastes the
   terminal output into the template below, immediately — not from memory afterwards.
2. **Self-report DM.** Send the voucher this block once at the start and ask for it back when they stop:

```
When something breaks, send me back these six lines and nothing else:
1. step: provision / node up / client up / first read / first post
2. the exact command you ran (copy-paste, whole line)
3. the exact output or error (copy-paste, including the few lines above it)
4. what you had already done in that step (e.g. "ran it once before", "changed the disk size")
5. how long you were stuck before you asked
6. what you tried before asking
```

Also capture the environment once, per voucher, not per entry: OS, host/provider, vCPU/RAM/disk, region, and
whether the box was fresh.

## 2. Entry template

```
### F-<n> — <one-line symptom, in the voucher's words>
- step: <0 prereqs | 1 provision | 2 node up | 3 client up | 4 first read | 5 first post>
- voucher: @<handle> (fid <n>)   reporter: <agent | owner>   date: <YYYY-MM-DDTHH:MMZ>
- environment: <OS, host, vCPU/RAM/disk, region, fresh or reused>
- command: `<exact command, verbatim>`
- output: `<exact output/error, verbatim, including the line before it>`
- time_to_symptom: <how long after starting the step this appeared>
- time_to_unblock: <how long the voucher was stuck>
- workaround: <exact steps that got them past it, or "none — run stopped here">
- severity: P0 <run stopped> | P1 <cost >15 min, or produced a wrong result> | P2 <annoying> | P3 <cosmetic>
- status: open | fixed <commit> | verified-by-voucher <date>
```

Severity is about the voucher's run, not about how hard the fix is. A wrong `200 GB` disk number is P0 for the
voucher even though it is a one-line fix.

## 3. Live entries

| # | date | voucher | step | command | exact output | stuck | severity | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | *no voucher has started yet (2026-10-18)* | — | — | — |

## 4. Pre-seeded candidates — what to watch for, verbatim

These are already known from the campaign's trip-point log (`docs/VOUCHER-CAMPAIGN.md` §5) and the microsite
re-check. When a voucher hits one, the entry above gets the voucher's own command and output — that is what turns
"we think this is a problem" into "a human was stopped by this at 14:32".

| # | Trip point | State before the voucher | Watch for |
| --- | --- | --- | --- |
| P0 | Tutorial and `provision.sh` said **"200 GB SSD"**; the protocol needs **1.5 TB** (repo README) / **2 TB** (snapchain docs) free, and 200 GB is only the snapshot download | **fixed before any voucher ran** — the live page now reads `4 vCPU, 16 GB RAM, 1.5–2 TB free disk` and "The mainnet snapshot is ~200 GB" (`8374eed`, re-checked live 2026-10-18). If a voucher still reports a 200 GB requirement, it is a regression on a different surface and gets an entry | the exact `df -h` line and how far the snapshot got |
| P1 | Menu quoted **~$100/mo** AWS; the real figure at 2 TB is **~$285/mo** | **fixed before any voucher ran** — the page now quotes `$285/month (instance ~$121 + 2 TB gp3 ~$164)` and `$50–80/month` for the cheaper 2 TB hosts (`8374eed`). Watch for a voucher who priced it from an older mirror or a cached page | their reaction in the DM; quitting over cost is a `dropped` row, not a friction entry |
| P2 | The brief's stale claims (read nodes "do not accept writes", app keys cost "one small Optimism transaction") | open by design — the tutorial states the brief's assumption and then shows the current behaviour, with citations | which text they trusted and what they typed |
| P3 | Block pruning is read-nodes-only and **off by default**, so the disk does not shrink by itself | open | their disk growth over time |
| P4 | **No Farcaster write credential exists on this machine**, so DMs and casts are owner-only | open — recruitment stalls until the owner sends | not a voucher entry; tracked in `docs/VOUCHER-OUTREACH.md` §1 |
| — | Cloudflare rewrote the sample `--ssh ubuntu@…` command on the live page | fixed 2026-10-18 (`358111f`); the page serves `ubuntu&#64;203.0.113.10` and no `__cf_email__` remains | a voucher reporting a broken sample command is a regression: log it |

## 5. Closing the loop

- Every entry gets a fix commit or a written, justified deferral in the fix task's closing status.
- After a fix, the same voucher is asked to retry **only that step** and confirm; the entry's status becomes
  `verified-by-voucher <date>` with the voucher's own one-line confirmation.
- Entries never get deleted. If an entry turns out to be a misdiagnosis, add a line saying so and who checked.