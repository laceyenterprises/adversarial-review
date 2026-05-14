# Author Tagging Convention — Agent-Built PRs

> **For outside contributors:** you do not need to follow this convention.
> The PR Title Prefix Validation workflow explicitly skips outside-contributor
> PRs (see `.github/workflows/pr-title-prefix-validation.yml`). This document
> describes the internal worker-class taxonomy the maintainer's deployment
> uses to route reviewers automatically. Read it if you want to understand
> how the running pipeline is wired; ignore it if you're just sending a PR.

Inside the maintainer's deployment, every PR is opened by one of three
known worker classes, and the watcher routes reviewer selection off the
title prefix at PR-creation time. Because that routing decision is made
once and is not re-evaluated on retitle, the prefix has to be right the
first time — hence the strict validation.

> Some terms below (Clio, prlt) are internal-system names. See
> [GLOSSARY.md](GLOSSARY.md) for definitions. The taxonomy is generalizable:
> if you stand up your own deployment with different builder agents, you'd
> define your own tag set and update the watcher's routing table to match.

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

The prefix requirement is defended in four places, on purpose. Each layer
catches a different class of mistake:

- **prlt workflow** (build-time): prlt's `commit` and `pr create` commands
  prepend the correct tag automatically so a human operator never has to
  think about it.
- **Clio coding-agent dispatches** (prompt-time): Clio includes the tag
  instruction in every agent task prompt so any dispatched worker knows
  the convention even when prlt isn't in the loop.
- **Canonical helper path** (CLI-time): operators and ad-hoc scripts open
  PRs through
  `npm run pr:create:tagged -- --tag <codex|claude-code|clio-agent> --title "<unprefixed title>" -- <gh args...>`,
  which enforces the prefix locally before the PR exists.
- **Watcher guardrail** (post-creation, internal): if a tag is missing or
  malformed after the PR is open, the watcher fails loud — posting a
  comment, writing a terminal failure record, and refusing to start
  adversarial review. It does NOT retrigger on retitle, so the failure is
  durable until an operator intervenes.
- **Repo-side validation check** (post-creation, GitHub-side): the GitHub
  Action `PR Title Prefix Validation` fails the PR check when an internal
  author opens a PR without a known prefix, and explains the creation-time
  recovery path in the failure log. Outside-contributor PRs are skipped.

## Reviewer Routing

The whole point of the tag is so the watcher knows which model to dispatch
as the adversarial reviewer. The routing table is the cross-model contract:
the builder is never also the reviewer.

| PR Tag | Reviewer Bot | Model |
|---|---|---|
| `[claude-code]` or `[clio-agent]` | `codex-reviewer-lacey` | Codex |
| `[codex]` | `claude-reviewer-lacey` | Claude Code (claude-sonnet-4-6) |
| No tag / unknown | **Fail-loud guardrail** | No reviewer spawned |

The `*-lacey` bot accounts are GitHub identities the maintainer's
deployment owns; they exist so reviewer comments are visibly authored by a
different account than the builder. If you stand up your own deployment,
you'd substitute your own bot identities here.

## Clio Agent Prompt Template

When dispatching a coding agent, always include this fragment in the
prompt so the worker doesn't forget the tag:

```
... your task here.

**IMPORTANT**: When opening the PR, prefix the title with `[codex]` (if using Codex)
or `[claude-code]` (if using Claude Code). Example: `[codex] feat: your feature name`
This tag is required for the adversarial review system to route correctly.
```

## Linear Ticket Association

Also include the Linear ticket ID in the PR title when applicable. The
Linear sync hook reads the ticket reference straight out of the title and
updates ticket status (In Review → Done / Cancelled) when the PR closes:

```
[codex] feat: add webhook handler (LAC-11)
```

If you don't use Linear, this is a no-op — the watcher simply skips the
sync step when `LINEAR_API_KEY` is absent.
