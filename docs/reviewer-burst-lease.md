# Reviewer burst capacity lease

Burst capacity is default-off. With no active lease, the watcher continues to
use `watcher.first_pass_reviewer_pool_max_concurrent_reviewers` unchanged.
Leases last at most two hours, require an explicit repository scope, may be
limited to PRs labelled `pack:<id>` or `active-pack:<id>`, and cannot reserve
more slot-minutes than the supplied budget.

Request a ten-minute, two-slot burst after verifying all three safety signals:

```bash
npm run reviewer-burst -- request \
  --ttl-minutes 10 --additional-slots 2 \
  --repo laceyenterprises/agent-os --active-pack demo-2026-09 \
  --budget-slot-minutes 20 --reason "operator demo" \
  --requested-by "$USER" --quota-safe --posting-safe --reviewer-healthy
```

Inspect the current state directly with `npm run reviewer-burst -- status` or
under `reviewerBurst` in `npm run pipeline-health -- --json`. Requests missing
any safety attestation are denied. Existing credential, memory, and posting
admission checks remain authoritative while a lease is active, so pressure
degrades throughput instead of bypassing a safety gate.

Rollback does not require stopping or restarting the watcher:

```bash
npm run reviewer-burst -- revoke --requested-by "$USER" --reason "rollback"
```

The lease also expires automatically at its TTL. Requested, activated, denied,
expired, and manually revoked transitions append to
`data/reviewer-capacity/burst-events.jsonl`.
