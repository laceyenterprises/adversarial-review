# Glossary

This repository was extracted from a larger system — an agent operating
substrate run by Lacey Enterprises — and a handful of internal names leak
through in code comments, prompts, and historical specs. None of them are
required to use the project; they're definitions, not dependencies.

If you're reading this because you saw a term in a doc or a PR title and
wondered what it meant, the table below is the entire decoder ring.

## Names of agents and systems

| Name | What it is | Where it appears |
|---|---|---|
| **Clio** | The maintainer's primary persistent AI agent. Clio dispatches coding workers (Claude Code, Codex) for individual tasks and is the operator's day-to-day driver. | Reviewer routing tables, the `[clio-agent]` PR title prefix, the `clio@laceyenterprises.com` commit-author identity. |
| **prlt** | Internal CLI/workflow tool that wraps `git commit` and `gh pr create` and prepends the canonical worker-class title prefix automatically. Mentioned in `AUTHOR_TAGGING.md` as the build-time enforcement layer. | `AUTHOR_TAGGING.md` "Enforcement" section. |
| **Agent OS** | The umbrella system that hosts Clio, the worker pool, the session ledger, and this review pipeline. Adversarial-review is one tool within Agent OS, vendored here as its own repo. | `tools/adversarial-review/DEPS.md`, scattered references to `HQ_ROOT` and `agent-os-hq` in code. |
| **HQ / `hq`** | The Agent OS worker-pool dispatcher. It can be used as an alternate reviewer runtime (`reviewerRuntime: "agent-os-hq"`) in `domains/<id>.json`, but the default and supported runtime is `cli-direct`, which invokes `claude` or `codex` directly without needing HQ. | `src/adapters/reviewer-runtime/agent-os-hq/`, env vars `HQ_ROOT`, `HQ_PARENT_SESSION`, `HQ_PROJECT`. |
| **OpenClaw** | A self-hosted TUI / gateway that fronts the maintainer's local LLM proxy (LiteLLM) and Telegram alerting. Adversarial-review's `alert-delivery.mjs` posts optional alerts to it. The alert path is entirely optional. | `docs/MACOS-TCC.md`, the optional `OPENCLAW_*` env vars listed in `tools/adversarial-review/DEPS.md`. |
| **ACPX** | A local "agent client protocol" runtime used as one of the reviewer-process spawn shapes. Optional; the default reviewer runtime is `cli-direct`. | `.acpxrc.json`, `tools/adversarial-review/install.sh`. |
| **`codex-reviewer-lacey`, `claude-reviewer-lacey`** | The GitHub identities the maintainer's deployment uses to post adversarial reviews. They exist so reviewer comments are visibly authored by a *different* GitHub account than the builder, which preserves the cross-model separation visually as well as logically. | `AUTHOR_TAGGING.md` routing table; `WORKER_CLASS_TO_BOT_TOKEN_ENV` in `src/adapters/comms/github-pr-comments/pr-comments.mjs`. |

## PR-title worker classes

The watcher routes reviewer selection off these prefixes (see
[`AUTHOR_TAGGING.md`](AUTHOR_TAGGING.md) for the full routing rules):

| Prefix | What it means in the maintainer's deployment |
|---|---|
| `[claude-code]` | PR was opened by Claude Code (one of the builder agents). |
| `[codex]` | PR was opened by Codex. |
| `[clio-agent]` | PR was opened by a Clio sub-agent that delegated to Claude. |

These are not fundamental to the design — they're the worker classes *this
particular deployment* runs. If you spin up your own deployment with a
different set of builder agents, you'd define your own tag set and update
the watcher's routing table to match. The kernel itself doesn't care.

## Ticket prefixes

| Prefix | Meaning |
|---|---|
| `LAC-###` | Linear ticket ID for the maintainer's "Lacey" team. Appears in PR titles, commits, and SPEC files. Outside contributors will never need to reference these. |

## Things that look internal but aren't

- The Apache-2.0 license, the kernel split, the adapter architecture, the
  test discipline, and the convergence-loop contract are all general. None
  of them require Lacey Enterprises infrastructure to run.
- The `demo/research-finding-walkthrough.sh` path runs without network and
  proves the kernel + adapter contracts independently of any of the names
  above.
