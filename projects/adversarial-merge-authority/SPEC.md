# Adversarial Merge Authority (AMA) local contract mirror

This repository carries the adversarial-review implementation for AMA closure.
The full project spec lives in the parent Agent OS repository at this same path;
this local mirror records the config surface that the Node loader, closer
dispatch, and operator runbooks in this repo must keep aligned.

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
      worker_class: codex  # enum: codex | claude-code | hammer | gemini
      # Which merge method to use. `rebase` is not supported because
      # AMA requires one canonical landed closing commit for provenance
      # and audit reconciliation; GitHub's rebase path does not produce one.
      merge_method: squash  # enum: squash | merge
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
class as `Closed-By: <configured-worker-class>-closer (adversarial-pipe-mode)`.
