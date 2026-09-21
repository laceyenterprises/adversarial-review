# RUNBOOK — Low-risk slim review fast lane (RPL-08)

**Spec:** `review-pipeline-latency` (RPL), ticket RPL-08
**Code:** `src/slim-review-eligibility.mjs` (predicate),
`src/review-mode-selection.mjs` (orchestration),
`src/review-mode-latency.mjs` (durable record),
`src/review-latency-report.mjs` (`reviewModes` rollup)

## What it does

Every reviewer pass now runs in one of three **review modes**:

| Mode | Meaning |
|---|---|
| `slim` | Every changed file classified low risk. The reviewer gets a trimmed context bundle. |
| `full` | The low-risk predicate refused. Today's behaviour, unchanged. |
| `forced-full` | The predicate may or may not have agreed; an operator took the decision away from it. |

Slim mode trims **context**, never the **contract**. The reviewer stage prompt —
verdict vocabulary, blocking-issue sections, evidence discipline — is loaded and
sent byte-identically in all three modes. Required checks, merge authority, the
adversarial gate, and the AMA/hammer closure path are untouched: nothing in this
lane can approve, merge, or waive anything.

What slim mode drops is the two expensive context builders:

- `fetchLinkedSpecContents` — up to 12 sequential `gh api` content reads of up to
  12 000 characters each. That is wall-clock on the hot path, and on AGY it is
  also argv budget; overflowing the budget reroutes the review to a costlier
  model or to bounded chunking.
- `buildHardeningReviewContext` — spawns `python3` against the session ledger and
  matches hardening contracts by *location path*. Every registered contract
  location is a gate-keeper surface, and gate-keeper surfaces are refused from
  this lane by construction, so on an eligible PR the query is guaranteed cost
  and guaranteed silence.

Watcher advisory findings are **kept** in slim mode: they are already in memory,
and they are the watcher speaking about this specific PR.

In their place the reviewer gets a short banner naming the classification, so a
short prompt reads as "this change is small" rather than "context fetching
broke", and an explicit instruction that a misclassification is itself a
blocking finding.

## The predicate

Deny by default. A PR is slim-eligible only when **all** of these hold:

1. The lane is enabled and no operator override is present.
2. The changed-file list could be derived from the diff and is non-empty.
3. Every path classifies as a low-risk class: `docs` (`.md`, `.mdx`, `.rst`,
   `.txt`, `.adoc`, `LICENSE`, `CODEOWNERS`, …) or `tests` (`test/`, `tests/`,
   `spec/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`).
4. No path trips `classifySecuritySurface` (`src/security-surface-classifier.mjs`)
   — auth, secrets, sandbox profiles, entitlements, sudoers, launchd plists,
   worker-class definitions, `.github/workflows/*` action pins, dependency
   manifests and lockfiles, or a dependency-bot author.
5. No path is a **gate-keeper** surface (below).
6. No path is generated or vendored churn (`dist/`, `build/`, `vendor/`,
   `node_modules/`, `coverage/`, `__snapshots__/`, `*.min.js`, `*.map`, `*.snap`,
   `*.generated.*`, `*.pb.go`, `*_pb2.py`, `*.lock`).
7. No binary file.
8. At most 20 files and 400 changed lines.

A PR that satisfies 3 but fails any other rule is refused. Refusals are
**accumulated, not short-circuited**: the report shows every rule that fired.

### Gate-keeper surfaces

Anchored path patterns apply to every file including documentation:
`.github/`, `.git-hooks/`, `hooks/`, `*/launchd/`, `migrations/`, `prompts/`,
`domains/`, `bin/`, `scripts/`, `config*.yaml|json`, `src/ama/`, `src/kernel/`,
`src/finalization/`, `src/adapters/`, `src/secret-source/`,
`modules/worker-pool/lib/`, `modules/worker-pool/post-merge-actions/`.

Whole path-segment **tokens** apply to non-documentation files only:
`watcher`, `reviewer`, `pollonce`, `verdict`, `adjudicate`, `merge`, `hammer`,
`closer`, `ama`, `attest`, `gate`, `eligibility`, `lease`, `quota`, `daemon`,
`launchd`, `plist`, `sudoers`, `entitlement`, `sandbox`.

The documentation exemption is deliberate and narrow. In an executable path a
token like `merge` denotes a privilege; in `docs/RUNBOOK-fast-merge-lane.md` it
denotes a topic, and refusing it would push this repo's own runbooks — its most
common low-risk PR — permanently out of the fast lane. Anchored patterns still
cover documentation that lives inside a control-plane directory, so the
exemption cannot reach `.github/` or `src/ama/FREEZE.md`.

Note the consequence for tests: `test/watcher-claim-loop.test.mjs` is a low-risk
*class* but a gate-keeper *surface*, and the conjunction refuses it. That is
intended — a change to the watcher's own regression test rewrites the pipeline's
contract.

## Operator controls

| Control | Scope | Effect |
|---|---|---|
| `operator-approved: full-review` label | PR-wide while present | Forces `forced-full` for every subsequent review pass on that PR. |
| `ADVERSARIAL_REVIEW_FORCE_FULL_REVIEW=1` | Reviewer process | Forces `forced-full` for every PR. |
| `ADVERSARIAL_REVIEW_SLIM_REVIEW_ENABLED=0` | Reviewer process | Kill switch. Every review is `full`, refusal code `slim-mode-disabled`. |
| `ADVERSARIAL_REVIEW_SLIM_MAX_FILES` | Reviewer process | File-count bound (default 20). |
| `ADVERSARIAL_REVIEW_SLIM_MAX_CHANGED_LINES` | Reviewer process | Changed-line bound (default 400). |
| `ADVERSARIAL_REVIEW_SLIM_DENY_PREFIXES` | Reviewer process | Comma-separated repo-relative path prefixes to refuse. Prefixes match on path segments, so `docs/legal` refuses `docs/legal/terms.md` and not `docs/legalese.md`. |

`forced-full` is kept distinct from `full` on purpose: without it the latency
report cannot tell a fast lane the rules refuse from a fast lane an operator
switched off.

The overrides do **not** short-circuit the predicate. A forced-full PR still
records what the classifier would have decided, so an operator can see whether
the override was applied to a genuinely risky change or to one the rules called
low risk.

### Why environment variables and not `config.yaml`

`config.yaml` is validated by three independent strict loaders — the Python
`_schema_v1`, this repo's Node `src/config-loader.mjs`, and the shell
`agent-os-config-loader.sh` — two of which live in another repository. A new key
must land in all three in the same deploy or the watcher crash-loops on an
unknown key (the `config-schema.multi-loader-parity` failure class, which has
taken the watcher down for over an hour). Environment variables on the reviewer
process carry no such coupling, and the launchd plist is already where operators
set reviewer environment.

## Observing it

The posted review body carries a blockquote under the marker heading for `slim`
and `forced-full` (an ordinary `full` review is unchanged from before RPL-08):

```
## Adversarial Review — Gemini (gemini-reviewer-lacey)

> Review mode: **slim** (RPL-08 low-risk fast lane; classified docs, 1 file(s), +1/-1). Verdict semantics and required checks are unchanged.

## Blocking issues
...
```

Blockquote, never a heading: the verdict and blocking-finding parsers key on
`## Verdict` / `## Blocking issues`, and heading-level drift in review bodies has
broken them before (adversarial-review#521).

Each pass also writes a durable `review_mode_selected` row to
`review_latency_events` (see `docs/data-model/review-latency-events.md`), keyed
`review-mode:<repo>#<pr>:<head>:<attempt>`. The write is best-effort: a locked or
unreadable `reviews.db` degrades to a warning and never fails the review.

`adversarial-review latency report` rolls them up:

```
review modes: slim=12 full=31 forced_full=2 slim_rate=27%
  slim refused by: non-low-risk-path=29 gate-keeper-path=11 security-surface=4
```

The refusal histogram is the operationally useful half. A low slim rate on a
gate-keeper repo is the lane working as designed; a slim rate that collapses to
zero with every refusal reading `changed-files-unknown` means diff parsing
broke, not that the fleet got riskier.

The structured log line is `event: review-mode-selection` in the reviewer's
stdout, carrying the mode, the refusal list, and the diff stats for the pass.

## If something looks wrong

- **A risky PR got a slim review.** Capture the changed-file list, add
  `operator-approved: full-review`, and re-trigger the review. Then add the path
  shape to `GATE_KEEPER_PATH_PATTERNS` / `GATE_KEEPER_TOKENS` or to
  `security-surface-classifier.mjs` with a regression test in
  `test/slim-review-eligibility.test.mjs`.
- **Everything is `full` and nothing is going slim.** Read `topRefusals`. If it
  is `slim-mode-disabled`, the kill switch is set on the reviewer process.
- **Turn the whole lane off.** Set `ADVERSARIAL_REVIEW_SLIM_REVIEW_ENABLED=0` on
  the reviewer environment. The reviewer reads it per process, so new reviewer
  spawns pick it up without a watcher bounce.
