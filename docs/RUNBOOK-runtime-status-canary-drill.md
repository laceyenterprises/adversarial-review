# Runbook — hybrid runtime status, fallback canary, and failover drill (ARC-09)

The hybrid agent runtime (ARC-05/06/07) runs reviews and remediations through
the Agent OS worker pool (`os` mode) and automatically fails over to a local
spawn (`local` mode) when the OS endpoint goes dark, resuming automatically when
it returns. ARC-09 adds the three surfaces that keep that lifeline honest and
observable:

1. **`runtime status` CLI** — the operator's truthful view of the runtime.
2. **Fallback canary** — a scheduled synthetic review through the `local`
   runtime that pages if the lifeline has rotted.
3. **Failover drill** — a sandboxed rehearsal of the full failover/resume cycle
   that proves zero duplicate dispatches.

## `runtime status`

```text
$ node src/cli.mjs runtime status
mode: os          since: 2026-07-17T09:12:04Z
probe: healthy     (healthz ok, dispatch p95 412ms, sse live)
last failover: 2026-07-16T22:41:10Z -> local  (3 probe failures)
last resume:   2026-07-17T09:12:04Z -> os     (6 healthy probes / 5m)
runs (24h): os=41 local=7   reconciled-on-resume: 2 adopted, 0 duplicated
fallback canary: PASS 2026-07-17T06:00:12Z (local fixture review, 94s)
```

Flags: `--root <dir>` (defaults to cwd), `--window <24h>` (run-count window),
`--json` (machine-readable model).

It is **read-only** and reads only durable artifacts, so it works from any
process (it never reaches into the daemon's memory):

| Line | Source |
|---|---|
| mode / since / probe | `data/runtime-status-snapshot.json` (router-owning loop persists `router.status()` each probe tick) |
| last failover / resume / reconcile | `data/runtime-router-audit/YYYY-MM.jsonl` (ARC-07 transition audit) |
| runs (24h) by mode | `data/runtime-runs/YYYY-MM.jsonl` (run-ledger) |
| fallback canary | `data/runtime-canary-status.json` (canary) |

Missing artifacts degrade gracefully: no snapshot → `probe: unknown`, no
transitions → `none`, no canary → `never run`. The surface never asserts state
it cannot see.

### Wiring the run-ledger and snapshot in production

`src/adapters/agent-runtime/run-ledger.mjs` exposes
`wrapRuntimeWithRunLedger(runtime, { rootDir, mode })` — decorate each runtime
before handing it to the router so every settled run is counted by the mode it
actually finished in. `src/runtime-status-snapshot.mjs` exposes
`persistRouterStatus(rootDir, router)` — call it from the router probe loop so
the CLI's live lines stay fresh.

## Fallback canary

`scripts/adversarial-runtime-canary.mjs` drives one synthetic review through the
`local` runtime, asserts a well-formed verdict came back, writes the canary
status file, records the run, and **pages on failure**
(`event: runtime.canary.failed`). Exit code: `0` PASS, `1` FAIL.

- `--fixture` (default): hermetic — canned fixture reviewer, no CLI spawn, no
  network. Proves the runtime port + admission + verdict-parse + status-file +
  alerting path. This is what CI runs.
- `--live`: real `createLocalAgentRuntime` (real reviewer CLI spawn) so the
  canary detects genuine rot. Requires a host with the reviewer CLI authed.

Scheduled daily at 06:00 by
`launchd/ai.laceyenterprises.adversarial-runtime-canary.airlock.plist`. Flip the
plist argument from `--fixture` to `--live` once the real reviewer spawn is
production-wired end to end (ARC-08+).

## Failover drill

`scripts/adversarial-runtime-failover-drill.mjs` exercises the **real ARC-07
health router** through a full cycle in an in-memory sandbox:

1. dispatch a run while healthy (OS mode, pending key tracked);
2. **kill** OS connectivity → assert failover to `local` after `k` probes;
3. assert new work runs `local` during the outage (no OS dispatch);
4. **restore** connectivity → assert resume to `os` after the hysteresis window;
5. assert resume **adopted** the pre-failover key via `dispatch_status` with
   **zero duplicate dispatches**, then dispatched fresh.

**Safety:** the drill has no live-endpoint mode — the only session is an
in-memory fake — so it is safe in CI. Pass `--root <dir>` to leave the audit
trail + status snapshot behind, then run `runtime status --root <dir>` to see
the failover/resume you just rehearsed.

Both the canary (fixture) and the drill run as CI gates in
`.github/workflows/test.yml`, in addition to their unit tests
(`test/agent-runtime-canary.test.mjs`, `test/agent-runtime-failover-drill.test.mjs`,
`test/agent-runtime-run-ledger.test.mjs`, `test/runtime-status-cli.test.mjs`).
