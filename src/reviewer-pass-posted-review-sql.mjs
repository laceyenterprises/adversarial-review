export const REVIEWER_PASS_POSTED_AT_SOURCE_SQL = 'COALESCE(body_captured_at, ended_at)';

export const REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL = `strftime(
  '%Y-%m-%dT%H:%M:%fZ',
  CASE
    WHEN REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T') GLOB '*Z'
      OR REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T') GLOB '*+??:??'
      OR REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T') GLOB '*-??:??'
      THEN REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T')
    ELSE REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T') || 'Z'
  END
)`;

export const REVIEWER_PASS_GENUINE_POSTED_REVIEW_WHERE_SQL = `gh_comment_id IS NOT NULL
  AND gh_comment_id <> ''
  AND ${REVIEWER_PASS_POSTED_AT_SOURCE_SQL} IS NOT NULL
  AND REPLACE(${REVIEWER_PASS_POSTED_AT_SOURCE_SQL}, ' ', 'T') GLOB '????-??-??T??:??:??*'`;

// Same UTC normalization as the posted-at expression above, for `started_at`.
// `reviewer_passes` timestamps arrive in BOTH shapes — JS `toISOString()` with a
// trailing `Z`, and SQLite `CURRENT_TIMESTAMP`, which is space-separated and
// tz-less. A raw lexicographic compare mixes them wrongly, because ' ' (0x20)
// sorts BEFORE 'T' (0x54): `'2026-09-21 23:00:00' < '2026-09-21T12:00:00Z'`.
// Any window predicate that compares the two shapes directly therefore drops
// same-day rows written by the other writer. Normalize both sides instead.
export const REVIEWER_PASS_NORMALIZED_STARTED_AT_SQL = `strftime(
  '%Y-%m-%dT%H:%M:%fZ',
  CASE
    WHEN REPLACE(started_at, ' ', 'T') GLOB '*Z'
      OR REPLACE(started_at, ' ', 'T') GLOB '*+??:??'
      OR REPLACE(started_at, ' ', 'T') GLOB '*-??:??'
      THEN REPLACE(started_at, ' ', 'T')
    ELSE REPLACE(started_at, ' ', 'T') || 'Z'
  END
)`;

export const REVIEWER_MODELS = Object.freeze(['claude', 'codex', 'gemini']);

export function parseReviewerPassTimestampMs(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
