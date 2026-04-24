---
delegation: full
confidence: 0.9
last_verified: 2026-04-05
influence_weight: high
tags: [adversarial-review-hq, spec]
staleness_window: 60d
---
\# Adversarial Code Review System — Spec

\#\# Problem

AI coding agents tend to be sycophantic toward their own output. A Claude-written PR reviewed by Claude will often pass with minimal critique. Same-model review is a rubber stamp, not a quality gate.

A second failure mode is context starvation: reviewing only the diff without the governing specs/runbooks can produce shallow or misleading feedback on architecture-heavy PRs.

\#\# Solution

Enforce adversarial cross-model review: the agent that builds the code is never the agent that reviews it. Claude Code and Codex have different training, tendencies, and blind spots — each will catch things the other misses.

For spec-driven projects, require PR authors to link the governing specs/runbooks/briefs in the PR body or top-level PR comments, and have the reviewer fetch those linked docs and include them as review context.

\---

\#\# Routing Rules

| Builder | Reviewer |  
|---|---|  
| Claude Code (prlt fleet) | Codex |  
| Codex (one-off / Clio-delegated) | Claude Code |  
| Clio sub-agent (Claude) | Codex |

\*\*Default fallback:\*\* If builder cannot be determined, Codex reviews.

\---

\#\# PR Author Detection

Reviewer routing is determined by the PR author identity. Convention:

\- PRs opened by Claude Code → commit author email contains \`claude\` or PR title tagged \`\[claude-code\]\`  
\- PRs opened by Codex → commit author email contains \`codex\` or PR title tagged \`\[codex\]\`  
\- PRs opened by Clio sub-agents → commit author is \`clio@laceyenterprises.com\`

Agent author tagging is the responsibility of the build workflow (prlt or Clio's coding-agent skill).

\---

\#\# Reviewer Prompt (Standard)

All review agents receive this adversarial framing — non-negotiable:

\`\`\`  
You are performing an adversarial code review. You did NOT write this code.

Your job is to find problems. Specifically:  
\- Bugs and edge cases the author missed  
\- Security vulnerabilities (injections, auth gaps, secret leakage, unsafe deps)  
\- Design flaws (wrong abstraction, fragile coupling, missing error handling)  
\- Performance issues  
\- Anything that would fail in production

Do NOT summarize what the code does. Do NOT praise. Be specific and direct.  
For each issue: state the file, line(s), the problem, and the recommended fix.

If you find nothing substantive, say so plainly — but look hard first.  
\`\`\`

\---

\#\# System Architecture

\`\`\`  
GitHub PR opened  
        │  
        ▼  
  PR Watcher (polling or webhook)  
        │  
        ├── detect author → determine reviewer model  
        │  
        ▼  
  Reviewer Agent spawned  
  (adversarial prompt \+ PR diff \+ repo context)  
        │  
        ▼  
  Review posted to GitHub PR as comment  
  (via gh CLI or GitHub API)  
        │  
        ▼  
  Durable follow-up handoff queued  
  (explicit job artifact, pending consumption)  
        │  
        ▼  
  Linear ticket updated: "Review complete"  
\`\`\`

\---

\#\# Components

\#\#\# 1\. PR Watcher  
\- Polls GitHub for new PRs on watched repos (or receives webhook)  
\- Detects author from commit metadata or PR title tag  
\- Triggers reviewer agent with correct model assignment  
\- Runs as a persistent service or cron (interval TBD — suggest 5 min)

\#\#\# 2\. Reviewer Agent  
\- Spawned by PR Watcher via Clio's \`sessions\_spawn\` or \`coding-agent\` skill  
\- Receives: repo URL, PR number, diff, adversarial prompt  
\- Posts review as a GitHub PR comment via \`gh pr review\`  
\- Reports back to Clio when complete

\#\#\# 3\. Author Tagging Convention  
\- All agent-built PRs must include author tag in PR title or commit message  
\- prlt workflow responsible for Claude Code tagging  
\- Clio's coding-agent skill responsible for Codex tagging  
\- Format: \`\[claude-code\]\`, \`\[codex\]\`, \`\[clio-agent\]\`

\#\#\# 4\. Linear Integration  
\- When a PR is reviewed, update the associated Linear ticket status  
\- Ticket transitions: \`In Review\` → \`Review Complete\`  
\- If reviewer finds critical issues: flag ticket for Paul's attention

\#\#\# 5\. Follow-up Handoff Queue (first slice)
\- After a GitHub review post succeeds, write a durable JSON job under \`data/follow-up-jobs/pending/\`
\- Record repo, PR number, reviewer model, review summary/body, criticality, and recommended follow-up action
\- Keep the handoff explicit and append-only; do not hide it behind undocumented local hooks
\- This queue is the minimal bridge until session-aware continuation exists natively

\#\#\# 5\.1 Follow-up worker completion reconciliation (bounded next slice)
\- A detached remediation worker launch must not be treated as terminal queue success by itself
\- The queue must expose explicit terminal states for launched remediation work: \`completed\` and \`failed\`
\- Reconciliation may remain one-shot/manual in this slice; it does not need a new long-running daemon
\- Current bounded contract:
\- inspect only \`in_progress\` jobs whose \`remediationWorker.state\` is \`spawned\`
\- if the recorded worker PID is still live, leave the job \`in_progress\`
\- if the PID is gone and the recorded final-message artifact exists with non-empty content, move the job to \`completed\`
\- if the PID is gone and the final-message artifact is missing or empty, move the job to \`failed\`
\- Reconciled terminal records must preserve operator-visible metadata: worker PID, workspace path, log path, final-message path, and a short completion preview or explicit failure reason
\- This slice preserves wrapper-owned review completion semantics; it does not grant the remediation worker ownership of the GitHub review side effect

### 5.2 Remediation worker launch contract (new hardening requirements)
- A detached remediation launch must not treat "process spawned" as equivalent to "durable worker established"
- Required control-plane distinctions:
- launch command issued
- worker/session registration created
- startup receipt emitted
- transport/attach healthy
- active progress observed
- terminal outcome recorded
- Minimum hardening requirements for remediation workers:
- preflight contract before launch covering repo / PR / branch target, runtime path, cwd, auth principal, lane classification (`builder` vs `integration`), normalized publish remote, and expected edit / commit / push / PR reply authority
- startup receipt within a bounded timeout; if no receipt arrives, classify as launch failure rather than leaving the run ambiguously spawned
- durable launch metadata recording the exact launch shape, expected artifact paths, and timeout semantics so failures remain diagnosable after wrapper death
- progress evidence beyond PID existence; PID-only liveness is insufficient as a durable success signal
- explicit failure classification separating launch failure, attach/transport failure, permission-blocked worker, artifact-missing completion, and successful completion
- Ticket mapping:
- `LAC-207` should not be considered production-complete if success still effectively means only "spawned a detached process"
- `LAC-208` should carry the durable per-PR / per-run ledger state needed to model the distinctions above
- `LAC-209` and `LAC-210` should build on explicit terminal and reply states rather than implicit worker disappearance
- `LAC-212` should document the operator-visible meaning of each state plus the manual recovery path

\#\#\# 6\. Review completion semantics (current vs target)

\*\*Current implementation: A semantics (wrapper-owned completion)\*\*
\- reviewer runtime generates review text/artifact
\- outer wrapper captures the final output artifact
\- wrapper posts the PR review comment itself
\- wrapper then writes the durable follow-up handoff artifact

This is true whether the substrate is direct CLI, ACPX, or another sessionful runtime. The current production question is operational reliability, not semantic impossibility.

\*\*Target future architecture: B semantics (delegated-worker-owned completion)\*\*
\- delegated job/session owns the completion side effect directly
\- outer orchestration layer trusts explicit completion artifacts/events instead of scraping final output and manually replaying the PR comment
\- session/job ownership, retries, and auditability become first-class contracts rather than wrapper convention

\*\*Operational lesson from 2026-04-20/21 debugging\*\*
\- we lost time pushing toward B-shaped behavior while debugging ACPX/Codex invocation mechanics
\- the faster restore path was to preserve the known-good A-style review-post contract and swap only the transport/auth layer underneath it
\- file-based final-output handoff is a valid A-style bridge when using sessionful Codex/ACPX substrates

\---

\#\# Repos in Scope (Initial)

\- \`laceyenterprises/clio\` — this repo  
\- prlt (Proletariat) fleet repos — https://github.com/chrismcdermut/proletariat (TBD when prlt is live)  
\- Any repo where Clio delegates a coding agent task

\---

\#\# GitHub Bot Accounts

Reviews are posted by dedicated bot accounts — not Clio's personal account — so the reviewer identity is visible in the PR timeline.

| Bot Account | Posts Reviews For |  
|---|---|  
| \`codex-reviewer\` | PRs built by Claude Code |  
| \`claude-reviewer\` | PRs built by Codex or Clio sub-agents |

\#\#\# Setup Prerequisites  
\- Create two GitHub accounts: \`codex-reviewer\` and \`claude-reviewer\`  
\- Add both as members of the \`laceyenterprises\` org with write access to covered repos  
\- Generate a personal access token (PAT) for each with \`pull\_requests: write\` scope  
\- Store tokens in 1Password (Cliovault): items \`"GitHub Bot — codex-reviewer"\` and \`"GitHub Bot — claude-reviewer"\`  
\- Wire tokens into the reviewer agent config via \`op://\` references

\---

\#\# Out of Scope (v1)

\- Human code review — this system is agent-to-agent only  
\- Auto-merge on clean review — Paul merges manually  
\- Multi-round review cycles — one review pass per PR in v1  
\- Review of PRs Paul opens himself
\- Resuming the original build session with full context preservation (target future architecture, not tonight's slice)

\---

\#\# Codex runtime debrief note (2026-04-21)

For this system on laceyent-mbpro, the durable Codex runtime contract is now:
- long-running watcher runs as `placey`
- Codex prompt passed as argv, not stdin
- `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --output-last-message <file>`
- outer wrapper remains responsible for validation + GitHub posting

Explicit anti-patterns from the PR #19 debugging session:
- mixed-principal `airlock` watcher with borrowed `placey` auth path as the main resident contract
- stdin-fed prompt transport as the default noninteractive path
- accepting scary stderr as fatal without checking the output artifact/body
- appending wrapper template sections after an already-complete Codex review body

See also: `docs/POSTMORTEM-codex-cross-user-invocation-2026-04-21.md` and `docs/RUNBOOK-codex-invocation-contracts.md`.

\#\# Open Questions

1\. \*\*Webhook vs polling?\*\* Webhook is more responsive but requires a public endpoint (or ngrok/Tailscale tunnel). Polling is simpler for now — revisit when prlt is live.  
2\. \*\*What repos does the watcher cover?\*\* Start with \`laceyenterprises/clio\` only, expand to prlt repos when ready.  
3\. \*\*Codex API access\*\* — confirm Codex is accessible via OpenAI API for spawned reviewer agents (it is, via litellm-local).  
4\. \*\*Max concurrent reviews\*\* — respect the 2–3 parallel agent limit from WORKING\_INSTRUCTIONS.md.

\---

\#\# Dependencies

\- \`gh\` CLI configured with \`laceyenterprises\` org access  
\- Codex reviewer path available locally (current working implementation uses native Codex CLI / ACPX execution, not just a generic model alias)  
\- Claude Code available via \`litellm-local/claude-sonnet-4-6\`  
\- Linear API configured (\`\~/clio/credentials/local/linear.env\`)  
\- prlt (Proletariat, https://github.com/chrismcdermut/proletariat) — future dependency, not required for v1

\#\#\# Codex reviewer auth contract
For Codex-backed review workers, OAuth identity selection must be treated as part of the runtime contract.

Required rules (current operational patch):
\- do not trust ambient \`codex login status\` from the launching user alone
\- validate the intended \`auth.json\` directly and require \`auth_mode: chatgpt\`
\- pass \`CODEX_AUTH_PATH\` explicitly when the intended Codex principal is not the launch user's default local state
\- keep worker \`HOME\` compatible with the local GitHub/runtime context needed by the wrapper
\- strip \`OPENAI_API_KEY\` from the subprocess environment so Codex does not silently prefer API-key auth

Observed incident/fix sequence (2026-04-20):
\- \`airlock\` local Codex state reported \`auth_mode: apikey\`
\- valid OAuth state existed at \`/Users/placey/.codex/auth.json\`
\- initial patch path copied/staged auth into \`airlock/.codex\`, which still produced a broken execution path in the watcher
\- durable operational fix for the watcher/reviewer pipeline was the split contract:
  \- \`HOME=/Users/airlock\`
  \- \`CODEX_AUTH_PATH=/Users/placey/.codex/auth.json\`
\- this allowed \`gh\` to work from the launch user's normal environment while forcing Codex to the correct OAuth principal

Architectural direction:
\- this split-contract patch should be treated as a compatibility bridge
\- long term, the spawner/worker should receive a native principal grant/materialized auth view from the routing/broker layer and should not need to care about user-home path trivia
\- the normal block reason should be principal unavailability / reauth / allowance exhaustion, not incorrect auth-path selection

\---

\#\# Success Criteria

\- \[ \] Every agent-built PR in covered repos gets a review from the opposing model within 10 minutes  
\- \[ \] Review is substantive (adversarial prompt enforced — no empty approvals)  
\- \[ \] Author detection works reliably from PR title tags  
\- \[ \] Linear ticket updated on review completion  
\- \[ \] Successful review posts create a durable, explicit follow-up handoff artifact  
\- \[ \] Paul can see all pending/completed reviews from Linear

\---

\#\# Next Steps (post-approval)

1\. Create Linear project: "Adversarial Code Review"  
2\. Break into tickets:  
   \- PR Watcher service (polling)  
   \- Reviewer Agent wrapper  
   \- Author tagging convention \+ enforcement  
   \- GitHub API integration  
   \- Linear status update hook  
3\. Assign to coding agents per WORKING\_INSTRUCTIONS.md queue process  
