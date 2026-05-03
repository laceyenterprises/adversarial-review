## Summary

- Restored legacy-reply compatibility in `validateRemediationReply` by treating the per-finding contract as opt-in: strict coverage and blocker/re-review invariants now key off `addressed[]`, `pushback[]`, or structured blocker objects, while legacy string-blocker replies remain acceptable.
- Added an explicit reconcile regression test proving that a valid legacy-shape reply with empty stdout is still the durable success signal.
- Left `src/follow-up-remediation.mjs` and the worker prompt unchanged.

## Verification

- `env PATH=/usr/bin:/bin /opt/homebrew/bin/node --test test/follow-up-reconcile.test.mjs`
- `env PATH=/usr/bin:/bin /opt/homebrew/bin/node --test test/follow-up-jobs.test.mjs`
- `env PATH=/tmp/no-gh:/opt/homebrew/bin:/usr/bin:/bin npm test`

Note: local test runs mask `gh` from `PATH` because the fixture repo/PR in `test/follow-up-reconcile.test.mjs` now resolves live to a merged PR, which would otherwise trigger the non-test `operator-merged-pr` guardrail.

## Remediation Reply

```json
{
  "kind": "adversarial-review-remediation-reply",
  "schemaVersion": 1,
  "jobId": "LAC-348-worker-closeout",
  "repo": "laceyenterprises/adversarial-review",
  "prNumber": 0,
  "outcome": "completed",
  "summary": "Loosened remediation reply validation so legacy replies without per-finding fields remain valid while strict checks still apply to the new per-finding contract.",
  "validation": [
    "env PATH=/usr/bin:/bin /opt/homebrew/bin/node --test test/follow-up-reconcile.test.mjs",
    "env PATH=/usr/bin:/bin /opt/homebrew/bin/node --test test/follow-up-jobs.test.mjs",
    "env PATH=/tmp/no-gh:/opt/homebrew/bin:/usr/bin:/bin npm test"
  ],
  "addressed": [
    {
      "finding": "Per-finding validator semantics regressed the durable success signal for legacy remediation replies.",
      "action": "Introduced new-shape detection that treats addressed[], pushback[], or structured blockers as opt-in strict contract signals, while preserving legacy string-blocker replies.",
      "files": [
        "src/follow-up-jobs.mjs",
        "test/follow-up-reconcile.test.mjs"
      ]
    }
  ],
  "pushback": [],
  "blockers": [],
  "reReview": {
    "requested": true,
    "reason": "The validator now preserves the legacy durable-success path and the targeted reconcile regression is covered."
  }
}
```
