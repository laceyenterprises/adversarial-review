---
title: "INCIDENT: ACPX Codex exec Bootstrap Regression (2026-04-21)"
date: 2026-04-21T10:08:00Z
severity: high
status: resolved
---

## Summary

ACPX 0.3.1 + Codex environment combination exhibited bootstrap failure on this machine. The Codex ACP session creation path hung at the initialization phase, preventing any reviews from completing.

**Status:** Resolved by reverting to native Codex CLI invocation (which is stable and produces quality reviews).

## Symptoms

When invoking Codex via ACPX:

```bash
acpx --cwd <rundir> --approve-all codex exec -f <promptfile>
```

Process output:

```
[client] initialize (running)
[client] authenticate (running)
[client] session/new (running)
```

Then: timeout, exit code 3 or process hang. No error, no artifact, no completion.

## Diagnostics

### Scope
- **Not reviewer-specific:** Minimal repro with trivial prompt produced identical hang
- **Not auth-specific:** OAuth file was valid (auth_mode: chatgpt, tokens present)
- **Not prompt-specific:** Even one-line prompts hung
- **Not file-handoff-specific:** Hang occurred before artifact-write phase
- **Root cause:** ACPX → Codex ACP session bootstrap itself

### Reproduction (minimal repro)
```bash
TEMP=$(mktemp -d /tmp/acpx-codex-min-XXXXXX)
echo 'Reply with exactly: OK' > "$TEMP/prompt.txt"
/Users/airlock/.openclaw/tools/acpx/node_modules/.bin/acpx \
  --cwd "$TEMP" \
  --approve-all \
  --timeout 60 \
  codex exec -f "$TEMP/prompt.txt"
# Result: Timed out after 60000ms, exit 3
```

### Known state
- ACPX version: 0.3.1
- Codex OAuth: valid (chatgpt mode, active tokens)
- Codex CLI: works standalone for other tasks
- Last known working: commit `46ab8e3` (but that used simpler invocation: `acpx codex exec -f ...` without `--cwd`)

## Resolution

**Decision:** Revert to native Codex CLI invocation. Not a regression we need to fix right now; the native path is stable and proven.

### Why revert (not debug further)
1. **Debugging ROI:** Hours spent on ACPX bootstrap; root cause is likely ACPX/Codex version mismatch or environment config issue beyond our control
2. **Time sunk:** Spent 09:20–10:08 debugging Codex CLI stdin behavior, ACPX invocation shapes, temp-dir isolation — all pointing back to the same ACP bootstrap issue
3. **Stable alternative:** Native Codex CLI (`codex exec --output-last-message`) is working and produces quality reviews
4. **Durable lessons:** Auth validation, output junk detection, and queue collision safety all captured and kept

### Changes in commit `9ca7c31`
- Removed ACPX invocation layer entirely
- Simplified to: `codex exec --output-last-message -` (stdin prompt, stdout output)
- Fixed OAuth validation to read auth.json directly (no CLI probe fallback)
- Aligned Codex principal explicitly to `/Users/placey` (OAuth owner)
- Added `looksLikeRuntimeJunk()` filter to reject `[client]` init spam
- Kept follow-up job collision safety from `cb0f179`
- All 28 tests passing

## Future (Control Plane)

ACPX/Codex session bootstrap issues (and principal alignment problems) will be solved at the architecture level once the control plane credential broker / worker grant system ships.

For now: use native Codex CLI (stable, working, produces high-quality reviews) and document the ACPX issue for later revisit when ACPX / Codex ACP integration is mature.

## References

- Summary notes: `/Users/airlock/agent-os/agents/clio/workspace/memory/2026-04-21.md`
- Runbook: `/Users/airlock/agent-os/docs/RUNBOOK-codex-invocation-contracts.md`
- KB: `/Users/airlock/agent-os/knowledge/agents.kb/operators/using-codex.md`
- Control plane spec: `/Users/airlock/agent-os/docs/SPEC-model-routing-auth-principals-and-worker-credential-broker.md`
