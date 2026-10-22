# Remediator execution contract

OSG-14 consumes an already recorded remediator assignment for a PR's ticket.
It never creates an experiment, changes an assignment or grants merge authority.
All OSG configuration defaults remain off.

`src/osg-remediator.mjs` reads the mode through the existing role config loader.
Off returns the exact caller-owned default object without owner/account calls or
evidence writes. Active mode calls the registered ledger owner's
`cwp_dispatch.osg_remediator` module over JSON stdio, with a fixed 1.5-second
transport deadline, bounded output and no retries. The deadline timer is unreferenced
so it cannot keep the host event loop alive on its own. The owner checks unique PR to
ticket attribution, experiment role, assignment mode, catalog approval, recorded
availability, class/role model and effort support, and account budget windows.
It reads existing snapshots; it does not refresh providers or fetch credentials.

An applicable proposal must resolve to an existing canonical hammer or remediator
role. The service checks its account through `selectWorkerTokenAccount`, using
the proposed model. Unknown, held, changed or undeclared account proposals fall
back to the caller's current route. A different nonterminal remediator family
also retains the existing next-round reviewer exclusion. A same-role execution
change preserves the default route's diversity decision. Base worker classes,
remediator roles and corporate aliases are compared through the existing builder
family normalizer. Shadow logs only.

The resulting model and reasoning effort travel through managed dispatch for
both supported model families. Effort uses the owner's top-level override when
non-null, otherwise the catalog's `arm.effort`. Missing, empty, non-string and
`default` effort values omit `--reasoning-level`; explicit effort is forwarded.
After final routing, follow-up dispatch clears the legacy `CODEX_BROKER_PROVIDER`
environment override for pooled accounts and non-Codex workers. Unpooled Codex
routes retain their selected legacy provider.
ITP still revalidates readiness and acquires the execution lease at admission.
A proposal is not an account pin or lease. Actual
account bindings remain authoritative; the corpus records admission-time account
changes separately with unknown realized propensity. No account twins or
parallel account policy are introduced.

The hammer retains its logical class for prompts, trailers, authority, rebase,
lease and merge eligibility. A validated terminal-remediation head keeps the
existing no-re-review rule. The physical execution class remains one of the
existing privileged hammer roles.

Every active-mode attempt atomically records a UUID-named JSON observation under
`<adversarial review state dir>/osg-remediator/` (default `data/osg-remediator/`,
overridden by `ADVERSARIAL_REVIEW_STATE_DIR`). It contains a version, PR subject,
role kind, timestamp, default class, stable reason, assignment when available and selected arm/account
proposal when applied. Failure to record an arm keeps the default. Follow-up
workers and successful closer records also retain `osgRemediator` metadata.
The closer's AMA audit resolves OSG before recording `harnessResolution`, which
includes the selected physical class, model resolution, account proposal and
OSG observation. Existing harness holds remain authoritative and skip OSG.
No exception/provider text or credentials enter these records.

The explicit corpus refresh joins assignments to existing remediation runs,
findings, fixing commits, defect attribution and authoritative ITP bindings.
Missing measurements remain unknown. Observed defect edges are not mature
T+7/T+30 labels. This change adds no schedule, workflow or required check.

Deploy the registered ledger owner before any active-mode canary. Leave modes
off until the configuration owner performs the separately governed rollout.
An unavailable owner or an empty arm catalog preserves current dispatch behavior.
