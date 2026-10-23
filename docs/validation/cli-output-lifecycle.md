# CLI output lifecycle — LAC-2094

The terminal `process.exit(await main())` in `bin/merge-lease.mjs` ran after
`jsonLine` queued `stdout.write()`. Pending asynchronous pipe writes were lost.
Setting `process.exitCode` preserves the command result while allowing Node to
finish writes and surface asynchronous output errors. No buffer is increased.

The supplied incident artifacts were inspected only for byte counts and JSON
validity; no artifact contents or live secrets are copied here. Both
`merge-status-pipe-{0,1}.json.txt` artifacts contain 65,536 bytes and fail parsing
at byte 65,536. `merge-status-regular-file.json` contains 331,258 bytes, valid
JSON, and 1,682 attempt records. The summary artifact is valid JSON. These are
read-only incident evidence, not test fixtures or recovery acceptance.

## Hermetic causal proof

`node test/run-tests.mjs cli-output-lifecycle.test.mjs` uses disposable synthetic
lease files, real child processes, regular-file descriptors and OS pipes. Children
receive a minimal environment without inherited credentials or production roots.
Each child is killed/reaped by a 15-second subprocess deadline; the unread-pipe
case uses a 1.5-second deadline. No GitHub, network, host service or live mutation
is involved.

The 24,000-attempt fixture emits 4,597,004 bytes, well above pipe capacity. A
legacy control imports the production `main` and retains precisely the old
forced-exit wrapper. It exits 0 after only 131,072 bytes on a slow pipe on the
worker host, but writes complete JSON to a regular file. The byte cutoff is
platform-dependent and is deliberately not asserted. Before the fix, the actual
`status` and `list` entrypoints each exited 0 with a parse failure at byte 65,536;
the closed-pipe test also failed because the command returned 0.

With the fix, both aliases deliver byte-for-byte expected JSON to fast pipes,
slow pipes and regular files, including every attempt record; fixture store
bytes remain unchanged. A closed pipe reports EPIPE/nonzero. A consumer that
never reads is still killed by its caller deadline. Real child invocations also
verify usage 64, parked 70, contention 75, and corrupt-input 75 with a diagnostic.
The deliberately broken legacy control remains in the suite to establish the
cause alongside the fixed production entrypoints.

## Sibling sweep and scope

The sweep searched `bin/**/*.mjs` and `src/**/*.mjs` for `process.exit(` and
inspected the output/termination paths.

| Surface | Disposition |
|---|---|
| `bin/merge-lease.mjs` | Natural exit; large status/list and error fixtures. |
| `bin/ama-check.mjs`, `bin/ama-audit.mjs` | Same terminal main-wrapper fix; existing eligibility/audit tests preserve results. |
| `bin/rereview-wake.mjs` | Same fix; real large-backlog slow-pipe regression, preserving existing sampling semantics. |
| `bin/watcher-wake.mjs`, `bin/quota-rearm.mjs` | Same fix; existing wake/rearm tests cover mutations/refusals. The rearm DB is already closed in `finally`. |
| `src/retrigger-review.mjs`, `src/retrigger-remediation.mjs` | Same finite-main wrapper fix, including retrigger-review rejection diagnostics; existing operator tests cover results. |
| Other finite CLI success paths using `process.exitCode` or natural return | Already drain; unchanged. |
| `bin/load-aware-timeout.mjs` fallback and `ama-rebase-authority`/`ama-clobber-guard` usage helpers | Deliberately excluded: bounded scalar/help output and mid-function termination control, not unbounded terminal main output. Converting these requires separate control-flow work. |
| Other `bin/` early validation/failure exits (`dispute-finding`, `ci-cost-check`, `ci-bootstrap`, `guard-forbidden-paths`, `hammer-base-head`, `hammer-head-context`, `merge-commit-body`, `hammer-procedure`, `hammer-context`, `primary-change-context`) and `merge-action-receipt` no-op | No successful large stdout write followed by forced exit; excluded from this terminal-output fix. Small error diagnostics retain their existing behavior. |
| `src/secret-source/resolve-op-token-cli.mjs` | Credential bootstrap contract, deliberately excluded; never invoked with live secrets. |
| Reviewer/watcher/follow-up shutdown, cancellation and fatal-error exits; reviewer deadline/fence helpers | Long-lived worker termination contracts, not finite CLI result completion; changing them could retain processes/leases. |
| `src/reviewer-token-ledger-worker.mjs` | IPC worker exits from the `process.send` callback, after send completion; not stdout JSON. |

All changed sibling entrypoints also run under bounded child-process help probes
to detect retained handles. No CI jobs, triggers, gates or runners are added.

## Contract and acceptance boundary

There is **no persistent-schema/model delta**, config-loader delta, durable
status delta, state-machine transition delta, or smoke-promise delta. Public
JSON fields, audit history, exit-result codes, internal subprocess bounds,
merge eligibility and FIFO lease ownership retain their existing contracts.
Only terminal output completion changes. No declaration/index regeneration is
needed. The existing runbook governs the output contract.

HCP memory searches for stdout/forced-exit truncation and sibling operator
receipts returned no matching records. Linear `get_agent_context` returned
`Tool not found`; local source/runbooks and the retrieved issue supplied context.
Source tests and PR publication do not deploy code or prove live recovery.
LAC-2094 remains nonterminal pending its separately accepted recovery proof.
