# Adversarial Review

```
           /\                                                 /\
 _         )( ______________________   ______________________ )(         _
(_)///////(**)______________________> <______________________(**)\\\\\\\(_)
           )(                                                 )(
           \/                                                 \/
```

**A cross-model review loop for agent-generated work.** The agent that
*builds* the artifact is never the agent that *reviews* it. The reviewer
runs an adversarial prompt against the builder's output, a remediation
worker fixes the findings, and the reviewer re-checks until the work
converges or the configured round budget is spent.

Same-model self-review is a rubber stamp. This project exists to make
the rubber stamp expensive enough to fail loud.

## The thesis, in one paragraph

LLM-generated work can be fluent and wrong at the same time. When the
model that produced the work is also the model that judges the work, its
critique is bounded by the same blind spots that produced the bug —
sycophantic toward its own style, blind to its own habitual errors, and
unable to discover problems it didn't already know how to look for. The
fix is structurally simple: route the review to a *different* model with
*different* training data and *different* failure modes. Claude reviews
Codex; Codex reviews Claude. Each catches a class of issues the other
misses. Wrap that handoff in a deterministic loop — staged prompts,
machine-parseable verdicts, structured remediation replies, byte-stable
delivery contracts, per-risk-class round budgets — and you get a quality
gate that scales with agent volume instead of collapsing under it.

That's the whole idea. The rest of this repo is the engineering around
making it run, every day, against real PRs, without humans in the loop.

---

## What's here, honestly

This repo started as the production code-review pipeline for an internal
agent fleet. It has since been refactored toward a small **kernel** plus
pluggable **adapters**, so the same review loop can run over any
"subject" — not just GitHub PRs. Both layers are in this tree.

| Layer | Status today |
|---|---|
| **Kernel** (`src/kernel/`) — verdict parsing, remediation-reply validation, prompt-stage selection, adapter contracts | Stable. Small (~5 files), typed, regression-tested. Don't fork it. |
| **Adapter axes** — subject channel, comms channel, operator surface, reviewer runtime | Contracts stable. Reference adapters shipped. |
| **GitHub PR domain** (`src/watcher.mjs`, `src/follow-up-*.mjs`, GitHub PR + Linear adapters) | **Production.** Runs continuously against the maintainer's repo fleet. Battle-tested. |
| **Research-finding domain** (`domains/research-finding.json`, `markdown-file` + `slack-thread` + `linear-triage` adapters) | **Reference / demo.** Proves the kernel runs over a non-PR subject end-to-end. Adapters are fixture stubs that write JSONL transcripts; not a live Slack integration. |
| **Other domains** | None shipped yet. The kernel is ready; you just need adapters, prompts, and a fixture test. See [`CONTRIBUTING.md`](CONTRIBUTING.md). |

If you're evaluating whether to fork this, the test you actually care
about is: *the production GitHub-PR loop has run in anger for months
against multi-agent traffic, with byte-equivalence assertions on every
durable artifact.* That track record is the load-bearing part. The
pluggability is real but only one non-PR domain ships today.

Known sharp edges — the rough texture that we'd rather name out loud
than hide — are catalogued in [`KNOWN-SHARP-EDGES.md`](KNOWN-SHARP-EDGES.md).

Hammer credential renewal preserves the launch command's bounded owner retry
window across transient service restarts; explicit authorization refusals stop
with a bounded reason. The [closure runbook](docs/RUNBOOK-ama-closure.md)
defines the timeout contract and the SRE receipt across two natural broker rolls.
Offline deadline/refusal coverage lives in `test/hamcredrefresh-01.test.mjs`.

---

## Five-minute path

You can drive the full review → remediation → re-review → convergence
loop from a fresh clone, with no network and no credentials:

```bash
npm install && bash demo/research-finding-walkthrough.sh
```

The walkthrough:

1. Builds a temporary fixture root.
2. Copies the `research-finding` domain config, the six staged prompt
   files, and the shared simplicity/cost guidance.
3. Drives a markdown subject through the reviewer (a deterministic stub),
   the verdict parser, the remediation-reply validator, the JSONL
   transcript adapter, the re-review path, and convergence.
4. Asserts the `.slack-thread-transcripts/subject.md/slack-thread.jsonl`
   contents are byte-equivalent to the expected transcript.

Exits non-zero if any kernel or adapter invariant fails. The same
contracts the demo exercises are the contracts the production
GitHub-PR pipeline depends on.

Deferred validation preserves unpublished source and unknown cleanup in HQ custody.
A clean published source with confirmed cleanup resumes the existing paced closer
retry; every merge still needs exact-head review, source provenance and required
CI. See [the custody contract](docs/data-model/deferred-source-custody.md).
Without a CI mirror, local environment faults may defer to exact-head GitHub
checks. Mirror setup faults instead remain UNKNOWN under source custody and
paced retry; unpublished source or unconfirmed cleanup requires operator recovery.
The existing five-second group TERM-to-KILL escalation, isolated pytest phases,
lease release before failure audit, and head/base/file-overlap gates still apply.

Active follow-up remediation keeps its execution owner when cancellation fails or remains pending. Own published heads survive history rewrites while attestation is unavailable; cancellation identity and custody are documented in the [follow-up lifecycle contract](docs/follow-up-runbook.md#6-bounded-stop-conditions). These custody checks do not authorize completion, rereview or merge.

The full unit + adapter test suite runs the same way:

```bash
npm test
```

CI runs every file on Node 22 and Node 26 on main, at 06:37 UTC nightly
and on manual dispatch. Each major has two measured, non-overlapping shards;
all four jobs must pass. Pull requests retain two jobs and select tests from the diff against the
checked-out merge commit's first parent. The selection follows reverse imports
and literal source references, including CLI invocations. Harness, dependency,
workflow and shared fixture changes use the full file set. Unclassified changes
and unavailable selection also use the full set. Docs-only and empty diffs run
zero Node test files. Each existing job runs a small selection, and the two
jobs split broad selections when they reach a third of the suite by file count
or estimated work. Both PR jobs keep their existing check names; full-run names
also identify the shard. Node 22.10 or newer
is required for native test-runner `execArgv` support, which installs each
file's preloads.
The runner schedules files by measured duration. Local runs default to half
the available logical CPUs rounded down, with a minimum of one and a maximum
of four. Set `AR_TEST_CONCURRENCY` to a positive integer to override the
local limit. The number of selected parallel files caps the actual worker
count. CI continues to use up to eight workers.
A single native coordinator feeds the longest pending file to each free worker.
The SMV smoke file runs alone first because it measures real process deadlines.
Each file runs in its own process with isolated state, home and temporary
directory. The runner supplies Git settings that disable automatic maintenance
and garbage collection for fixture commits, fetches and pushes even with a fresh
home. Push receivers own their server-side configuration. Helpers that replace
Git command configuration own their settings. Repeated CLI fixtures use
private compile caches.
The suite deadline stays at 900 seconds when the selected parallel files fit
within the configured worker limit. Otherwise it is
`900 * 8 / min(8, limit)` seconds: 1800 seconds with a four-worker limit and
900 with eight. Failures name the test file and return a nonzero status. At the
deadline, the runner prints the active test files and the number still queued.
Generic bounded validation wrappers preserve command arguments.
`AR_TEST_CONCURRENCY` applies only to this repository’s runner.
Set `AR_TEST_TIMINGS=/absolute/path.json` to
record per-file wall times and total suite wall time. Set `AR_TEST_CHECKPOINT`
to a different absolute path for an append-only plan and file-completion journal
that survives a suite timeout. CI uploads both outputs, including partial progress
on failure. Relative report paths
resolve against the caller's working directory and survive sandbox cleanup.
Scheduling hints in `test/fixtures/suite-durations.json` control execution
order and shard balance. The selection comes from the diff and dependency graph.
For a focused run, pass exact paths or basenames to `node test/run-tests.mjs`.
To preview a committed diff against `HEAD`, run
`npm test -- --base origin/main --dry-run`. On a PR merge checkout, use
`--base HEAD^1`. Set `AR_TEST_PR_SHARD=0` or `AR_TEST_PR_SHARD=1` to preview
the corresponding PR matrix job. For a full run without a diff base or explicit
file list, set `AR_TEST_FULL_SHARD=0` or `AR_TEST_FULL_SHARD=1` instead.
With neither shard setting, local `npm test` still runs the complete inventory.

### AgentOS Reviewer Runtime Routing

Supported reviewer runtimes are `cli-direct`, `agent-os-hq`, `agent-runtime`
and `fixture-stub`. The retired ACPX runtime and its smoke domain have been
removed. Domains that still name `acpx` fail validation with a migration
message. An `ADVERSARIAL_REVIEWER_RUNTIME=acpx` override is ignored with the
same warning and fallthrough as other unknown runtime overrides.
`ACPX_CLI`, `ACPX_CLI_PATH` and `openclaw.install_root` no longer configure
reviewers; remove the obsolete install-root key from configuration. The
shared schema still accepts parent-owned retention, reaper and ACP state-home
settings for Agent OS compatibility; none selects a reviewer runtime.

The GitHub-PR watcher resolves `roles.adversarial.orchestration_mode`
once per poll tick. In the default `native` mode, `domains/code-pr.json`
continues to select the reviewer runtime, normally `cli-direct`. In
`agentos` mode, the watcher forces the reviewer runtime to `agent-os-hq`
so first-pass reviews launch through HQ orchestration instead of a direct
CLI subprocess.

In native mode, a local model stall returns the claim to the watcher for
bounded backoff. After an operator cancels a reviewer, the watcher first looks
for a posted review, then marks the matching claim failed if none exists. See the
[reviewer recovery runbook](docs/RUNBOOK-antigravity-gemini-reviewer.md#interrupted-result-during-model-execution).

The watcher refreshes that runtime adapter before startup recovery and
again at the beginning of each poll tick. Invalid orchestration-mode
config is logged through a deduped persistent-failure signal, and the
adapter refresh keeps the last-known-good mode (or `native` before any
good value has been seen) so GitHub App token refresh is not skipped by
a config typo in this adapter refresh path. This resilience is scoped:
later strict config reads in the same tick can still fail and stall
review work until the bad `orchestration_mode` value is corrected. The
mode-mismatch signal covers failures while rebuilding the runtime adapter
itself. Most `agentos` deployment mistakes, such as a missing `HQ_ROOT`,
`HQ_PARENT_SESSION`, `HQ_PROJECT`, or `hq` binary, are validated lazily at
review spawn time and surface as reviewer dispatch failures until the
watcher environment is fixed. The primary adapter is rebuilt only when the
resolved mode or `domains/code-pr.json` mtime changes. Each enabled secondary
domain likewise reuses its own reviewer-runtime adapter across poll ticks and
rebuilds it when that domain config's mtime or the process-wide orchestration
mode changes, preserving
adapter-owned pools, caches, and leases without mixing state between domains.

### Operator comment trust

PR discovery and label controls accept trusted author associations (`OWNER`,
`MEMBER`, `COLLABORATOR`) and configured identities. For other actors, they
also check live repository permission (`admin`, `maintain`, or `write`).
Adding an operator to `roles.adversarial.operator_logins` is optional for
those trust checks when the live permission lookup succeeds.

Linked-spec context uses a narrower check: `fetchLinkedSpecContents` in
`src/prompt-context.mjs` follows links from the PR body and from comments
whose authors have a trusted association or are allowlisted. It does not
look up live permissions for comment authors. If GitHub reports an operator
as `CONTRIBUTOR` (for example, with private org membership), add their login
to `roles.adversarial.operator_logins` to have spec links in their comments
included in reviewer and remediation prompts. Otherwise those comment links
are silently ignored even when their PRs and labels pass the live permission
check. Operators with a trusted association need no allowlist entry for
linked-spec comments.

For operators without a trusted association, the allowlist entry is required
for comment-linked specs even if a live permission check grants PR intake
and label control access.

---

## Standalone install and run

You can run a review on any machine with Node and a provider API key. The
standalone path has no Agent OS host, no private submodule, no GitHub token and
no `config.yaml`. It reads a unified diff, sends it with the same staged
reviewer prompt the GitHub-PR pipeline uses, and checks the reply against the
same kernel verdict contract.

```bash
git clone https://github.com/laceyenterprises/adversarial-review.git
cd adversarial-review
npm ci            # Node >=22.10 <27

export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY=...
git diff main...HEAD | npm run --silent review:standalone -- \
  --provider anthropic --model <model-id> --diff -
```

| Option | Meaning |
|---|---|
| `--provider anthropic\|openai` | Reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| `--model <id>` | Required. No default model is assumed. |
| `--diff <file\|->` or `--base <git-ref>` | A diff file or stdin, or `git diff <ref>...HEAD` in the current directory. |
| `--base-url <url>` | Point at a gateway or compatible endpoint. |
| `--stage`, `--prompt-set` | Reviewer prompt stage (`first`, `middle`, `last`) and the set under `prompts/`. |
| `--max-diff-bytes`, `--timeout-ms` | Refuse oversized diffs (no silent truncation); bound the request. |
| `--max-output-tokens <n>` | Reply budget, including any hidden reasoning (default 8192). A reply cut off at this limit exits `2`; raise it for reasoning models. |
| `--json` | Print `{ verdict, review, provider, model }`. |

The same command is available as `node src/cli.mjs standalone ...` or, from
an installed package, `adversarial-review standalone ...` (bin links and other
symlinks to `src/cli.mjs` work). Exit code `0` means approved or comment-only,
`1` means request-changes, and `2` means a usage, provider, reply-contract or
any other failure. An unreadable, truncated or incomplete reply never reads as
a pass, and an unexpected error never reads as request-changes.

Notes:

- This is a single review of a single diff. It does not poll GitHub, post
  comments, run remediation rounds or merge. Those are the production
  daemons described below, and they need their own configuration.
- The production reviewers authenticate through subscription CLIs and strip
  API keys from their environment on purpose. The standalone path is
  separate and does the opposite: it uses the key you export.
- The model sees only the diff. It has no repository access, so the request
  tells it that context outside the diff is unseen and that issues depending
  on unseen code are questions, not blocking findings.
- The diff is wrapped in a tag with a random per-request nonce
  (`<diff-…>`), so diff text cannot close the subject and pose as
  instructions.
- A diff on stdin is refused as soon as it passes `--max-diff-bytes`; the rest
  of the stream is not read into memory.
- `src/standalone-review.mjs` imports only `src/kernel/` and Node built-ins;
  `test/standalone-review.test.mjs` pins that, and runs the whole path
  offline against a stub provider.

---

## The production pipeline

The watcher claims eligible GitHub PRs, routes each PR to a cross-model
reviewer, and records the verdict. The remediation worker addresses findings
and returns the updated head for review. Merge authority evaluates the current
review, CI and custody evidence. The hammer handles closeout when the PR needs
remediation or CI repair. [Production pipeline](docs/production-pipeline.md) ·
[Hammer merge logic](docs/hammer-merge-logic.md)

## Repository map

```
adversarial-review/
├── README.md                   ← you are here
├── CONTRIBUTING.md             ← worked example: add a domain
├── DEPLOYMENT.md               ← maintainer-local audit of paths
├── KNOWN-SHARP-EDGES.md        ← honest list of rough edges
├── GLOSSARY.md                 ← decoder ring for internal names
├── AUTHOR_TAGGING.md           ← internal worker-class taxonomy
│
├── src/
│   ├── kernel/                 ← stable review-loop logic
│   │   ├── verdict.mjs
│   │   ├── remediation-reply.mjs
│   │   ├── prompt-stage.mjs
│   │   └── contracts.d.ts
│   ├── adapters/
│   │   ├── subject/            ← discover + read + mutate subjects
│   │   ├── comms/              ← deliver reviewer + remediation messages
│   │   ├── operator/           ← maintainer-facing triage surfaces
│   │   └── reviewer-runtime/   ← invoke reviewer/remediator processes
│   ├── watcher.mjs             ← GitHub-PR polling daemon
│   ├── follow-up-*.mjs         ← remediation queue + reconciler
│   └── *.mjs                   ← supporting modules
│
├── frontend/                   ← ARF: the review frontend, a standalone app
│   ├── server/                 ← its own API, store, and governance reads
│   ├── frontend/               ← Screens A/B/C; no build step
│   ├── gate/                   ← the load-independent arm/disarm gate contract
│   ├── supervisor/             ← `arf up` / `arf status` / `arf gate …`
│   └── scripts/                ← standup-verify.mjs: boots it, asserts every surface
│
├── domains/                    ← wiring configs
├── prompts/                    ← staged reviewer + remediator prompts
│   ├── code-pr/                ← production prompt set
│   └── research-finding/       ← reference non-PR prompt set
├── bin/                        ← operator and closer CLIs: lease, audit, predicate, hammer procedures, context, bounded runner
│
├── test/                       ← kernel + adapter + end-to-end tests
├── demo/                       ← offline walkthroughs
├── scripts/                    ← operator helper scripts
├── launchd/                    ← macOS supervisor templates
├── tools/                      ← deploy templates + bounce helper
├── hooks/                      ← provenance commit-msg hook
│
├── docs/                       ← operator-facing docs
│   ├── ARCH-adversarial-review-adapter-architecture.md
│   ├── SPEC-adversarial-review-auto-remediation.md
│   ├── STATE-MACHINE.md
│   ├── follow-up-runbook.md
│   ├── MACOS-TCC.md
│   ├── NOTE-arf-standup-from-adversarial-review.md
│   ├── INCIDENT-*.md
│   └── internal/               ← historical specs (safe to skip)
│
└── .github/workflows/          ← CI: test.yml (npm test on Node 22/26 + CDM audit)
```

## Documentation

- [Design notes and domain extensions](docs/design-notes.md)
- [Configuration and schema](docs/configuration.md)
- [Production pipeline and deployment](docs/production-pipeline.md)
- [Hammer merge logic](docs/hammer-merge-logic.md)
- [State machines and smoke verification](docs/STATE-MACHINES-AND-SMOKE.md)
- [OAuth identity token pools](docs/identity-token-pools.md)
- [Truthful no-op outcomes](docs/truthful-no-op-outcomes.md)
- [Operational behaviors](docs/operational-behaviors.md)
- [Per-ticket change notes](docs/changes/README.md) and [historical README change notes](docs/changes/ARCHIVE-readme-change-notes.md)

## License

[Apache-2.0](LICENSE)
