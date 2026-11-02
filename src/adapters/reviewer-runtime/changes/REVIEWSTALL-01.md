# REVIEWSTALL-01

Native Claude, Codex, Gemini CLI and Antigravity reviewer calls resolve nominal
120-second first-output and 180-second no-progress budgets through
`loadAwareTimeoutMs`, capped by the existing per-call wall ceiling. The ceiling
continues to bound a steadily progressing attempt. No configuration key changes.

Progress uses existing stdout/stderr bytes (including file-size observations for
isolated identities). Claude's rolling watchdog continues to require parsed
stdout stream events; diagnostic stderr alone does not renew it.

The process runner emits one `[reviewer-stall]` JSON receipt when it decides to
terminate: reviewer model/runtime/identity where applicable, invocation start,
first output or null, last progress, decision time, both effective budgets and
the wall ceiling. `[reviewer-stalled]` propagates the transient classification
through the CLI wrapper without an in-process retry or transport fallback.

Existing process-group termination and credential/identity cleanup release the
seat. Runtime and pass records use the existing cancelled status. Settlement
releases the session-fenced claim to pending and uses existing cascade scheduling,
without charging review rounds, review attempts, same-head timeout retries or
infra recovery attempts. No new durable state, lease, gate or CI check.

SRE's next natural stall after deployment supplies the live receipt. Synthetic
fixtures establish the timing, classification, cleanup and requeue behavior
offline; this change declares no post-merge action.
