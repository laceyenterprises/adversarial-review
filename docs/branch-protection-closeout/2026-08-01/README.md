# Branch-Protection Closeout — 2026-08-01

This directory is the tracked closeout snapshot for `ARC-29`.

- `summary.json` is the aggregated `check-branch-protection --json --apply` result captured on August 1, 2026 at `2026-08-01T16:22:40.077Z`.
- `laceyenterprises__*.json` files are the per-repo audit records emitted by the same command.
- Every unresolved repo in this snapshot reported `reason=branch-protection-missing`, so the operator follow-up is the bootstrap command embedded in each JSON record's `manualCommand`.
- While any repo/domain still has unresolved `branch-protection-missing` or `branch-protection-forbidden` evidence and policy keeps `branch_protection.required=true`, AMA's autonomous merge path now refuses the protected path with `branch-protection-missing-gate` instead of merging fail-open.
- This live closeout run used the worker's provisioned `GH_TOKEN`. For this token on August 1, 2026, the GitHub API returned `404`/missing branch-protection state for every watched repo, including `laceyenterprises/adversarial-review` and `laceyenterprises/agent-os`; it did not return any `branch-protection-forbidden` rows.

Regenerate with:

```bash
node src/check-branch-protection.mjs --json --apply \
  --evidence-dir docs/branch-protection-closeout/2026-08-01 \
  > docs/branch-protection-closeout/2026-08-01/summary.json
```
