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
`blocking-findings-unknown`, and `non-blocking-findings-present`. It must not
waive AMA disabled state, PR lifecycle or mergeability, CI, branch protection,
hard-stop labels, unsupported fast-merge state, or risk-class policy. When
final-hammer cycle exhaustion is also active, HAM and final-hammer waivers
compose by filtering the remaining reason set in sequence; one waiver path must
not discard the other path's accepted waivers.

## 4.2 Closure eligibility verdict predicate

A review is a direct settled-success input to AMA closure only when all review
state predicates below are true:

- the latest authoritative verdict is `approved` or `comment-only`;
- remediation state is known and no remediation round is pending;
- blocking-finding state is known and the blocking-finding count is zero; and
- when `strict_non_blocking_remediation` is explicitly enabled, non-blocking
  finding state is known and the non-blocking-finding count is zero.

When the strict non-blocking gate is enabled and the latest settled-success
review still has non-blocking findings, AMA records the eligibility reason
`non-blocking-findings-present` and the review is not a direct settled-success
closure candidate. The gate is opt-in until the settled-success follow-up path
has an automatic remediation producer for non-blocking findings; operators can
enable it per host with
`roles.adversarial.merge_authority.strict_non_blocking_remediation: true` or the
matching env alias, and can roll back by setting that value to `false`.

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
      # Opt-in strict gate for settled-success reviews with non-blocking
      # findings. Default false preserves the existing auto-close path until
      # settled-success non-blocking findings have an automatic remediation
      # producer. When true, AMA emits `non-blocking-findings-present` and
      # requires an allowed waiver/remediation path before closure.
      strict_non_blocking_remediation: false
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
