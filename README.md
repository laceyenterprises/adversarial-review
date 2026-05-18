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

---

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

---

## Five-minute path

You can drive the full review → remediation → re-review → convergence
loop from a fresh clone, with no network and no credentials:

```bash
npm install && bash demo/research-finding-walkthrough.sh
```

The walkthrough:

1. Builds a temporary fixture root.
2. Copies the `research-finding` domain config and the six staged prompt
   files.
3. Drives a markdown subject through the reviewer (a deterministic stub),
   the verdict parser, the remediation-reply validator, the JSONL
   transcript adapter, the re-review path, and convergence.
4. Asserts the `.slack-thread-transcripts/subject.md/slack-thread.jsonl`
   contents are byte-equivalent to the expected transcript.

Exits non-zero if any kernel or adapter invariant fails. The same
contracts the demo exercises are the contracts the production
GitHub-PR pipeline depends on.

The full unit + adapter test suite runs the same way:

```bash
npm test
```

CI runs both on Node 20 and Node 22 on every PR.

---

## Why this works — the design notes worth reading

The review loop is intentionally boring in its boundaries. The
opinionated parts are:

**1. The builder is never the reviewer.** Routing is by PR-title prefix
(internal worker classes) for the GitHub-PR domain, and by `domains/<id>.json`
wiring for other domains. The routing table is a flat enum, not a
heuristic, because heuristic routing would re-introduce same-model review
under load.

**2. The reviewer prompt is adversarial, not consultative.** The standard
reviewer prompt explicitly tells the model: *"You did NOT write this code.
Your job is to find problems. Do NOT summarize. Do NOT praise."* Full
text is in [`docs/internal/SPEC-original.md`](docs/internal/SPEC-original.md)
and `prompts/code-pr/reviewer.first.md`. Sycophancy is the failure mode
this prompt is built to defeat.

**3. Verdicts are parsed, not interpreted.** `src/kernel/verdict.mjs`
extracts a `Comment only` / `Request changes` decision from a structured
markdown body. Anything else is a parser failure, not a soft signal.
This is what makes the loop a *gate* rather than a suggestion.

**4. Remediation replies are validated against a contract.** The
remediation worker's reply must be a JSON object with `addressed[]`,
`pushback[]`, `blockers[]`, and `reReview`. `src/kernel/remediation-reply.mjs`
rejects malformed replies before the loop advances. This is what makes
remediation idempotent — the worker can re-run and the kernel can tell
whether progress was made.

**5. Round budgets are per-risk-class.** Low-risk subjects get one round
to converge; critical-risk subjects get more. The final round uses a
*lenient* prompt that escalates only substantive, evidence-bearing
findings as blocking — so the loop terminates predictably instead of
chasing diminishing returns. Spec-touch findings (contract drift)
remain blocking even on the lenient round, because silent drift is the
class of failure that round budgets are *not* designed to forgive.

**6. Delivery is byte-stable and idempotent.** Every reviewer verdict
and remediation reply is written as a JSONL record with a stable
delivery key (`domainId` + `subjectExternalId` + `revisionRef` + `round` +
`kind`). Retries are content-identical. This is what makes the loop
durable through daemon bounces, network blips, and crashed workers.

**7. Failure is loud, not graceful.** A malformed PR title does not
silently fall back to "same-model review" — the watcher posts a comment,
writes a terminal failure record, and refuses to start. A reviewer
output that lacks a `## Verdict` section throws, not warns. The
philosophy is that the cost of a missed quality gate is higher than the
cost of an explicit, recoverable failure.

For the seam diagram and the kernel/adapter contract details, read
[`docs/ARCH-adversarial-review-adapter-architecture.md`](docs/ARCH-adversarial-review-adapter-architecture.md).

---

## How the pluggability works

The kernel does not know whether the reviewed subject is a GitHub PR, a
markdown file, a design memo, a Slack thread, a policy change, a
generated research finding, or anything else. A domain config wires four
pieces together:

- `domains/<id>.json` chooses the adapters, the reviewer runtime, the
  prompt set, and the per-risk-class round budgets.
- A **subject-channel** adapter discovers the subject, reads its content,
  prepares remediation workspaces, records remediation commits, and
  finalizes terminal state.
- A **comms-channel** adapter posts reviewer verdicts, remediation
  replies, and operator notices with stable delivery keys.
- An **operator-surface** adapter syncs external triage state (e.g.
  Linear issues) or records human override events.

The reference implementation for a non-PR domain is `research-finding`.
It uses:

- `domains/research-finding.json`
- `prompts/research-finding/reviewer.first.md`
- `prompts/research-finding/reviewer.middle.md`
- `prompts/research-finding/reviewer.last.md`
- `prompts/research-finding/remediator.first.md`
- `prompts/research-finding/remediator.middle.md`
- `prompts/research-finding/remediator.last.md`
- `src/adapters/subject/markdown-file/index.mjs`
- `src/adapters/comms/slack-thread/index.mjs`
- `src/adapters/operator/linear-triage/index.mjs`

Adding your own domain is "new domain config + new adapters where the
existing ones don't fit + new prompt set + new fixture test." It does
**not** require changes under `src/kernel/`. If you find yourself wanting
to change the kernel to make your domain fit, pause and ask whether
you're exposing a true shared need or leaking adapter behavior in. Either
answer is fine, but it's worth the pause.

The full worked walkthrough is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## The production pipeline (what runs every day)

For the GitHub-PR domain, the loop is wired through two long-running
daemons on the maintainer's host:

```
┌────────────────────────────────────────────────────────────────┐
│ ai.laceyenterprises.adversarial-watcher                        │
│   - polls GitHub for new agent-built PRs                       │
│   - validates worker-class title prefix                        │
│   - dispatches first-pass reviewer (Codex for [claude-code]    │
│     PRs; Claude for [codex] PRs)                               │
│   - posts the structured review to the PR                      │
│   - parses the verdict, writes a durable state record          │
└────────────────────────────────────────────────────────────────┘
                                │
                                ▼ when verdict = "Request changes"
┌────────────────────────────────────────────────────────────────┐
│ ai.laceyenterprises.adversarial-follow-up                      │
│   - 120s tick loop                                             │
│   - claims one remediation job from the JSON queue             │
│   - spawns a remediation worker on the PR branch               │
│   - validates the remediation reply against the kernel         │
│     contract                                                   │
│   - reconciles to "re-review requested" / "stopped" / "blocked"│
│   - retries durable PR comment delivery                        │
└────────────────────────────────────────────────────────────────┘
```

When a remediation pass converges (reviewer flips to `Comment only`,
or the round budget exhausts), the loop terminates and the PR returns
to the operator for the final merge decision. The watcher projects the
durable adversarial-review state onto the PR head SHA as a GitHub
commit-status context — `agent-os/adversarial-gate` by default,
overridable per deployment via `ADV_GATE_STATUS_CONTEXT` — which can
be required in branch protection if you want merge to depend on a
passing verdict. Overrides are restricted to log-safe context names
matching `[A-Za-z0-9._/-]+` with a 100-character maximum.

On Agent OS hosts, a successful gate can also hand the PR to the
`merge-agent` worker class. Before invoking `hq dispatch --worker-class
merge-agent`, the watcher derives the original worker id from the PR head
branch prefix (for example `codex-lac-660/...` -> `codex-lac-660`) and
tears down that original worker only when `HQ_ROOT` is set, the watcher
already owns that HQ root, and the worker's canonical session-ledger
`worker_runs.status` is terminal (`succeeded`, `failed`, or `cancelled`),
or the PR lifecycle is already terminal. Any other known or unknown status
is treated as active/degraded and is not torn down. This frees the PR
branch for the merge-agent worktree without using `git worktree add
--force` only when the recorded worker history says teardown is safe. If
`HQ_ROOT` is unset, the HQ owner differs from the watcher runtime user,
the derived branch prefix does not match the worker's `workspace.json`,
`workspace.json` is missing while the worker directory still exists, the
session-ledger row is missing while the worktree still exists, or the
original worker is still active, the watcher logs a structured skip/defer
event and leaves the existing dispatch path to retry or fail with its own
diagnostics. Override labels such as `operator-approved` and
`merge-agent-requested` do not bypass this liveness check; missing worker-run
state still fails closed until the original worker is provably terminal.
Branch prefixes that do not look like registered worker ids are
ignored before any filesystem probe or `hq` invocation. Active original
workers specifically emit `merge_agent.dispatch_deferred` and skip that tick;
the next watcher tick retries. Successful cleanup logs
`merge_agent.original_worker_torn_down` with the PR number, original worker
id, and launch request id. The `hq worker tear-down` call is bounded to the
watcher tick budget and logs `merge_agent.tear_down_timeout` on timeout.

Operator surface, when something needs intervention:

```bash
npm run retrigger-review        # re-run first-pass review for a PR
npm run retrigger-remediation   # re-queue remediation for a PR
npm run reset-pr                # clear durable state for a PR
npm run follow-up:stop          # stop an in-flight remediation
npm run follow-up:reconcile     # reconcile drifted queue state
```

Full operator runbook: [`docs/follow-up-runbook.md`](docs/follow-up-runbook.md).
Living contract: [`docs/SPEC-adversarial-review-auto-remediation.md`](docs/SPEC-adversarial-review-auto-remediation.md).

---

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
├── domains/                    ← wiring configs
├── prompts/                    ← staged reviewer + remediator prompts
│   ├── code-pr/                ← production prompt set
│   └── research-finding/       ← reference non-PR prompt set
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
│   ├── INCIDENT-*.md
│   └── internal/               ← historical specs (safe to skip)
│
└── .github/workflows/          ← CI: test matrix + PR title validation
```

---

## Adding a domain

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). It walks through the
`research-finding` domain file-by-file and shows how to add your own
subject adapter, comms adapter, prompt set, fixtures, and byte-
equivalence assertions without changing the kernel.

If you hit a place where the kernel doesn't fit your domain, open an
issue with the case before patching the kernel — there's a good chance
the right answer is a small kernel extension, but it should be a
deliberate one.

---

## Operating in the maintainer's deployment

To rename the GitHub status context that gets required in branch
protection (for instance, when you don't want `agent-os/adversarial-gate`
appearing in your org's governance language), set the
`ADV_GATE_STATUS_CONTEXT` environment variable on the watcher and on
`npm run check-branch-protection`; non-empty values win over the
default, whitespace is trimmed, and values must match
`[A-Za-z0-9._/-]+` with a 100-character maximum so logfmt-style
diagnostics remain unambiguous.
Treat a rename as an explicit migration: update branch protection and
every watcher/probe deployment to the same override before relying on
the new context.

If you're running this against the maintainer's hosted environment (or
reproducing it), the operator docs are:

- [`docs/follow-up-runbook.md`](docs/follow-up-runbook.md) — the day-to-day operator runbook
- [`docs/SPEC-adversarial-review-auto-remediation.md`](docs/SPEC-adversarial-review-auto-remediation.md) — the living contract
- [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md) — the two durable state machines
- [`docs/MACOS-TCC.md`](docs/MACOS-TCC.md) — TCC popup handling on macOS hosts
- [`tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md`](tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md) — five-step path to a running watcher on a clean macOS host
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — audit of maintainer-local paths still in source
- [`tools/adversarial-review/DEPS.md`](tools/adversarial-review/DEPS.md) — full dependency contract

### Secret-source contract

If your wrapper exits at startup with
`[secret-source] FATAL: could not resolve OP_SERVICE_ACCOUNT_TOKEN`, the
canonical resolution order is, in declared precedence (first match wins):

1. `OP_SERVICE_ACCOUNT_TOKEN` already in the process environment.
2. `ADV_OP_TOKEN_FILE` — path to a file containing the trimmed token.
3. `ADV_OP_TOKEN_ENV_FILE` — path to a shell-style env file with
   `OP_SERVICE_ACCOUNT_TOKEN=...` or `export OP_SERVICE_ACCOUNT_TOKEN=...`.
4. Legacy compatibility file:
   `$AGENT_OS_ROOT/agents/clio/credentials/local/op-service-account.env`
   or `$HOME/agent-os/agents/clio/credentials/local/op-service-account.env`.
5. `$ADV_SECRETS_ROOT/op-service-account.token`.
6. `$HOME/.config/adversarial-review/secrets/op-service-account.token`.

The full table — including what each source means, how the fail-once
diagnostic is shaped, and why the wrappers sleep before exit — is in
[`tools/adversarial-review/DEPS.md`](tools/adversarial-review/DEPS.md)
under "OP_SERVICE_ACCOUNT_TOKEN resolution."

If you're not running the live deployment, you can ignore all of the
above and stick to the five-minute path at the top of this file.

---

## A note on internal vocabulary

A few terms in the docs and prompts (Clio, the `[claude-code]` /
`[codex]` / `[clio-agent]` worker classes) are names from the
maintainer's operating substrate. None of them are required to use this
project. If you see one and wonder what it means, the decoder ring is
[`GLOSSARY.md`](GLOSSARY.md).

---

## License

Apache-2.0, with patent grant. See [`LICENSE`](LICENSE).

Apache-2.0 was chosen over MIT because adversarial review is the kind of
work where an explicit patent grant matters: someone, somewhere, will
have a patent on "automated cross-model code review" before long, and a
permissive-but-grant-bearing license is the cleanest answer.
