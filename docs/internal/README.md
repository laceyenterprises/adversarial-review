# docs/internal/

These files describe the **maintainer's hosted deployment** of
adversarial-review and the **historical specs** the system was built
against. They are kept in the tree because they are useful when reading
the production code (which still encodes some of their assumptions), but
they are **not** prerequisites for cloning, testing, or extending the
project.

> If you're an outside contributor: you can safely skip this entire
> directory. Everything you need lives in the repo root and in
> [`../`](../) (the operator-facing docs).
>
> If you're the maintainer or someone reproducing the live deployment:
> these are the historical contracts. Treat the files in [`../`](../)
> as canonical when they disagree with anything here.

## What's in here and why

| File | What it is |
|---|---|
| `SPEC-original.md` | The original product spec, from the time the system was first designed. Useful for *why* the system exists and what its founding constraints were. Superseded by the current operator-facing docs in [`../`](../) for *how* the system is actually built today. |
| `SPEC-durable-first-pass-review-jobs.md` | Design doc for the refactor of first-pass review from inline watcher execution into a durable job queue. The implementation has landed; this file documents the intent. |
| `SPEC-org-rollout-pr-review-guardrails.md` | Operational rollout plan for the PR-title-prefix guardrails across the maintainer's repo fleet. Specific to the maintainer's environment. |
| `SPEC-pr-review-trigger-guardrails.md` | The "why we need creation-time title prefixes" design spec. Implementation lives in `.github/workflows/pr-title-prefix-validation.yml` and the watcher's title-guardrail code. |

## Canonical doc locations

When something in this directory disagrees with a doc one level up, the
upstream doc wins:

- **Architecture:** [`../ARCH-adversarial-review-adapter-architecture.md`](../ARCH-adversarial-review-adapter-architecture.md)
- **Living contract:** [`../SPEC-adversarial-review-auto-remediation.md`](../SPEC-adversarial-review-auto-remediation.md)
- **State machines:** [`../STATE-MACHINE.md`](../STATE-MACHINE.md)
- **Operator runbook:** [`../follow-up-runbook.md`](../follow-up-runbook.md)

The "live SPEC" in the maintainer's view is the union of those four,
not the `SPEC-original.md` here.
