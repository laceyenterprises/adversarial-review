\# Adversarial Code Review System — Spec

\#\# Problem

AI coding agents tend to be sycophantic toward their own output. A Claude-written PR reviewed by Claude will often pass with minimal critique. Same-model review is a rubber stamp, not a quality gate.

\#\# Solution

Enforce adversarial cross-model review: the agent that builds the code is never the agent that reviews it. Claude Code and Codex have different training, tendencies, and blind spots — each will catch things the other misses.

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

\---

\#\# Open Questions

1\. \*\*Webhook vs polling?\*\* Webhook is more responsive but requires a public endpoint (or ngrok/Tailscale tunnel). Polling is simpler for now — revisit when prlt is live.  
2\. \*\*What repos does the watcher cover?\*\* Start with \`laceyenterprises/clio\` only, expand to prlt repos when ready.  
3\. \*\*Codex API access\*\* — confirm Codex is accessible via OpenAI API for spawned reviewer agents (it is, via litellm-local).  
4\. \*\*Max concurrent reviews\*\* — respect the 2–3 parallel agent limit from WORKING\_INSTRUCTIONS.md.

\---

\#\# Dependencies

\- \`gh\` CLI configured with \`laceyenterprises\` org access  
\- Codex available via \`litellm-local/gpt-codex\` (or equivalent model ID — confirm)  
\- Claude Code available via \`litellm-local/claude-sonnet-4-6\`  
\- Linear API configured (\`\~/clio/credentials/local/linear.env\`)  
\- prlt (Proletariat, https://github.com/chrismcdermut/proletariat) — future dependency, not required for v1

\---

\#\# Success Criteria

\- \[ \] Every agent-built PR in covered repos gets a review from the opposing model within 10 minutes  
\- \[ \] Review is substantive (adversarial prompt enforced — no empty approvals)  
\- \[ \] Author detection works reliably from PR title tags  
\- \[ \] Linear ticket updated on review completion  
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
