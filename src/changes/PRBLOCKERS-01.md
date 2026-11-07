# PR blockers report

`npm run pr-blockers -- --repo example/project [--repo example/other] [--json]`
reports every open PR with review coverage, post-review authors, external CI,
durable closer ownership, mergeability, age, conflicts and a next action.
The JSON contract is version 1; its schema is `docs/pr-blockers.schema.json`.

Actions project `nextAction(snapshot)`, the shared rescue/closure policy.
The full decision remains in JSON. Unreadable evidence stays unknown and
holds, finding remediation and CI observation retain their shared actions.
`closerLeaseDeadline(lease)` exposes the shared lease-window projection so
the report distinguishes an expired owner from its successor's recovery deadline.
This diagnostic creates no pipeline records and performs no GitHub mutations.
Its eligibility column is a diagnostic formula, not merge authorization.

Conflict inspection is optional, bounded and offline against an explicitly
supplied checkout. It uses disposable Git objects and the existing base-pinned
generated-path declaration reader. It never fetches or updates the checkout.
