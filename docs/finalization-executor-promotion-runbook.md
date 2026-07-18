# Merge Authority v2 — Executor Promotion Runbook

**Owner:** ARC-17 (Merge Authority v2 leased executor)
**Applies to:** `src/finalization/executor.mjs` (+ `executor-lease-store.mjs`,
`execution-surfaces.mjs`)
**Design:** `docs/SPEC-merge-authority-v2.md` §4–5.

The MA-v2 executor is the single leased worker that turns the pure
`eligible(fold(ledger), policy)` decision into a merge / remediation dispatch /
close. It **ships gated off**: `createFinalizationExecutor({ enabled: false })`
makes every `tick()` inert — no lease is taken, no ledger event is written, no
adapter is called. Promotion is an **operator action**, taken only after the
shadow gate clears. This runbook is that procedure.

> Frozen v1 merge authority (`src/ama/*`, `follow-up-merge-agent.mjs`, the
> daemon-clean path) keeps acting until — and only until — this executor is
> promoted. Do not disable v1 before step 4.

---

## 1. Gate criteria (must ALL hold before promotion)

The gate is the shadow-mode promotion verdict from ARC-16 (§5.3). Read it with:

```
adversarial-review finalization shadow-report --days 7 --json
```

Promote only when `promotable: true`, i.e. `blockers: []`. Each blocker maps to a
criterion that must be satisfied first:

| Criterion | Report field | Meaning |
|---|---|---|
| **Coverage window** | `coverage.enoughDays` | Shadow has run ≥ N days (default 7). |
| **Some traffic** | `shadowed > 0` | The window actually contains shadowed finalizations. |
| **Zero open divergences** | `openDivergences === 0` | Every `(v1, v2)` divergence in the window is dispositioned (classifier fingerprint or human override); only an `open` disposition blocks. Triage per `docs/finalization-shadow-divergence-triage.md`. |
| **Organic head-move seen** | `organicHeadMoves ≥ 1` | At least one real revision advance was observed in shadow — proof the per-revision fold behaved on a moving head. |
| **Exhaustion close seen** | `exhaustionCloses ≥ 1` | At least one budget-exhaustion close was observed — proof the land-on-exhaustion path was exercised. |

If `promotable: false`, **stop.** Do not promote on a red gate. Address the
listed blockers (usually: keep shadow running for more coverage, or triage the
open divergences) and re-check.

Record the passing report (the `--json` blob) in the promotion ticket as the
evidence of record.

---

## 2. Pre-promotion checklist

- [ ] Shadow report is `promotable: true` (§1), evidence attached to the ticket.
- [ ] Eligibility policy is validated at load: `consume_attestations` is only on
      when a producer is configured (`normalizePolicy` throws otherwise — this is
      the LHA-cutover guard, verify it does not throw on the target config).
- [ ] The merge seam is resolved for the target host: either the ARC-20
      adjudicate surface is wired, or the github-adapter local fallback binary is
      resolvable (`GHA_ADAPTER_BIN` / auto-discovery). With neither, a
      `finalize-now` fails closed to `escalate` — never a phantom merge.
- [ ] The ARC-22 identity/attestation surface is wired (or you have accepted
      local-mode token identity, in which case a missing surface is `ok: true`,
      `localMode: true`). An explicit attestation denial records terminal
      `escalated`; a surface exception fails only the current tick so transient
      infrastructure errors can be retried.
- [ ] The kill switch is reachable: `policy.autonomousExecutionDisabled = true`
      demonstrably intercepts a mutating decision (see §4).
- [ ] An operator with merge authority approves (this is not an automated flip).

---

## 3. Promotion (one flag, one bounce)

Promotion flips the executor's master gate from off to on. It is a single change:

1. Set the executor's `enabled` flag to `true` for the target domain
   (`createFinalizationExecutor({ enabled: true, ... })` in the daemon wiring).
2. Disable the corresponding frozen v1 actors by config (**step 4** of §5 in the
   design): v1 clean-path close + hammer dispatch for the promoted domain.
3. Bounce the watcher/daemon so both take effect together.

After the bounce, exactly one authority acts per subject: the leased executor.
v1 code is **retained for one release cycle** as the documented rollback.

---

## 4. Kill switch (fail-closed, audited)

The kill switch is orthogonal to promotion and always available on a promoted
executor. Setting `policy.autonomousExecutionDisabled = true`:

- Intercepts **every** mutating decision (`finalize-now`, `remediate`, `close`)
  **before any adapter is called** — no merge, no PR close, no worker dispatch,
  no commit or push proceeds.
- Preserves remediation idempotency: replaying a remediation round that is
  already recorded as dispatched remains a no-op skip rather than becoming a
  terminal escalation.
- Writes a **fail-closed audit row**: an `escalated` finalization ledger event
  whose reason is `kill switch: <decision> intercepted (autonomous execution
  disabled)`. This is durable and inspectable by folding the subject's ledger.
- Does **not** re-page: once a subject is terminal-`escalated`, a later tick
  re-reads the mark and does not append a duplicate (§3).

`eligible()` also gates mutating decisions to `escalate` when the switch is on,
so the interception is defense-in-depth: even a decision computed under a
different policy is re-checked at the executor's mutation boundary.

**To engage the kill switch in an incident:** set
`autonomousExecutionDisabled: true` and bounce. The executor stays live (leases,
folds, records) but performs zero mutations, and every would-be mutation leaves
an audit trail in the ledger.

---

## 5. Rollback (one flag)

To roll back to frozen v1:

1. Set the executor `enabled` flag back to `false` (inert; no lease, no writes).
2. Re-enable the v1 actors disabled in §3 step 2.
3. Bounce the watcher/daemon.

Because the ledger is append-only and the executor is idempotent (re-fold guard
+ `matchHeadCommit` + terminal short-circuit), rolling back and forward is safe:
a re-promoted executor folds the existing ledger and resumes; it never
double-merges a subject already marked `finalized`. A crash or ledger failure
after the remote merge but before that mark is also resumable: the local GitHub
adapter fallback recognizes structured `already merged` evidence only when it
names the decided revision, then the executor records the missing `finalized`
event. A revision mismatch or unstructured refusal remains a failed attempt.

If you need to stop mutations **without** ceding authority back to v1 (e.g. mid
investigation), prefer the **kill switch** (§4) over rollback — it keeps the v2
ledger authoritative and audited while pausing all execution.
