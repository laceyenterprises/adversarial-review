# Research: Gemini adversarial-reviewer hallucination audit (2026-07-14)

## Summary

Operator observation ("gemini reviewers posting a lot of hallucinations lately")
was investigated with a commit-pinned audit of recent gemini reviews. The
observation is **correct but patterned**: across a 15-blocking-finding sample,
**33% were hallucinated (45% within `agent-os`)**, and every hallucination
clustered in **two failure modes** — (1) applying code-review reasoning to
documentation/spec-only PRs, and (2) misreading code adjacent to the flagged
line. Straightforward code findings were **100% accurate** and each was
independently corroborated by a maintainer remediation commit.

Root cause of mode (1): the reviewer prompt set is **hardcoded to `code-pr`**
(`src/reviewer.mjs` `REVIEWER_PROMPT_SET = 'code-pr'`), so documentation/spec/plan
PRs are reviewed with the code-regression rubric — which instructs the model to
find "anything that would fail in production" and drives it to invent runtime
failures for text that has none. The `prompts/research-finding/` set exists but
is never selected.

## Methodology

- Sampled 46 recent PRs / 107 gemini reviews across `agent-os` +
  `adversarial-review` for structural signals; deep-judged blocking findings on 8
  PRs against the code.
- **Critical correction:** findings must be judged against the exact commit the
  review was submitted against (`reviews[].commit_id`), NOT current `HEAD`. These
  PRs were remediated after their first review, so `HEAD` already contains the
  fix; judged naively against `HEAD`, a *valid* finding falsely appears
  hallucinated because the bug it described is gone. This alone flips several
  verdicts. A finding was scored VALID only if it accurately described the code at
  the reviewed SHA; a subsequent remediation commit implementing the finding's
  recommended fix was used as independent corroboration.

## Results

| Repo | Blocking findings | Valid | Hallucinated | Rate |
|---|---|---|---|---|
| agent-os | 11 | 6 | 5 | 45% |
| adversarial-review | 4 | 4 | 0 | 0% |
| **Total** | **15** | **10** | **5** | **33%** |

Structural: 72% of reviews were "Request changes"; **0% of findings cited a file
absent from the PR** (25 checked) — so the model does not fabricate references;
the hallucinations are semantic.

### Failure mode 1 — documentation/spec PRs reviewed as code (worst offender)

`agent-os#3699` (a planning PR: prompts + `SPEC.md`, no executable code) —
**3/3 blocking findings hallucinated**. The reviewer fabricated "daemon crashes,"
"cache can't be shared cross-user," and "exporter can't read stats," each
contradicting the SPEC's *explicit* stated choices (e.g. it flagged `0600`
per-owner cache files as a fleet-sharing bug when the SPEC names that as a
deliberate security mitigation). The **same PR's own second review reversed all
three and praised the design.** A document cannot cause the runtime failures it
was accused of.

### Failure mode 2 — adjacent-context misreads

`agent-os#3706` — **2/3 hallucinated**. It flagged a `startswith` as
case-sensitive-broken while a `.strip().lower()` sat **one line above**; and it
labeled the sole first-line classifier as "old detail-scanning logic" that a
negative test one block below disproves. Both are "didn't read the neighboring
line" errors.

### What is reliable

Concrete code findings — missing retry loops, contract/spec-drift on public
interfaces, buffer-truncation-on-timeout, non-atomic secret writes,
retry-budget accounting — were **100% valid** (10/10) and every one was
corroborated by a maintainer fix implementing the recommendation. Gemini is
trustworthy on concrete code defects; it hallucinates on non-code PRs and on
subtle adjacent-context logic.

## Mitigations shipped in this PR (prompt-only, no added model calls)

1. **Documentation/spec-only PR guard** (`prompts/code-pr/reviewer.first.md`):
   when every changed file is non-executable text, the reviewer must treat it as a
   documentation review — a document cannot itself crash/lose data/deadlock, so
   inventing runtime failure modes is forbidden; disputed claims must quote the
   exact text; a choice the document explicitly states is a deliberate decision,
   not a defect.
2. **Evidence discipline on blocking findings** (same file, mirrored into
   `prompts/research-finding/reviewer.first.md`): before listing a blocking issue
   the reviewer must quote the flagged lines *plus the surrounding context* and
   confirm the defect against it (catching mode 2), and must name the concrete
   input/state that triggers the failure — no defect inferred from a symbol name
   or a plausible pattern.

## Follow-ups (not in this PR)

- **Wire the prompt-set selection** so documentation/spec-only PRs actually load
  `prompts/research-finding/` instead of `code-pr` (the root fix for mode 1;
  `REVIEWER_PROMPT_SET` is currently a module constant and the `research-finding`
  set is dead code). The rubric guard above is the immediate mitigation; wiring is
  the durable fix.
- Optional: a bounded verification pass that re-checks each blocking finding
  against the reviewed SHA before it is allowed to block — justified by the 45%
  `agent-os` rate, but it adds a model call per finding.
- Any tooling that surfaces "was this finding a hallucination?" MUST pin to the
  review's `commit_id`; judging against `HEAD` is the trap that makes valid
  findings look fabricated.
