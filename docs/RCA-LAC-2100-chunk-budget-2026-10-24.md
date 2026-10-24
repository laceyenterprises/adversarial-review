# LAC-2100: load-scaled chunk allocation exceeded its own cap

At 2026-10-24T10:07:49Z, reviewer pass 47170 for agent-os#9084, head
`6b57e9479fb0cb6a5562a2b011b334b42495a3ee`, refused before model invocation:

```text
reviewer-chunk-budget-exceeded chunks=6 perChunkTimeoutMs=5228727
requiredMs=31492362 capMs=21600000 promptBytes=694487
```

The full prompt exceeded its 233,440-byte delivery budget. The supported
`gemini-chunks` route produced six chunks, then the timeout planner rejected its
own allocation. This establishes an admission failure, without evidence of a
model-quality failure or provider outage. A completed review and native
remediation already existed. The issue's later operator comment records the
independent rescue and normal merge of #9084; this change neither owns nor
modifies that PR.

## Evidence and contract trace

Sources: [LAC-2100](https://linear.app/laceyenterprises/issue/LAC-2100), its rescue
follow-up, and the local [prompt/timeout contract](../README.md#oversized-reviewer-prompts),
[review lifecycle](STATE-MACHINE.md), [load-aware runbook](RUNBOOK-ama-closure.md#load-aware-operational-waits-loadar-01)
and [wait inventory](load-aware-wait-inventory.md). The issue identifies read-only
historical evidence in `reviewer_passes`, `reviewed_prs` and
`/private/tmp/os-rescue-20261024-1030/owners-start.json`; no live database or queue
was inspected or mutated for this implementation.

HCP memory searches for the symptom and then the confirmed chunk/process-slack
scope returned available with no matching records. Linear shared field notes
were unavailable (`get_agent_context: Tool not found`); the issue and local
contracts supplied the investigation context. The injected terminal-PR,
authoritative ownership, finding-remediation and strict-loader parity scars
were reviewed. No config keys, ownership rules or merge paths change.

`resolveReviewerTimeoutMs` starts from a nominal 1,200,000 ms. Gemini print
starts from 1,140,000 ms. Each resolves through the shared load-aware helper
once; `resolveAgyReviewerSubprocessTimeoutMs` takes the maximum of the effective
reviewer timeout and effective print timeout plus fixed 30,000 ms subprocess
slack, then clamps to Node's timer limit. Load policy normally permits 1–6x
and supports a configured maximum up to 20x. The observed 5,228,727 ms is
consistent with an effective 4.3572725x reviewer budget; that does not establish
the historical CPU sample or host policy, which were not captured here.

The old planner multiplied this already-scaled per-call budget by every chunk
and added 120,000 ms chunk-loop slack. Its separate six-hour cap was deliberately
unscaled. At six chunks the requested 31,492,362 ms exceeded 21,600,000 ms, so
it threw terminal exit 77 before credential checkout. Even three default chunks
at maximum 6x load could refuse. The size splitter and time allocator therefore
disagreed about which supported reviews could run. This is deterministic
arithmetic; no concurrent claim race is required to reproduce it.

## Bounded correction

For chunk count `N`, requested load-scaled call budget `R` and existing cap `C`:

```text
requiredMs = N * R + 120000                   # unchanged sizing diagnostic
perChunkTimeoutMs = min(R, floor((C - 300000 - 120000) / N))
timeoutMs = N * perChunkTimeoutMs + 120000    # actual chunk-loop deadline
process timeout = timeoutMs + 300000         # fits C, no second scaling
```

Both slack allowances retain their existing values. Integer division leaves
less than `N` ms unused when capped. At the observed size/load, each of six
calls receives 3,530,000 ms; the loop receives 21,300,000 ms and the process
21,600,000 ms. Unconstrained plans retain their prior per-call and loop budgets.
Requested budgets are maxima for the aggregate allocator; saturation can reduce
even nominal per-call budgets, including explicit overrides. All configured
caps still pass through the existing Node timer ceiling.

The plan retains prompt bytes and unconstrained `requiredMs`, adds
`requestedPerChunkTimeoutMs`, and reports allocated deadlines. An envelope
unable to grant a positive millisecond to every chunk after both slacks still
refuses before checkout as terminal `reviewer-chunk-budget-exceeded`, with
`minimumCapMs = N + 420000`. That diagnostic describes feasibility, not permission
to increase caps. Prompt/context size or an undersized local configuration must
be addressed within existing limits.

The harness consumes this same plan for its aggregate abort timer and each
Gemini call. Calls retain their existing shared retry/credential budget and
abort handling. The reviewer process forwards the plan over existing IPC;
the CLI-direct parent validates it, persists only the matching active open
session's lease before extending its timer, and orphan recovery reads that
persisted process budget. Process deadlines remain anchored to process start;
the five-minute preparation/posting allowance is not renewed when the plan
arrives. Preparation exceeding that allowance can still hit the outer deadline.

Sibling sites were traced: the planner has one production caller in
`reviewAgyOversizedInChunks`; `reviewer.mjs` re-exports its harness API. Process
deadline, parent runtime, lease and orphan consumers already accept the bounded
shape without rescaling. Single-call Gemini/Argus fallbacks retain their current
budgets. Unknown/live ownership, terminal-PR guards, cross-model routing,
per-chunk reply validation, complete chunk coverage, finding remediation,
current-head checks and merge eligibility remain authoritative. No partial or
timed-out review is accepted as complete.

## Offline validation and limits

Starting commit: `978d2a7c89aec2041e530ed5a9d16b46037382f1`. Before the fix, the new
observed-load fixture failed with the exact reported refusal; the initial
chunk-test run had 12 passes and 5 failures. After correction, the focused
chunk/load/process-deadline run passed all 34 tests. Coverage includes:

- The exact reported budget, prompt bytes, cap and six chunks; a synthetic full
  prompt of 694,487 bytes under a 233,440-byte delivery budget also executes all
  six chunks through the real splitter and allocator with an injected reviewer.
- Loads of 1x, 6x and 20x across 1, 2, 3, 6, 17 and 18 chunks; rounding,
  saturation, Node timer ceiling, minimum feasible cap, finite diagnostics,
  infeasible allocations and invalid chunk counts.
- Allocated per-call deadlines and abort signals, aggregate expiry, native
  retry sharing, credential release, actual saturated IPC/parent budget and
  persisted lease/orphan expiry, stale-session and terminal ownership fences.

There is no new shared mutable state or concurrency algorithm. Existing watcher
claim-loop tests exercise the unchanged claim/dispatch fences; this RCA does not
claim that a single concurrency run proves race freedom. Tests use temporary
config/SQLite, synthetic load, fake clocks and injected subprocess/provider
boundaries. No live queue probes, provider calls, pins, restarts or gate bypasses
were used.

Validation receipts (2026-10-24, all commands bounded and run in the provisioned
adversarial-review workspace):

| Command | Result |
| --- | --- |
| Changed-file ESLint with `--fix` | Exit 0; no warnings/errors or rewrites |
| `node test/run-tests.mjs reviewer-chunk-timeout.test.mjs load-time-regressions.test.mjs reviewer-process-deadline.test.mjs` | 34 passed, zero failures |
| `npm run lint` | Exit 0; zero errors, 148 existing unused-variable warnings |
| `npm test` | Finished in 774 seconds under a 900-second bound: 14,101 passed, two unrelated failures, eight skipped (14,111 total) |
| `npm run typecheck:contracts` | Exit 0 |
| `bash demo/research-finding-walkthrough.sh` | Exit 0; three byte-stable transcript deliveries |
| `node test/run-tests.mjs derived-artifacts.test.mjs` | Baseline investigation: 15 passed, one failed, one skipped |
| `git diff --check` and declaration JSON parse | Passed |

The full suite's two failures are in unchanged `test/derived-artifacts.test.mjs`:
the first declared archive rebuild returned no proof; it passed in the focused
rerun. The build-cancellation test fails because `spawnSync ps` returns `EPERM`,
also reproduced by the focused run. The test file and its implementation files
`src/ama/derived-artifacts.mjs` and `src/ama/primary-change.mjs` are byte-identical
to `origin/main`. No unrelated artifact code or test gates were changed. The
full run passed the changed timeout suites and watcher claim-loop coverage.
These receipts do not claim a green full suite or deployed recovery.

## Deployment acceptance

Publish through ordinary cross-model review. No config flip or migration is
required. After normal deployment, the runtime owner can observe an organically
scheduled oversized Gemini review whose requested allocation exceeds the cap:
record its requested/allocated budgets and confirm agreement between chunk,
process and persisted lease budgets, plus ordinary review completion or timeout.
This observation is declared in `post-merge-verify.json`; it is separate from
offline source validation and grants no live mutation or restart authority.
