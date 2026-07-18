-- ARC-15 (Merge Authority v2 core; docs/SPEC-merge-authority-v2.md §2). The
-- append-only per-subject finalization event ledger. One subject, one durable
-- state machine, one writer: every finalization fact — head moves, verdicts,
-- checks, attestations, remediation dispatch/conclusion, budget exhaustion,
-- operator overrides, and the terminal finalized/closed/escalated/halted marks
-- — lands here as an ordered row. Eligibility is a PURE fold over these rows
-- (src/finalization/ledger-fold.mjs + eligibility.mjs); nothing in this table is
-- ever updated or deleted, so a crashed executor simply re-folds and continues
-- (HCM-01 phantom-die class eliminated structurally).
--
-- `seq` is the global monotonic append order the fold replays in. Every external
-- fact carries its provenance in `source_ref` (GitHub review commit_id, check-run
-- id, ledger row id) so "verdict at head" is verified by construction — the fold
-- matches a verdict only when its `revision_ref` equals the candidate revision,
-- never by comparing a log line to a head pointer.
CREATE TABLE IF NOT EXISTS finalization_ledger (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id           TEXT NOT NULL,
  subject_external_id TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  -- Revision-scoped events (revision_advanced, verdict_recorded, checks_settled,
  -- attestation_recorded, remediation_*, finalized) pin their revision here.
  -- Subject-scoped events (budget_exhausted, operator_override, closed,
  -- escalated, halted) leave it NULL.
  revision_ref        TEXT,
  -- ISO-8601. Time enters the pure fold ONLY as this event data — the fold and
  -- eligibility never read a clock.
  at                  TEXT NOT NULL,
  -- Provenance of an external fact: review commit_id, check-run/suite id, or a
  -- ledger row id. NULL for internally-generated marks.
  source_ref          TEXT,
  -- Append idempotency for dispatch-style events (remediation_dispatched carries
  -- the same idempotency-key scheme as reviews). NULL when not applicable.
  idempotency_key     TEXT,
  -- Type-specific fields (stageId, role, verdictKind, conclusion,
  -- requiredChecksPresent, round, outcome, method, reason, principal, kind, …).
  payload_json        TEXT NOT NULL DEFAULT '{}',
  recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Replay reads a subject's whole ledger in append order.
CREATE INDEX IF NOT EXISTS idx_finalization_ledger_subject
  ON finalization_ledger(domain_id, subject_external_id, seq);

-- Append idempotency: a dispatch replayed with the same idempotency key must not
-- double-append. Partial index so the many events without a key are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS finalization_ledger_idempotency_unique
  ON finalization_ledger(domain_id, subject_external_id, event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
