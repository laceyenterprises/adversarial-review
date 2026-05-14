# Adversarial Review

```
           /\                                                 /\
 _         )( ______________________   ______________________ )(         _
(_)///////(**)______________________> <______________________(**)\\\\\\\(_)
           )(                                                 )(
           \/                                                 \/
```

Try the pluggable research-finding pipeline from an existing clone in five minutes:

```bash
npm install && bash demo/research-finding-walkthrough.sh
```

Adversarial Review runs a cross-model review loop: one actor writes or changes a subject, a separate reviewer model looks for problems, a remediation worker fixes the findings, and the reviewer checks again until the subject converges or the configured round budget is spent.

The project started with code pull-request review, but the important idea is broader than PRs. A "subject" can be a markdown research finding, a design memo, a policy change, a generated report, or any other artifact where a second model should challenge unsupported claims before humans rely on it.

## Why Cross-Model Review?

Model-generated work can be fluent and wrong at the same time. The review loop helps by separating incentives:

- The builder is optimized for producing the artifact.
- The reviewer is optimized for finding risk, ambiguity, missing evidence, and contract violations.
- The remediation worker is optimized for making the smallest durable fix.
- The final verdict is parsed into a machine-readable gate.

That separation makes the loop useful for open-ended work while still giving maintainers deterministic boundaries: prompt stages, verdict parsing, remediation-reply validation, and round budgets all live in the kernel.

## What Makes It Pluggable?

The kernel does not know whether the reviewed subject is a GitHub PR, a markdown file, a Slack thread, or something else. A domain config wires four pieces together:

- `domains/<id>.json` chooses the adapters and prompt set.
- A subject-channel adapter discovers the subject, reads content, prepares remediation workspaces, records remediation commits, and finalizes terminal state.
- A comms-channel adapter posts reviewer verdicts, remediation replies, and operator notices with stable delivery keys.
- An operator-surface adapter syncs external triage state or records human override events.

The ARA-08 reference domain is `research-finding`. It uses:

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

For the full seam diagram, see [docs/ARCH-adversarial-review-adapter-architecture.md](docs/ARCH-adversarial-review-adapter-architecture.md).

## Quick Local Workflow

Install dependencies:

```bash
npm install
```

Run the full test suite:

```bash
npm test
```

Run only the research-finding walkthrough:

```bash
bash demo/research-finding-walkthrough.sh
```

The demo has no network dependency. It builds a temporary fixture, drives the markdown-file subject through the reviewer, verdict parser, remediation reply parser, slack-thread JSONL transcript adapter, re-review, and convergence path, then exits non-zero if any kernel or adapter invariant fails.

## Repository Map

- `src/kernel/` contains the stable review-loop logic: verdict parsing, remediation-reply parsing, prompt-stage selection, and adapter contracts.
- `src/adapters/subject/` contains subject-channel adapters.
- `src/adapters/comms/` contains delivery adapters for review and remediation messages.
- `src/adapters/operator/` contains maintainer-facing triage and override surfaces.
- `domains/` contains wiring configs.
- `prompts/` contains staged reviewer and remediator prompt sets.
- `test/` contains kernel, adapter, and end-to-end fixtures.
- `demo/` contains local walkthroughs that should run from a fresh clone.

## Adding a Domain

Start with [CONTRIBUTING.md](CONTRIBUTING.md). It walks through the `research-finding` domain file-by-file and shows how to add your own subject adapter, comms adapter, prompt set, fixtures, and byte-equivalence assertions without changing the kernel.

## Deployment Notes

This repository still includes some maintainer-local deployment wrappers and regression fixtures from the original hosted environment. They are not required for the local demo or test suite. The current audit is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Operators

If you are running the live PR-review loop rather than the local research-finding demo, start with [docs/follow-up-runbook.md](docs/follow-up-runbook.md) and [docs/SPEC-adversarial-review-auto-remediation.md](docs/SPEC-adversarial-review-auto-remediation.md).

The operator surface includes `npm run retrigger-review`, `npm run retrigger-remediation`, and the watcher drain marker at `data/watcher-drain.json`. Reconcile-time public PR comments and retries are tracked durably under `commentDelivery`; see the runbook for the delivery and retry contract.

## License

Apache-2.0. See [LICENSE](LICENSE).
