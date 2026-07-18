-- ARC-16 (Merge Authority v2 shadow mode; docs/SPEC-merge-authority-v2.md §5).
-- The append-only record of shadow finalization observations: for every live
-- finalization tick, ONE row pairing what frozen v1 actually did (`v1_action_kind`)
-- with the pure v2 decision the fold WOULD have made (`v2_decision_kind`) and the
-- divergence classification between them. Shadow mode NEVER acts — this table is
-- pure telemetry that feeds `finalization shadow-report` (SPEC §1 Win 3) and the
-- operator-approved promotion gate (§5.3).
--
-- `observed_at` is the tick time the report windows on (`--days N`). `relation`
-- is 'agree' | 'diverge'; `direction`/`divergence_class` carry the bidirectional
-- triage proposal (v1 is the known-buggy system, but a divergence is evidence,
-- not an automatic v1 defect — see docs/finalization-shadow-divergence-triage.md).
-- `disposition` is the classifier's proposal; `disposition_override_json` holds a
-- human's overriding triage when present (the report honors the override). Only
-- an 'open' disposition blocks promotion.
CREATE TABLE IF NOT EXISTS finalization_shadow (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id                 TEXT NOT NULL,
  subject_external_id       TEXT NOT NULL,
  revision_ref              TEXT,
  -- ISO-8601 tick time. The report's `--days` window filters on this; the pure
  -- decision itself never reads a clock (the caller supplies `observedAt`).
  observed_at               TEXT NOT NULL,
  relation                  TEXT NOT NULL,          -- 'agree' | 'diverge'
  direction                 TEXT NOT NULL,          -- 'v1-defect' | 'v2-suspect' | 'open' | 'benign'
  divergence_class          TEXT,                   -- e.g. 'ci-impatience', 'unclassified'
  disposition               TEXT NOT NULL,          -- classifier proposal: 'resolved' | 'open'
  v1_action_kind            TEXT NOT NULL,
  v2_decision_kind          TEXT NOT NULL,
  fold_error                INTEGER NOT NULL DEFAULT 0,
  saw_head_move             INTEGER NOT NULL DEFAULT 0,
  saw_exhaustion            INTEGER NOT NULL DEFAULT 0,
  -- The full observation (v1 action, v2 decision, classification) as JSON.
  payload_json              TEXT NOT NULL DEFAULT '{}',
  -- A human's overriding triage disposition, when present: { disposition, note,
  -- principal, at }. NULL means the classifier proposal stands.
  disposition_override_json TEXT,
  recorded_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The report reads observations by tick time within the requested window.
CREATE INDEX IF NOT EXISTS idx_finalization_shadow_observed_at
  ON finalization_shadow(observed_at);

CREATE INDEX IF NOT EXISTS idx_finalization_shadow_subject
  ON finalization_shadow(domain_id, subject_external_id, id);
