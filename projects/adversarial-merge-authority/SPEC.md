# Adversarial Merge Authority (AMA) local contract mirror

This repository carries the adversarial-review implementation for AMA closure.
The full project spec lives in the parent Agent OS repository at this same path;
this local mirror records the config surface that the Node loader, closer
dispatch, and operator runbooks in this repo must keep aligned.

## 1.1.1 HAM terminal-remediation mode

HAM terminal remediation is a bounded final-review closer path for the
`hammer` worker class. It may be used only after the final adversarial review
for a PR has blocking or non-blocking findings that the HAM worker remediates
directly on top of the reviewed head. The mode does not request another review
round; instead, `ama-check --ham-terminal-remediation <claim.json>` validates
the post-remediation head immediately before merge.

The evidence JSON is a claim, not authority. At closer runtime the predicate
must verify that claim against durable GitHub state:

- the live PR head SHA is the claimed HAM remediation commit;
- the live commit's first parent is exactly the reviewed head;
- the live commit has a non-empty verified GitHub diff;
- the live commit message trailers include `Worker-Class: hammer`,
  `Worker-Ticket: HAM-<n>`, `Closed-By: hammer (adversarial-pipe-mode)`, and a
  `Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)` count;
- the PR timeline contains the claimed audit comment body;
- the matched audit comment author is the verified commit author or an
  allowlisted hammer bot identity, and the eligibility trace records the
  comment `author`, `createdAt`, and `id`;
- the audit comment body names each claimed finding title and changed file;
- each claimed finding has `addressed: true`; and
- the claimed blocking-finding count matches the blocking-finding count from
  the authoritative final review state.

HAM attests that each mapped finding was resolved; the predicate verifies the
commit, trailers, audit mapping, counts, and non-empty diff, but it does not
semantically prove the code change fixes the reviewer's finding.

Only after those checks pass may the predicate record
`ham_terminal_remediation_validated`. That marker may waive
`stale-review-head`, `verdict-not-settled-success`, `remediation-pending`,
`remediation-state-unknown`, `blocking-findings-present`, and
`blocking-findings-unknown`, `non-blocking-findings-present`, and
`non-blocking-findings-unknown`. It must not waive AMA disabled state, PR lifecycle
or mergeability, CI, branch protection, hard-stop labels, unsupported
fast-merge state, or risk-class policy. When final-hammer cycle exhaustion is
also active, HAM and final-hammer waivers compose by filtering the remaining
reason set in sequence; one waiver path must not discard the other path's
accepted waivers.

## 4.2 Eligibility predicate

Direct AMA closure requires a current-head settled-success review (`Approved`
or `Comment only`), no pending remediation, known-zero structured blocking
findings, and, by default, known-zero structured non-blocking findings.
`roles.adversarial.merge_authority.strict_non_blocking_remediation` defaults to
`true`; setting it to `false` restores the legacy direct-close behavior where
non-blocking findings do not affect settled-success eligibility.

When strict non-blocking remediation is enabled, a settled-success review with
standing structured non-blocking findings is refused with
`non-blocking-findings-present`. A settled-success review whose non-blocking
classification is unavailable is refused with
`non-blocking-findings-unknown`. Current-head `operator-approved` evidence still
bypasses the verdict/finding gate, and validated HAM terminal remediation may
waive the non-blocking reasons after it verifies the HAM commit and audit
comment. Final-hammer review-cycle exhaustion may waive non-blocking reasons
only with current-head operator override, matching the existing verdict and
blocking-finding gate semantics.

## 4.7 CFG-01 schema

New section under `roles.adversarial.merge_authority`:

```yaml
roles:
  adversarial:
    merge_authority:
      # Master switch. Default off so this lands dark on hosts that
      # haven't been opted in.
      enabled: false
      # Which worker class does the closer dispatch use.
      worker_class: hammer  # enum: codex | claude-code | hammer | gemini
      # Which merge method to use. `rebase` is not supported because
      # AMA requires one canonical landed closing commit for provenance
      # and audit reconciliation; GitHub's rebase path does not produce one.
      merge_method: squash  # enum: squash | merge
      # Default true. Direct AMA close requires the authoritative settled review
      # to report known-zero non-blocking findings. Set false only to restore
      # legacy direct-close behavior.
      strict_non_blocking_remediation: true
      eligibility:
        # Risk classes that may close without operator intervention.
        risk_classes: ["low"]
        # Fast-merge labels remain a separate lane; AMA ignores them
        # unless it explicitly imports the FML head-scoped contract.
        fast_merge_labels:
          - "fast-merge:test-fixtures"
          - "fast-merge:docs"
        # Reviewer family is recorded for audit and defaults to the
        # existing cross-model routing contract, but AMA does not make
        # same-family review a new hard merge gate until the adversarial-
        # review gate docs and tests are updated in the same change.
        reviewer_family_policy: audit_existing_gate_contract
        # Green-CI uses the existing adversarial-review / merge-path
        # check classifier, including SUCCESS, COMPLETED, NEUTRAL,
        # SKIPPED, and the self-gate exclusion. This enum exists only
        # as a documentation mirror; implementations must not fork the
        # classifier into a narrower AMA-only list.
        ci_green_classifier: existingAdversarialMergeClassifier
      branch_protection:
        # Fail-closed branch-protection gate. Operators on GitHub plans
        # with no branch protection may set this false in config.local.yaml
        # to waive only the branch-protection predicate; all other AMA gates
        # still apply. Not env-overridable.
        required: true
        # AMA compares branch protection against the resolved gate
        # context(s) from the adversarial-review contract rather than
        # a hardcoded literal.
        required_gate_context_source: resolveGateStatusContext
```

Supported closer worker classes are `codex`, `claude-code`, `hammer`, and
`gemini`. Closer dispatch must pass the configured value to HQ as
`--worker-class <configured-worker-class>` with `--task-kind merge` and
`--completion-shape decision-only`; provenance must attribute the actual closer
class as `Closed-By: <configured-worker-class>-closer (adversarial-pipe-mode)`,
except HAM terminal-remediation commits, which use the exact
`Closed-By: hammer (adversarial-pipe-mode)` trailer from §1.1.1.
