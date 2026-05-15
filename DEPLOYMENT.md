# Deployment Audit

This file is the honest catalog of every place in the source tree that
still encodes a maintainer-local path, identity, or environment
assumption from the original hosted deployment. It exists for two
audiences:

1. **Outside contributors** — so you can quickly see which files are
   "real code you might want to extend" versus "maintainer-local
   wrappers you can ignore." None of the items on this list block
   the documented quick-start, the test suite, or the offline demo.
2. **Maintainer / future cleanup pass** — so the work needed to remove
   maintainer-local defaults from source has a published punch list,
   not a hidden one.

The five-minute outside-reader path in [`README.md`](README.md) does not
depend on any of the paths below:

```bash
npm install
npm test
bash demo/research-finding-walkthrough.sh
```

For a higher-level view of "what's mature vs. what's emerging," read
[`KNOWN-SHARP-EDGES.md`](KNOWN-SHARP-EDGES.md). This file is the
audit; that file is the framing.

---

## How the audit was generated

```bash
rg -n "/Users/[^/]+|agent-os-hq|HQ_ROOT|agent-os/\\.agent-os|agent-os" .
```

Each match was triaged into one of three buckets: *load-bearing runtime
default*, *maintainer-local launch wrapper*, or *regression fixture for
historical shape*. The buckets below are kept up to date by re-running
the grep before each release.

---

## Load-bearing runtime defaults

These are real source modules that carry maintainer-local fallbacks.
Every one has an env-var override; in a fresh clone the demo and test
paths use neutral defaults instead.

- **`src/alert-delivery.mjs`** defaults alert-bridge credentials to
  `<operator-home>/.config/adversarial-review/secrets` and probes the
  legacy `<operator-home>/agent-os/agents/clio/credentials/local`
  token path when the new default token file is absent. Explicit
  secret-root env vars (`ADV_SECRETS_ROOT`, `LITELLM_SECRETS_ROOT`)
  are honored ahead of either default. The whole alert path is
  optional — absence of credentials produces a no-op.
- **`src/watcher.mjs`** defaults reviewer-subprocess `HOME` to
  `<operator-home>` when no environment override is present. This is
  a maintainer-local daemon default for cross-user reviewer spawn
  and is overridden in normal operation.
- **`src/reviewer.mjs`** has
  `ACPX_CLI = '<operator-home>/.openclaw/tools/acpx/node_modules/.bin/acpx'`.
  This is only consulted when ACPX is the configured reviewer
  runtime, which it is not by default — `cli-direct` is the default
  runtime and it discovers `claude` and `codex` on `PATH`.
- **`src/follow-up-remediation.mjs`** defaults reply storage to
  `<operator-home>/agent-os-hq` when `HQ_ROOT` is set, and to
  `<repo>/data/replies` otherwise. The HQ-rooted path is part of the
  existing hosted remediation-worker contract for code PRs.
- **`src/adversarial-gate-status.mjs`** and
  **`src/check-branch-protection.mjs`** use the GitHub status context
  `agent-os/adversarial-gate`. That string is an external status-
  context name, not a filesystem path — but it does encode the
  maintainer's project name. Renaming it is a one-line change for
  outside operators.
- **`src/follow-up-merge-agent.mjs`**, **`src/follow-up-retrigger-label.mjs`**,
  **`src/retrigger-review.mjs`**, **`src/retrigger-remediation.mjs`**,
  and **`src/reset-pr.mjs`** contain `hq.*` verbs or `hq` CLI
  integration points. These are maintainer deployment hooks for
  the existing PR-review automation and are no-ops when the `hq`
  CLI is not present.

The plan for these is documented in [`KNOWN-SHARP-EDGES.md`](KNOWN-SHARP-EDGES.md)
§2 (Maintainer-local default paths in production code).

---

## Maintainer-local launch wrappers

These files embed local paths and account names. They are kept as a
documented example of **one** deployment topology — the maintainer's
two-operator split (`placey` operator + `airlock` agent) — not as
prerequisites for the demo or test suite. Outside operators do **not**
need to read them: the portable installer and the parameterized
templates beside it are the supported on-ramp.

- `scripts/adversarial-watcher-start.sh`
- `scripts/adversarial-watcher-start-placey.sh`
- `scripts/adversarial-follow-up-tick.sh`
- `launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-watcher.placey.plist`
- `launchd/ai.laceyenterprises.adversarial-follow-up.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-follow-up.placey.plist`

The portable on-ramp that replaces these for fresh deployments:

- Installer: `tools/adversarial-review/install.sh` (renders the
  templates below into `~/Library/LaunchAgents/` and
  `<repo>/scripts/render/`, then runs a postflight validator).
- Runbook: `tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md`.
- Templates:
  - `tools/adversarial-review/deploy/launchd/adversarial-watcher.plist.template`
  - `tools/adversarial-review/deploy/launchd/adversarial-follow-up.plist.template`
  - `tools/adversarial-review/deploy/launchd/adversarial-watcher-start.sh.template`
  - `tools/adversarial-review/deploy/launchd/adversarial-follow-up-tick.sh.template`
- Rendered files (not in source control; generated by `install.sh`):
  - `~/Library/LaunchAgents/ai.<WATCHER_USER_LABEL>.adversarial-watcher.plist`
  - `~/Library/LaunchAgents/ai.<WATCHER_USER_LABEL>.adversarial-follow-up.plist`
  - `<repo>/scripts/render/adversarial-watcher-start.sh`
  - `<repo>/scripts/render/adversarial-follow-up-tick.sh`

---

## Documentation kept for operators

These documents describe the existing hosted deployment and historical
incidents. They are not part of the five-minute outside-reader path in
[`README.md`](README.md), but they're load-bearing for anyone
reproducing or modifying the live production pipeline.

- `docs/follow-up-runbook.md` — day-to-day operator runbook
- `docs/MACOS-TCC.md` — TCC popup handling on macOS hosts
- `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md` — historical incident postmortem
- `docs/SPEC-adversarial-review-auto-remediation.md` — current living contract
- `docs/internal/SPEC-original.md` — original product spec, preserved for context
- `docs/internal/SPEC-durable-first-pass-review-jobs.md` — durable job design doc
- `docs/internal/SPEC-org-rollout-pr-review-guardrails.md` — rollout plan for guardrails
- `docs/internal/SPEC-pr-review-trigger-guardrails.md` — why creation-time prefixes matter

Note that the four "SPEC-" files at the repo root have moved into
[`docs/internal/`](docs/internal/) as part of the OSS-shape pass. See
[`docs/internal/README.md`](docs/internal/README.md) for the canonical
doc map.

---

## Complete remaining reference list

The grep audit currently finds maintainer-local references in the
following files. Each entry has been triaged into one of the buckets
above. `DEPLOYMENT.md` appears in the list because it documents the
audit itself.

### Maintainer deployment docs and specs

- `DEPLOYMENT.md` (this file)
- `docs/internal/SPEC-original.md`
- `docs/internal/SPEC-durable-first-pass-review-jobs.md`
- `docs/internal/SPEC-org-rollout-pr-review-guardrails.md`
- `docs/internal/SPEC-pr-review-trigger-guardrails.md`
- `docs/MACOS-TCC.md`
- `docs/SPEC-adversarial-review-auto-remediation.md`
- `docs/follow-up-runbook.md`
- `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md`

### Runtime defaults and maintainer hooks

- `src/adapters/comms/github-pr-comments/pr-comments.mjs`
- `src/adapters/comms/github-pr-comments/redaction.mjs`
- `src/adversarial-gate-status.mjs`
- `src/alert-delivery.mjs`
- `src/check-branch-protection.mjs`
- `src/follow-up-remediation.mjs`
- `src/reviewer.mjs`
- `src/watcher.mjs`
- `prompts/code-pr/remediator.first.md`
- `prompts/code-pr/remediator.middle.md`
- `prompts/code-pr/remediator.last.md`
- `scripts/adversarial-follow-up-tick.sh`
- `scripts/adversarial-watcher-start-placey.sh`
- `scripts/adversarial-watcher-start.sh`
- `launchd/ai.laceyenterprises.adversarial-follow-up.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-follow-up.placey.plist`
- `launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-watcher.placey.plist`

### Regression fixtures and tests

Many tests and JSON fixtures mention `laceyenterprises/agent-os`,
`/Users/airlock/...`, `HQ_ROOT`, or `agent-os-hq`. These are retained
because they verify redaction, reply-path handling, durable job
migration, and branch-protection behavior against historical shapes —
removing them would weaken the regression net.

- `test/alert-delivery.test.mjs`
- `test/adapters/comms-github-pr-comments.test.mjs`
- `test/branch-protection.test.mjs`
- `test/follow-up-jobs.test.mjs`
- `test/follow-up-merge-agent.test.mjs`
- `test/follow-up-reconcile.test.mjs`
- `test/follow-up-remediation.test.mjs`
- `test/follow-up-remediation-reply-path.test.mjs`
- `test/follow-up-retrigger-label.test.mjs`
- `test/operator-mutation-audit.test.mjs`
- `test/operator-retrigger-helpers.test.mjs`
- `test/pr-comments.test.mjs`
- `test/reset-pr.test.mjs`
- `test/retrigger-remediation.test.mjs`
- `test/retrigger-review.test.mjs`
- `test/review-state-identity-schema.test.mjs`
- `test/watcher-atomic-claim.test.mjs`
- `test/watcher-failure-diagnostic-logging.test.mjs`
- `test/watcher-health-probe.test.mjs`
- `test/fixtures/kernel/failing-verdict-job.json`
- `test/fixtures/kernel/passing-verdict-job.json`
- `test/fixtures/kernel/remediation-reply.json`

**Convention for new code:** do not copy any of the paths above into
new public docs or new domains. New fixture domains should follow
`test/research-finding-end-to-end.test.mjs`, which builds temporary
local state and uses fixture stubs instead of external services.
