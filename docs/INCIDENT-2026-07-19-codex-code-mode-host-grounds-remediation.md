# SEV0 — Codex "code-mode host" times out → every default-model codex worker grounded (remediation pipeline down ~2h)

- **Date:** 2026-07-19
- **Severity:** SEV0 (fleet remediation/coding workers unable to execute; operator offline ~2h)
- **Duration of fault:** remediation last succeeded **12:05 UTC**; first failure **13:37 UTC**; detected/root-caused ~16:57 UTC.
- **Duration of MTTR (diagnosis):** ~2h of operator-facing investigation — the expensive part; see "Why it took 2 hours."
- **Status:** mitigated (codex default model pinned to `gpt-5.5`); durable code fix + prevention pending.

## One-line

Codex's **server-default model** began routing tool execution through the **`code_mode_only`** path, whose "code-mode host" (codex's internal `codex_core::tools::router` execution backend) **times out at handshake**. Every codex worker that did **not** pin `--model` (notably the adversarial-review **remediation** direct-spawn) inherited the broken default and could not run a single shell command — so it made no edits, no commits, and **never wrote its `remediation-reply.json`** → the reconciler saw a missing reply → `no-progress` → the remediation pipeline was grounded. Pack/DAG walkers were unaffected because they pin `--model gpt-5.5` (direct exec).

## Symptom (what the operator saw)

- "Remediators failing every time." Every remediation round on every repo stopped `no-progress`, even on clean PRs.
- Reply dirs (`agent-os-hq/dispatch/remediation-replies/<job>/`) were created but **empty** — no `remediation-reply.json`, not even a partial.
- Workers **spawned and ran ~8 min** then produced nothing.

## Root cause (hard evidence)

Live worker log (`…/follow-up-workspaces/…pr-647…/.adversarial-follow-up/codex-worker.log`):
```
ERROR codex_core::tools::router: error=timed out negotiating with the code-mode host
```
codex's own agent messages: *"The execution backend is still unavailable at tool negotiation, including before a shell process can start… I cannot safely perform the required git audit, edits, validation, commit/push, or artifact write."*

Codex binary strings: `"tool_mode": "code_mode_only"`; a family of `code-mode host` handshake/delegate/cell errors — i.e. codex delegates command execution to a spawned "code-mode host" subprocess and negotiates a handshake; that handshake times out.

**The divergence that proved it:**
- Working pack walker: `codex exec --model gpt-5.5 …` → runs commands, lands PRs.
- Failing remediation worker: `codex exec …` with **no `--model`** → uses codex's config/server default → `code_mode_only` → broken host.

Codex itself was unchanged (0.144.1 since 2026-07-09; config since 07-18), so the default's behavior shifted **server-side / at runtime ~12:05–13:37 UTC** — remediation, which never pinned a model, was exposed; anything pinning `--model` was immune.

## Timeline (UTC)

- **12:05** — last successful remediation reply written (agent-os#3942, `reReview.requested=true`).
- **~12:05–13:37** — codex default-model tool routing shifts to the broken `code_mode_only` host (runtime/server-side; not a deploy).
- **13:37** — first `no-progress` (adversarial-review#642); then every remediation, all repos.
- **~15:30–16:57** — investigation (operator escalations); root-caused via live-worker capture at 16:56.
- **16:5x** — mitigation: pin codex default model `gpt-5.5` in airlock `~/.codex/config.toml`.

## Why it took ~2 hours (the real failure — process, not just the bug)

The symptom (`no-progress`, empty reply dir) is **maximally distant** from the cause (a codex-internal tool-host handshake timeout). The investigation chased and **cleared** several plausible-but-wrong hypotheses before reaching the worker's own log:
1. The ARC-19 **decomposition** (my #637/#639) — cleared by a byte-level behavior-fidelity audit (270 tests).
2. **Push-auth** (invalid keyring gh token) — cleared; the daemon's env `GITHUB_TOKEN` is valid.
3. **HDR-02** worker-dir guard removal — cleared; it's a deliberate privilege-boundary fix, not firing.
4. **Reply-path / env / prompt** mismatch — cleared; all resolve correctly; `${REPLY_PATH}` is interpolated at build time.

The decisive move — reading the **live worker's `codex-worker.log`** — was made far too late. **Lesson: when a worker "runs but produces nothing," read the worker's own execution log FIRST, before auditing the orchestrator.**

## Fixes

- **Immediate (applied):** `model = "gpt-5.5"` added to airlock `~/.codex/config.toml` (top-level default). Every default-model codex worker now uses gpt-5.5 (direct exec). Reversible; backup written.
- **Durable (code):** pin `--model <resolved codex class model>` in `spawnCodexRemediationWorker` (adversarial-review) so remediation never rides the codex server-default — matching the pack-walker/hq-dispatch path.

## Prevention / "never relive this"

1. **No codex spawn may rely on the server-default model.** Every `codex exec` invocation in the fleet must pass an explicit `--model` (or `CODEX_MODEL_ID`). Add a lint/CI guard that fails on a codex spawn without an explicit model.
2. **Codex tool-host health check / canary.** A periodic `codex exec "echo OK"` probe that alerts on `code-mode host` / tool-negotiation timeout — this would have flagged the fault fleet-wide in minutes, independent of the remediation symptom.
3. **Remediation liveness alarm.** Alert when `remediation-reply.json` write-rate drops to zero over N ticks while jobs are being dispatched (dirs created, no files) — a direct "workers produce nothing" detector.
4. **Diagnostic runbook:** worker "runs but no artifact" ⇒ read `<workspace>/.adversarial-follow-up/codex-worker.log` first.

## Not the cause (explicitly cleared)

ARC-19 decomposition (#637/#639), the adversarial-review pipeline code, HDR-02, reply-path/token/prompt resolution, the merge-authority path. This was entirely a **codex runtime** fault surfaced by an unpinned model.
