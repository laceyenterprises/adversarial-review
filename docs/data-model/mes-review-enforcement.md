# MES review-service consumer (MES-09)

The review service consumes the existing version 1 `hq mes decide --record
--json --request-json <value-free request>` contract. Agent OS owns the ledger;
this change creates no local table or new stored fields. Requests retain
`workKind`, `subjectKey`, `attempt`, PR/head identity, closed numeric/boolean/enum
signals and the pre-policy `actual` execution. Titles, paths, prompts and finding
text stay inside the process. The CLI owns `overridden_by` persistence from the
explicit `actual.source` (`env`, `reviewerArm`, `osg-apply`).

A response is usable only after successful CLI exit, `schemaVersion: 1`,
`recorded: true`, a string `decisionId`, no CLI/record error, and `apply: true`.
The resolver treats `choice: {workerClass, model, effort}` as an optional pin
below env/OSG explicit inputs and above the registry default. An explicit model
or effort protects the pair. The selected role must equal the existing role,
exclude corporate and Gemini roles, and the live registry must authorize both
`allowedModels` and `reasoningLevelsByModel[model]`. Effort is limited to low,
medium, high or xhigh. Committed outage seeds do not authorize policy choices.

`modelSource` and `reasoningSource` become `mes` when applied; existing worker
and review execution descriptors carry these fields. Codex translates the
resolved effort to `model_reasoning_effort`, Claude to `--effort`. Local Claude
model auth runs after selection. Codex refreshes registry validation after auth.
A chunked review records once and carries the selected pair to later chunks.

Standalone local Codex/Claude runtime calls without a MES job retain an explicit
request resolution or resolve the governed default before model auth, then pass
that same pair to spawn. The environment pin predicate accepts both local
`codex`/`claude-code` aliases and governed registry class names.

`apply: false` restores implicit execution on the next launch without a cache.
Missing CLI, timeout, invalid JSON, nonzero exit and recording failures retain
static execution and the existing fixed diagnostic reasons. Invalid choices
emit `invalid-policy`; re-resolution failures emit `resolver-error`. CLI work
retains its five-second total bound (four duplicate attempts maximum); optional
local numstat collection retains its two-second bound. No policy error changes
round budgets, merge predicates, worker pools or provider account order.

Synthetic offline fixtures cover precedence, disabled enforcement, malformed
choices, CLI failures, broker model ordering and both launch formats. The
provisioned producer still returns `enforcement-unregistered` with apply false;
live application and post-application ledger reconciliation remain unverified.
Deploy through the normal review-service release. MES-12/MES-13 operator
activation and any privileged restart are separate; read natural decision
reasons and execution provenance after deployment without forcing live work.
