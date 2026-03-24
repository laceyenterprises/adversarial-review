# Author Tagging Convention — Agent-Built PRs

All PRs built by AI coding agents MUST include an author tag in the PR title.
This tag drives reviewer routing in the Adversarial Code Review pipeline.

## Tags

| Agent | PR Title Tag | Commit Author |
|---|---|---|
| Claude Code (prlt fleet) | `[claude-code]` | email contains `claude` or `clio@laceyenterprises.com` |
| Codex (Clio-delegated) | `[codex]` | email contains `codex` |
| Clio sub-agent | `[clio-agent]` | `clio@laceyenterprises.com` |

## Placement

Tag goes at the **start** of the PR title:

```
[claude-code] feat: add payment webhook handler (LAC-42)
[codex] fix: resolve null pointer in auth middleware (LAC-17)
[clio-agent] chore: update dependency versions
```

## Enforcement

- **prlt workflow**: prlt's `commit` and `pr create` commands must prepend the correct tag
- **Clio coding-agent dispatches**: Clio includes the tag instruction in every agent task prompt
- **Default fallback**: If tag is missing or ambiguous → Codex reviews (safer default)

## Reviewer Routing

| PR Tag | Reviewer Bot | Model |
|---|---|---|
| `[claude-code]` or `[clio-agent]` | `codex-reviewer-lacey` | Codex |
| `[codex]` | `claude-reviewer-lacey` | Claude Code (claude-sonnet-4-6) |
| No tag / unknown | `codex-reviewer-lacey` | Codex (fallback) |

## Clio Agent Prompt Template

When dispatching a coding agent, always include:

```
... your task here.

**IMPORTANT**: When opening the PR, prefix the title with `[codex]` (if using Codex)
or `[claude-code]` (if using Claude Code). Example: `[codex] feat: your feature name`
This tag is required for the adversarial review system to route correctly.
```

## Linear Ticket Association

Also include the Linear ticket ID in the PR title when applicable:

```
[codex] feat: add webhook handler (LAC-11)
```

This allows the Linear sync hook to update ticket status automatically.
