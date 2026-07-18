-- ARC-17 (Merge Authority v2 leased executor; docs/SPEC-merge-authority-v2.md §4).
-- The single-executor-per-subject lease, in the app store (NOT GitHub labels).
-- v2 serializes finalization execution through this durable lease so exactly one
-- executor acts on a subject at a time: one subject, one writer (§2 design
-- thesis). The lease is fenced by `lease_id` — release and renewal only affect a
-- row whose stored `lease_id` still matches the holder, so a stale holder can
-- never clobber a newer one (the HCM-01 crash-resume class: a restarted executor
-- folds the ledger and re-acquires; it never trusts in-memory progress).
--
-- Exactly one row per subject (the PRIMARY KEY). Acquisition is an atomic
-- `INSERT ... ON CONFLICT DO NOTHING`; an expired holder is stolen by a fenced,
-- compare-and-set `UPDATE` gated on the OLD `lease_id` and `deadline < now`, so
-- two concurrent stealers cannot both win. Time enters only as caller-supplied
-- data (`acquired_at`, `deadline`, `updated_at`); the store reads no clock, so
-- lease decisions are deterministic and replay-stable like the ledger fold.
CREATE TABLE IF NOT EXISTS finalization_executor_lease (
  domain_id           TEXT NOT NULL,
  subject_external_id TEXT NOT NULL,
  -- Opaque per-acquisition fence token. Release/renew must present this exact
  -- value; a mismatch is a stale holder and is refused without mutating the row.
  lease_id            TEXT NOT NULL,
  -- Opaque holder identity (e.g. `pid@host` or a worker id) for diagnostics.
  holder              TEXT NOT NULL,
  -- The revision the holder acquired the lease to act on, for operator triage.
  revision_ref        TEXT,
  -- ISO-8601 caller-supplied timestamps. `deadline` bounds how long a holder may
  -- hold before a contender may steal an expired lease; a live long-running merge
  -- renews (extends `deadline`) under its fence rather than being reclaimed.
  acquired_at         TEXT NOT NULL,
  deadline            TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  recorded_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (domain_id, subject_external_id)
);
