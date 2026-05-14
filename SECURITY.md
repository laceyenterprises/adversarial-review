# Security Policy

Thanks for taking the time to report a vulnerability responsibly.

## Supported versions

This project is single-track. Security fixes are landed on `main` and
released as new tags. There is no LTS branch.

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| Older tags | ❌ — please update to `main` |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.**

Use GitHub's private vulnerability reporting form for this repo:

👉 **https://github.com/laceyenterprises/adversarial-review/security/advisories/new**

That delivers your report directly to the maintainers without making
it public. You'll get an acknowledgement and a tracking advisory.

If for some reason the form is unavailable, you may instead email
**security@laceyenterprises.com** with:

- A description of the issue and the impact.
- A minimal, self-contained reproduction.
- The commit SHA or tag you're testing against.
- Any disclosure timeline constraints on your end.

## What we treat as in scope

- Vulnerabilities in code under [`src/`](src/), [`tools/`](tools/),
  runtime-relevant repository scripts, [`hooks/`](hooks/), and
  [`.github/workflows/`](.github/workflows/) that would let an unauthenticated
  or unprivileged actor:
  - read or modify another reviewer's or operator's secrets, OAuth
    tokens, or PR comments;
  - inject content into a reviewer-generated review, remediation
    reply, or operator notice in a way that bypasses delivery-key
    idempotency or verdict parsing;
  - escape the worker process group / cgroup confinement and read or
    mutate state outside the worker's workspace;
  - cause the watcher to spawn a reviewer on a PR it should have
    refused (e.g. malformed-title bypass, fork-PR contamination,
    `pull_request_target` exploitation).
- Vulnerabilities in `package.json` direct dependencies, where the
  vulnerable path is actually reachable from this project's code (not
  just a transitive CVE that doesn't apply).
- Vulnerabilities in the documented public adapter contracts in
  [`src/kernel/contracts.d.ts`](src/kernel/contracts.d.ts) that would
  let an adapter author silently violate a kernel invariant.
- Executable daemon and operational scripts remain in scope. That
  includes runtime `.mjs` code such as
  [`scripts/adversarial-follow-up-daemon.mjs`](scripts/adversarial-follow-up-daemon.mjs)
  when it participates in the live watcher/remediation path described
  in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## What we treat as out of scope

- Issues in code under [`docs/internal/`](docs/internal/) —
  historical specs preserved for context, not running code.
- Maintainer-local launch wrappers and supervisor templates that embed
  host-specific paths or account names, specifically:
  [`scripts/adversarial-watcher-start.sh`](scripts/adversarial-watcher-start.sh),
  [`scripts/adversarial-watcher-start-placey.sh`](scripts/adversarial-watcher-start-placey.sh),
  [`scripts/adversarial-follow-up-tick.sh`](scripts/adversarial-follow-up-tick.sh),
  and the templates under [`launchd/`](launchd/). As documented in
  [`DEPLOYMENT.md`](DEPLOYMENT.md), those files describe one specific
  deployment topology rather than a portable runtime contract.
- Reports that rely on the operator already having full local
  filesystem write access to the watcher's host (the threat model
  assumes the operator's host is trusted; if you have local write,
  you are the operator).
- Reports against fixture stubs in [`test/`](test/) that use
  deliberate-looking secret strings (`ghp_aaaa...`, `sk-test_...`)
  to verify the redaction code path. These are test invariants, not
  real keys.
- "Best practice" reports without a concrete impact path (e.g.
  "consider bumping `<X>` to latest" with no exploit). Open a regular
  GitHub issue or PR for those.

## What happens after you report

| When | What |
|---|---|
| Within **3 business days** | Acknowledgement that we received the report. |
| Within **14 days** | Triage decision — accepted, needs more info, or out of scope, with reasoning. |
| Within **90 days** | If accepted, a fix shipped to `main` and a [GitHub Security Advisory](https://github.com/laceyenterprises/adversarial-review/security/advisories) published, with credit to you unless you ask to remain anonymous. |

If a fix is going to take longer than 90 days, we will explain why
and propose a coordinated disclosure date with you.

## Defenses already in place

These are documented so reporters can save time on issues that are
already mitigated, and so the architecture context is clear:

- **OAuth-first env strip list** —
  [`src/secret-source/env.mjs`](src/secret-source/env.mjs) strips
  provider API-key fallback env vars (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `AWS_BEARER_TOKEN_BEDROCK`) before reviewer/remediation worker
  spawn. `ANTHROPIC_AUTH_TOKEN` is preserved because it may be the
  OAuth bearer the runtime is supposed to use.
- **Redaction on outbound delivery** —
  [`src/adapters/comms/github-pr-comments/redaction.mjs`](src/adapters/comms/github-pr-comments/redaction.mjs)
  scrubs token-shaped strings from PR comments before posting.
  Verified by byte-equivalence assertions in
  `test/pr-comments.test.mjs`.
- **Worker process-group isolation** —
  [`src/process-group-spawn.mjs`](src/process-group-spawn.mjs)
  spawns reviewers in a detached process group so signal handling
  and cleanup do not bleed across runs.
- **Watcher fail-loud for malformed PR titles** — a missing or
  malformed worker-class tag does not silently fall through to a
  default reviewer; the watcher posts a fail-loud comment and writes
  a terminal failure record.
- **Cross-model adversarial routing** — the routing table in the
  watcher refuses to dispatch the same model as both builder and
  reviewer; that's the whole point of the project.
- **GitHub Actions hygiene** — workflow `GITHUB_TOKEN` defaults to
  `read` permissions; `pull_request_target` is used only for the
  PR-title prefix validator and explicitly does not check out the
  PR head code; the test workflow uses `pull_request` (not
  `pull_request_target`) so fork PRs run with no secret access.

## Disclosure policy

We follow coordinated disclosure. We will work with you on a
disclosure timeline. We will publish a Security Advisory on this
repository when the fix lands.

Thank you for helping keep this project and its users safe.
