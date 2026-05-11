# Deployment Audit

This repository can be cloned, tested, and demoed without maintainer-local services:

```bash
npm install
npm test
bash demo/research-finding-walkthrough.sh
```

The open-source path above does not require the local deployment paths listed here. They remain in the tree because the project still contains production wrappers, legacy specs, and regression fixtures from the maintainer's original deployment. Outside contributors can ignore this file unless they are adapting those wrappers.

Audit command used for LAC-529:

```bash
rg -n "/Users/[^/]+|agent-os-hq|HQ_ROOT|agent-os/\\.agent-os|agent-os" .
```

## Load-Bearing Runtime Defaults

- `src/alert-delivery.mjs` has `DEFAULT_SECRETS_ROOT = '<operator-home>/agent-os/agents/clio/credentials/local'`. This is a maintainer-local default for alert bridge credentials.
- `src/watcher.mjs` defaults reviewer subprocess `HOME` to `<operator-home>` when no environment override is present. This is a maintainer-local daemon default.
- `src/reviewer.mjs` has `ACPX_CLI = '<operator-home>/.openclaw/tools/acpx/node_modules/.bin/acpx'`. This is a maintainer-local reviewer CLI path.
- `src/follow-up-remediation.mjs` defaults reply storage to `<operator-home>/agent-os-hq` and supports `HQ_ROOT`. That path is part of the existing hosted remediation-worker contract for code PRs.
- `src/adversarial-gate-status.mjs` and `src/check-branch-protection.mjs` use the GitHub status context `agent-os/adversarial-gate`. That string is an external status-context name, not a filesystem path.
- `src/follow-up-merge-agent.mjs`, `src/follow-up-retrigger-label.mjs`, `src/retrigger-review.mjs`, `src/retrigger-remediation.mjs`, and `src/reset-pr.mjs` contain `hq.*` verbs or `hq` CLI integration points. These are maintainer deployment hooks for existing PR-review automation.

## Maintainer-Local Launch Wrappers

These files embed local paths and account names. They are examples of one deployment topology, not prerequisites for the demo:

- `scripts/adversarial-watcher-start.sh`
- `scripts/adversarial-watcher-start-placey.sh`
- `scripts/adversarial-follow-up-tick.sh`
- `launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-watcher.placey.plist`
- `launchd/ai.laceyenterprises.adversarial-follow-up.airlock.plist`
- `launchd/ai.laceyenterprises.adversarial-follow-up.placey.plist`

## Documentation Kept For Operators

These documents intentionally describe the existing hosted deployment and incident history:

- `docs/follow-up-runbook.md`
- `docs/MACOS-TCC.md`
- `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md`
- `docs/SPEC-adversarial-review-auto-remediation.md`
- `SPEC.md`
- `SPEC-durable-first-pass-review-jobs.md`
- `SPEC-org-rollout-pr-review-guardrails.md`

They are not part of the five-minute outside-reader path in `README.md`.

## Complete Remaining Reference List

The grep audit found the following files after the README rewrite. `DEPLOYMENT.md` appears because it documents the audit itself.

### Maintainer Deployment Docs And Specs

- `DEPLOYMENT.md`
- `SPEC.md`
- `SPEC-durable-first-pass-review-jobs.md`
- `SPEC-org-rollout-pr-review-guardrails.md`
- `docs/MACOS-TCC.md`
- `docs/SPEC-adversarial-review-auto-remediation.md`
- `docs/follow-up-runbook.md`
- `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md`

### Runtime Defaults And Maintainer Hooks

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

### Regression Fixtures And Tests

Many tests and JSON fixtures mention `laceyenterprises/agent-os`, `/Users/airlock/...`, `HQ_ROOT`, or `agent-os-hq`. These are retained because they verify redaction, reply-path handling, durable job migration, and branch-protection behavior against historical shapes.

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

Do not copy those paths into new public docs or new domains. New fixture domains should follow `test/research-finding-end-to-end.test.mjs`, which builds temporary local state and uses fixture stubs instead of external services.
