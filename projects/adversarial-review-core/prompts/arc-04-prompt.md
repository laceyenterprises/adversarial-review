# ARC-04 — Security review domain (code-pr-security)

> Plan ticket `ARC-04` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-04), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-02, ARC-03; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `domains/research-finding.json` — the reference wiring shape
  - `prompts/code-pr/` — stage file naming
  - `docs/ARCH-adversarial-review-adapter-architecture.md` — 'To add a domain' checklist
- **Why this exists:** First real second production domain: proves the Phase 1 wiring with an operator-valuable capability (security review) while staying gated off.

## Scope (mirrored from plan.json)

Add domains/code-pr-security.json and prompts/code-pr-security/ (reviewer + remediator, first/middle/last stages) carrying a security-review rubric (injection, authz, secret handling, supply chain, unsafe deserialization, SSRF), registered behind a config gate defaulting off. Reuses the github-pr subject/comms adapters.

## Tests (mandatory)

- fixture e2e review -> remediation -> re-review -> converge on the new domain.
- prompt-set selection assertions.
- gate-off means the domain is not polled.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-04:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Gate defaults OFF; no production polling of the new domain in this ticket.
- No new adapters — reuse github-pr subject/comms.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-04: Security review domain (code-pr-security)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
