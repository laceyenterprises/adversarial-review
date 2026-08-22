/**
 * The ARF review-state store adapter (ARF-01).
 *
 * This is the data seam every later ARF ticket reads through. It projects
 * PR-scoped **rounds / passes / findings** out of either:
 *
 *   - `in-os` mode: a live pipeline's `reviews.db`, opened read-only, or
 *   - `standalone` mode: an equivalent SQLite file ARF owns.
 *
 * Both modes read through the same SQL, so the standalone shape cannot drift
 * from the live one.
 *
 * Honesty rules this adapter holds to:
 *
 *   - **Never crash on an absent or foreign store.** A missing file, a stray
 *     non-database file, or an adversarial-review install whose schema predates
 *     a column all produce a valid empty (or field-wise NULL) projection, with
 *     `store.available` saying so. A blank screen with `available: false` is
 *     honest; a 500 is not.
 *   - **No fabricated fields.** `reviews.db` carries no PR title, builder, risk
 *     class, or round budget, so this adapter does not emit them at all — not
 *     even as `PR #<n>` placeholders. ARF-02's GitHub mirror is the source for
 *     those, and a placeholder here would make a missing mirror invisible.
 *   - **Read handles only.** Every projection opens read-only; see `sqlite.mjs`.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { MODE_IN_OS, MODE_STANDALONE } from '../config.mjs';
import { parseFindings } from './findings.mjs';
import { ARF_STORE_SCHEMA_VERSION, STANDALONE_SCHEMA_SQL } from './schema.mjs';
import {
  closeQuietly,
  openReadOnly,
  openWritableStandalone,
  queryOrDegrade,
  tableColumns,
  tolerantSelectList,
} from './sqlite.mjs';

const PR_COLUMNS = [
  'repo', 'pr_number', 'pr_state', 'review_status', 'reviewer', 'reviewer_head_sha',
  'review_attempts', 'failure_message', 'reviewed_at', 'last_attempted_at',
  'merged_at', 'closed_at', 'linear_ticket', 'labels_json',
];

const PASS_COLUMNS = [
  'pass_id', 'repo', 'pr_number', 'attempt_number', 'reviewer_class', 'reviewer_model',
  'pass_kind', 'verdict', 'status', 'head_sha', 'gh_comment_id', 'body_md',
  'body_captured_at', 'started_at', 'ended_at',
];

const CYCLE_COLUMNS = [
  'pr_url', 'head_sha', 'verdict_count', 'last_verdict_at', 'escalated_at',
];

const DEFAULT_LIST_LIMIT = 200;

/** The pipeline's review-cycle key: `https://github.com/<owner>/<repo>/pull/<n>`. */
const PR_URL_PATTERN = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

function text(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

function int(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

function shortSha(value) {
  const sha = text(value);
  return sha ? sha.slice(0, 7) : null;
}

function labels(labelsJson) {
  const raw = text(labelsJson);
  if (!raw) return [];
  return queryOrDegrade(() => {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((label) => text(label && typeof label === 'object' ? label.name : label))
      .filter(Boolean);
  }, []);
}

/**
 * A column reference that survives the column being absent from the live store.
 * Every SQL fragment below goes through this, so one missing column degrades
 * that column's contribution instead of failing the whole query into a blank.
 */
function colRef(present, alias, column, fallbackSql) {
  return present.has(column) ? `${alias}."${column}"` : fallbackSql;
}

/**
 * The state filter, expressed against `reviewed_prs`.
 * `merged_at` is checked alongside `pr_state` because a merged row can lag in
 * `pr_state` — SPEC §6 and the pipeline's own scars: local `pr_state` is
 * unreliable in both directions, so an open list must not surface a merged PR.
 */
function stateWhere(state, prColumns) {
  const prState = colRef(prColumns, 'rp', 'pr_state', "'open'");
  const mergedAt = colRef(prColumns, 'rp', 'merged_at', 'NULL');
  switch (String(state ?? 'open').toLowerCase()) {
    case 'all':
      return '1 = 1';
    case 'closed':
      return `((${mergedAt} IS NOT NULL AND ${mergedAt} != '') OR COALESCE(${prState}, 'open') != 'open')`;
    case 'open':
    default:
      return `COALESCE(${prState}, 'open') = 'open' AND (${mergedAt} IS NULL OR ${mergedAt} = '')`;
  }
}

/**
 * Ordering for the PR list.
 *
 * PR numbers are repository-local, so ordering by number alone interleaves
 * unrelated repos into a sequence that means nothing. Order by most recent
 * review activity instead, which is the same thing an operator scanning the
 * list is actually asking for. `repo` then `pr_number` break ties so the list
 * is deterministic, including on a store that carries neither timestamp (both
 * degrade to NULL, which SQLite sorts last under DESC).
 */
function listOrderBy(prColumns) {
  const lastAttemptedAt = colRef(prColumns, 'rp', 'last_attempted_at', 'NULL');
  const reviewedAt = colRef(prColumns, 'rp', 'reviewed_at', 'NULL');
  return `COALESCE(${lastAttemptedAt}, ${reviewedAt}) DESC, rp."repo" ASC, rp."pr_number" DESC`;
}

/** Deterministic pass ordering that tolerates a missing ordering column. */
function passOrderBy(alias, passColumns) {
  const startedAt = colRef(passColumns, alias, 'started_at', 'NULL');
  const passId = colRef(passColumns, alias, 'pass_id', 'NULL');
  return { startedAt, passId };
}

export class ReviewStore {
  /**
   * @param {ReturnType<import('../config.mjs').loadConfig>} config
   * @param {{uid?: number|null}} [options] `uid` overrides the effective uid the
   *   cross-owner sidecar guard compares against; tests inject it so the guard's
   *   branches are reachable without a second account. Production leaves it
   *   undefined and the guard reads `process.getuid()`.
   */
  constructor(config, { uid } = {}) {
    this.config = config;
    this.mode = config.mode;
    this.path = config.storePath;
    this.readOnly = config.readOnly;
    this.busyTimeoutMs = config.busyTimeoutMs;
    this.uid = uid;
  }

  /** True when ARF owns this file and may provision it (standalone only). */
  get ownsStore() {
    return this.mode === MODE_STANDALONE;
  }

  /**
   * Create the standalone store file and schema if it does not exist.
   * A no-op in `in-os` mode: that store is pipeline-owned and ARF never
   * provisions, migrates, or writes it.
   */
  provision() {
    if (!this.ownsStore) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    const db = openWritableStandalone(this.path, this.config);
    try {
      db.exec(STANDALONE_SCHEMA_SQL);
      db.prepare('INSERT OR REPLACE INTO arf_store_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(ARF_STORE_SCHEMA_VERSION));
    } finally {
      closeQuietly(db);
    }
    return true;
  }

  /**
   * @returns {{db: object|null, prColumns?: Set<string>, passColumns?: Set<string>,
   *            reason: string|null}}
   */
  #open() {
    const { db, reason } = openReadOnly(this.path, {
      busyTimeoutMs: this.busyTimeoutMs,
      uid: this.uid,
    });
    if (!db) return { db: null, reason };
    const prColumns = tableColumns(db, 'reviewed_prs');
    if (!prColumns.has('repo') || !prColumns.has('pr_number')) {
      // Not a review-state store at all (or a schema too old to key on).
      closeQuietly(db);
      return { db: null, reason: null };
    }
    return { db, prColumns, passColumns: tableColumns(db, 'reviewer_passes'), reason: null };
  }

  /** The store descriptor for a known availability, without opening anything. */
  #status(available, reason = null) {
    return {
      mode: this.mode,
      path: this.path,
      pathSource: this.config.storePathSource,
      readOnly: this.readOnly,
      ownsStore: this.ownsStore,
      available,
      // Why an unavailable store is unavailable, so the UI can say something
      // better than "no data". A specific refusal (e.g. a cross-owner store with
      // live WAL sidecars) carries its own sentence — the generic one would
      // point an operator at "the pipeline has not run yet" when the real fix is
      // "run ARF as the store owner".
      reason: available
        ? null
        : (reason
          ?? (this.mode === MODE_IN_OS
            ? 'no readable reviews.db at the configured path (pipeline not present or not yet run)'
            : 'standalone store not provisioned or not readable')),
    };
  }

  /** Store status, safe to call at any time — never throws on an absent store. */
  describe() {
    const opened = this.#open();
    if (opened.db) closeQuietly(opened.db);
    return this.#status(opened.db !== null, opened.reason);
  }

  /**
   * PR-level projection.
   *
   * @param {{state?: string, limit?: number}} [options]
   * @returns {{store: object, pullRequests: object[]}}
   */
  pullRequests({ state = 'open', limit = DEFAULT_LIST_LIMIT } = {}) {
    const opened = this.#open();
    if (!opened.db) return { store: this.#status(false, opened.reason), pullRequests: [] };
    const { db, prColumns, passColumns } = opened;
    try {
      const rows = queryOrDegrade(() => db.prepare(`
        SELECT ${tolerantSelectList('rp', prColumns, PR_COLUMNS)}
               ${latestPassSelect(passColumns)}
        FROM reviewed_prs rp
        ${latestPassJoin(passColumns)}
        WHERE ${stateWhere(state, prColumns)}
        ORDER BY ${listOrderBy(prColumns)}
        LIMIT ?
      `).all(Math.max(0, int(limit) || DEFAULT_LIST_LIMIT)), []);
      return {
        store: this.#status(true),
        pullRequests: rows.map((row) => projectPullRequest(row)),
      };
    } finally {
      closeQuietly(db);
    }
  }

  /**
   * One PR's full review state: the PR row, its rounds, its passes, and the
   * findings parsed out of each pass body.
   *
   * @param {{repo?: string|null, prNumber: number}} params
   * @returns {{store: object, pullRequest: object|null, rounds: object[], passes: object[], findings: object[], repoMatches?: string[]}}
   */
  pullRequest({ repo = null, prNumber }) {
    const pr = int(prNumber);
    const opened = this.#open();
    // The empty projection is the same shape as a populated one — a caller that
    // renders it never has to branch on "store missing" to avoid a crash.
    const empty = { pullRequest: null, rounds: [], passes: [], findings: [] };
    if (!opened.db) return { store: this.#status(false, opened.reason), ...empty };
    const { db, prColumns, passColumns } = opened;
    const found = { store: this.#status(true), ...empty };
    try {
      let repoFilter = text(repo);
      if (!repoFilter) {
        // PR numbers are repository-local; with the same number in two repos,
        // picking one would silently mix two review timelines.
        const matches = queryOrDegrade(() => db.prepare(
          'SELECT DISTINCT repo FROM reviewed_prs WHERE pr_number = ? ORDER BY repo ASC',
        ).all(pr), []);
        if (matches.length === 0) return found;
        if (matches.length > 1) {
          return {
            ...found,
            ambiguousRepo: true,
            repoMatches: matches.map((row) => text(row.repo)).filter(Boolean),
          };
        }
        repoFilter = text(matches[0].repo);
      }

      const row = queryOrDegrade(() => db.prepare(`
        SELECT ${tolerantSelectList('rp', prColumns, PR_COLUMNS)}
               ${latestPassSelect(passColumns)}
        FROM reviewed_prs rp
        ${latestPassJoin(passColumns)}
        WHERE rp.repo = ? AND rp.pr_number = ?
      `).get(repoFilter, pr), null);
      if (!row) return found;

      const passOrder = passOrderBy('p', passColumns);
      const passRows = hasJoinablePasses(passColumns)
        ? queryOrDegrade(() => db.prepare(`
          SELECT ${tolerantSelectList('p', passColumns, PASS_COLUMNS)}
          FROM reviewer_passes p
          WHERE p.repo = ? AND p.pr_number = ?
          ORDER BY ${passOrder.startedAt} ASC, ${passOrder.passId} ASC
        `).all(repoFilter, pr), [])
        : [];

      const passes = passRows.map((passRow) => projectPass(passRow));
      const findings = passes.flatMap((pass) => pass.findings);
      return {
        ...found,
        pullRequest: projectPullRequest(row),
        rounds: groupRounds(passes),
        passes,
        findings,
      };
    } finally {
      closeQuietly(db);
    }
  }

  /**
   * Review-cycle counter rows — the per-head round-budget accounting Screen B
   * burns down (ARF-04).
   *
   * One row per `(pr_url, head_sha)`: `verdict_count` is how many rounds this
   * head has consumed, and `escalated_at` is set once the cap was reached and
   * the PR escalated. The projection is intentionally raw — the cap itself is a
   * *config* value, not a store value, so pairing count with cap belongs to the
   * governance layer and not here.
   *
   * `pr_url` is the pipeline's key (`https://github.com/<repo>/pull/<n>`), so
   * `repo` and `pr` are parsed back out of it. A row whose URL does not parse
   * keeps its `prUrl` and reports both as null rather than being dropped: a
   * counter ARF cannot attribute is still a counter that is burning budget.
   *
   * @param {{limit?: number}} [options]
   * @returns {{store: object, cycles: object[]}}
   */
  reviewCycles({ limit = DEFAULT_LIST_LIMIT } = {}) {
    const opened = this.#open();
    if (!opened.db) return { store: this.#status(false, opened.reason), cycles: [] };
    const { db } = opened;
    try {
      const columns = tableColumns(db, 'review_cycle_counters');
      // A store predating the table (or a foreign schema) has no budget to show.
      // An empty burndown is honest; a thrown query would take the panel down.
      if (!columns.has('pr_url')) return { store: this.#status(true), cycles: [] };
      const lastVerdictAt = colRef(columns, 'c', 'last_verdict_at', 'NULL');
      const rows = queryOrDegrade(() => db.prepare(`
        SELECT ${tolerantSelectList('c', columns, CYCLE_COLUMNS)}
        FROM review_cycle_counters c
        ORDER BY ${lastVerdictAt} DESC, c."pr_url" ASC
        LIMIT ?
      `).all(Math.max(0, int(limit) || DEFAULT_LIST_LIMIT)), []);
      return { store: this.#status(true), cycles: rows.map((row) => projectReviewCycle(row)) };
    } finally {
      closeQuietly(db);
    }
  }

  /**
   * Findings rows for one PR, flattened across every pass.
   *
   * The ambiguity flags ride along: without them an unqualified PR number that
   * exists in two repos would return `findings: []`, which a caller cannot tell
   * apart from a PR that genuinely has no findings.
   *
   * @returns {{store: object, findings: object[], ambiguousRepo?: boolean, repoMatches?: string[]}}
   */
  findings({ repo = null, prNumber }) {
    const detail = this.pullRequest({ repo, prNumber });
    const result = { store: detail.store, findings: detail.findings };
    if (detail.ambiguousRepo) {
      result.ambiguousRepo = true;
      result.repoMatches = detail.repoMatches;
    }
    return result;
  }
}

/** True when `reviewer_passes` can be joined to `reviewed_prs` at all. */
function hasJoinablePasses(passColumns) {
  return passColumns.has('repo') && passColumns.has('pr_number');
}

/** Pass columns the PR-list projection carries, as `<column> -> <output alias>`. */
const LATEST_PASS_COLUMNS = [
  ['verdict', 'latest_verdict'],
  ['reviewer_class', 'latest_reviewer_class'],
  ['head_sha', 'latest_head_sha'],
  ['pass_kind', 'latest_pass_kind'],
  ['status', 'latest_status'],
  ['body_md', 'latest_body_md'],
  ['attempt_number', 'latest_attempt_number'],
  ['gh_comment_id', 'latest_gh_comment_id'],
];

/**
 * The latest pass per PR, so the list projection can carry the current verdict.
 *
 * The join keys on a correlated `LIMIT 1` lookup: SQLite evaluates it per
 * `reviewed_prs` row against `idx_reviewer_passes_pr (repo, pr_number)`, so a
 * dashboard load touches only the passes of the PRs it is listing. The
 * `ROW_NUMBER() OVER (PARTITION BY ...)` form this replaces was a
 * materialization barrier — the planner sorted and numbered *every* historical
 * pass in the store before any PR filter or LIMIT could apply, which is a cost
 * that grows with total pipeline history rather than with page size.
 *
 * Keying needs `pass_id`, which is the table's `INTEGER PRIMARY KEY`. A store
 * predating that column has no unique key to join on, so it keeps the window
 * form; correctness is identical either way, only the plan differs.
 */
function latestPassJoin(passColumns) {
  if (!hasJoinablePasses(passColumns)) return '';
  if (!passColumns.has('pass_id')) return latestPassWindowJoin(passColumns);
  const order = passOrderBy('pick', passColumns);
  return `
    LEFT JOIN reviewer_passes lp
      ON lp."repo" = rp."repo" AND lp."pr_number" = rp."pr_number"
     AND lp."pass_id" = (
       SELECT pick."pass_id"
       FROM reviewer_passes pick
       WHERE pick."repo" = rp."repo" AND pick."pr_number" = rp."pr_number"
       ORDER BY ${order.startedAt} DESC, ${order.passId} DESC
       LIMIT 1
     )
  `;
}

/** The pre-`pass_id` fallback: same latest-pass row, chosen by window function. */
function latestPassWindowJoin(passColumns) {
  const order = passOrderBy('inner_p', passColumns);
  return `
    LEFT JOIN (
      SELECT ${tolerantSelectList('inner_p', passColumns, PASS_COLUMNS)},
             ROW_NUMBER() OVER (
               PARTITION BY inner_p."repo", inner_p."pr_number"
               ORDER BY ${order.startedAt} DESC, ${order.passId} DESC
             ) AS rn
      FROM reviewer_passes inner_p
    ) lp ON lp.repo = rp.repo AND lp.pr_number = rp.pr_number AND lp.rn = 1
  `;
}

/**
 * The latest-pass columns, plus `latest_pass_present`.
 *
 * Every column goes through `colRef` because `lp` is now sometimes the raw
 * `reviewer_passes` table rather than a tolerant subquery, and a store missing
 * one of these columns must still degrade field-by-field instead of failing the
 * whole list query.
 *
 * `latest_pass_present` answers "did a pass row join at all?", which is a
 * different question from "is any of its columns non-null" — on a drifted store
 * every projected column can be NULL for a pass that genuinely exists.
 */
function latestPassSelect(passColumns) {
  if (!hasJoinablePasses(passColumns)) {
    const nulls = LATEST_PASS_COLUMNS.map(([, alias]) => `NULL AS ${alias}`);
    return `, ${nulls.join(', ')}, NULL AS latest_pass_present`;
  }
  const columns = LATEST_PASS_COLUMNS
    .map(([column, alias]) => `${colRef(passColumns, 'lp', column, 'NULL')} AS ${alias}`);
  columns.push('CASE WHEN lp."repo" IS NULL THEN NULL ELSE 1 END AS latest_pass_present');
  return `, ${columns.join(', ')}`;
}

/**
 * Project a `reviewed_prs` row (+ its latest pass) into the ARF PR shape.
 *
 * No title / builder / risk class / round budget: `reviews.db` does not carry
 * them and ARF-02's GitHub mirror will. Emitting a placeholder here would hide
 * a missing mirror behind something that looks like data.
 */
export function projectPullRequest(row) {
  const parsed = parseFindings(row.latest_body_md);
  const headSha = text(row.reviewer_head_sha);
  // Only a pass that actually joined can carry a verdict head. Falling back to
  // the PR row's own head would make `verdictOnCurrentHead` compare a value to
  // itself and answer `true` for a PR that has never been reviewed at all —
  // precisely the stale-verdict blindness this pair of fields exists to expose.
  const hasLatestPass = row.latest_pass_present !== null
    && row.latest_pass_present !== undefined;
  const verdictHeadSha = hasLatestPass ? text(row.latest_head_sha) : null;
  return {
    repo: text(row.repo),
    pr: int(row.pr_number),
    prState: text(row.pr_state) ?? 'open',
    // Both fallbacks mirror the store's own column defaults (`pr_state` and
    // `review_status` are NOT NULL DEFAULT 'open' / 'posted' in the live
    // pipeline schema), so an install predating a column reads as the value
    // that column would have held. A hand-picked default here would invent a
    // pipeline state the store never records.
    reviewStatus: text(row.review_status) ?? 'posted',
    reviewer: text(row.latest_reviewer_class) ?? text(row.reviewer),
    latestVerdict: text(row.latest_verdict),
    latestPassKind: text(row.latest_pass_kind),
    latestPassStatus: text(row.latest_status),
    latestGhCommentId: text(row.latest_gh_comment_id),
    round: int(row.review_attempts),
    latestRound: row.latest_attempt_number === null || row.latest_attempt_number === undefined
      ? null
      : int(row.latest_attempt_number),
    // Both heads, always: "is the verdict on the current head?" must stay
    // answerable, and a merge over a stale verdict is exactly the failure this
    // pipeline is built to prevent.
    headSha,
    headShaShort: shortSha(headSha),
    verdictHeadSha,
    verdictHeadShaShort: shortSha(verdictHeadSha),
    verdictOnCurrentHead: headSha && verdictHeadSha ? headSha === verdictHeadSha : null,
    // Real counts parsed from the latest review body, or null when that body is
    // absent/off-template — null means unknown, not zero.
    blockingCount: parsed.blockingSectionMissing ? null : parsed.blockingCount,
    nonBlockingCount: parsed.nonBlockingSectionMissing ? null : parsed.nonBlockingCount,
    failureMessage: text(row.failure_message),
    linearTicket: text(row.linear_ticket),
    labels: labels(row.labels_json),
    reviewedAt: text(row.reviewed_at),
    lastAttemptedAt: text(row.last_attempted_at),
    mergedAt: text(row.merged_at),
    closedAt: text(row.closed_at),
    terminal: Boolean(text(row.merged_at) || text(row.closed_at)),
  };
}

/** Project a `review_cycle_counters` row into the ARF cycle shape. */
export function projectReviewCycle(row) {
  const prUrl = text(row.pr_url);
  const match = prUrl ? PR_URL_PATTERN.exec(prUrl) : null;
  const headSha = text(row.head_sha);
  const escalatedAt = text(row.escalated_at);
  return {
    prUrl,
    repo: match ? match[1] : null,
    pr: match ? Number(match[2]) : null,
    headSha,
    headShaShort: shortSha(headSha),
    // `verdict_count` is NOT NULL in the pipeline schema, so a null here can
    // only mean the column is absent — which is "unknown", not "zero rounds
    // used". A zero would render as a full budget on a PR that may have spent it.
    used: row.verdict_count === null || row.verdict_count === undefined
      ? null
      : int(row.verdict_count),
    lastVerdictAt: text(row.last_verdict_at),
    escalatedAt,
    escalated: Boolean(escalatedAt),
  };
}

/**
 * The status a pass row would have carried, for a store that predates the
 * column.
 *
 * `reviewer_passes.status` is `NOT NULL` in the pipeline schema with **no
 * DEFAULT**, over the vocabulary `running | completed | failed | cancelled`. So
 * unlike `pr_state` / `review_status` there is no column default to mirror, and
 * a null here means exactly one thing: this install predates the column. The
 * honest reconstruction is the row's own completion markers — a pass with an
 * `ended_at` (or a verdict it could only have cast on finishing) is finished,
 * and reporting it as still-running would leave historical passes pinned to a
 * pending state forever. `completed` rather than `failed`/`cancelled` because
 * those are not distinguishable from the columns that remain; `running` rather
 * than the previous `in_review` because `in_review` is not in this column's
 * vocabulary at all — it belongs to PR-level `review_status`.
 */
function passStatus(row) {
  const stored = text(row.status);
  if (stored) return stored;
  return text(row.ended_at) || text(row.verdict) ? 'completed' : 'running';
}

/** Project a `reviewer_passes` row, with its findings parsed out of `body_md`. */
export function projectPass(row) {
  const parsed = parseFindings(row.body_md);
  const passId = row.pass_id === null || row.pass_id === undefined ? null : int(row.pass_id);
  const round = int(row.attempt_number);
  const context = {
    repo: text(row.repo),
    pr: int(row.pr_number),
    passId,
    round,
    passKind: text(row.pass_kind),
    reviewerClass: text(row.reviewer_class),
    ghCommentId: text(row.gh_comment_id),
  };
  return {
    ...context,
    reviewerModel: text(row.reviewer_model),
    verdict: text(row.verdict),
    status: passStatus(row),
    headSha: text(row.head_sha),
    headShaShort: shortSha(row.head_sha),
    startedAt: text(row.started_at),
    endedAt: text(row.ended_at),
    bodyCapturedAt: text(row.body_captured_at),
    hasBody: Boolean(text(row.body_md)),
    blockingCount: parsed.blockingSectionMissing ? null : parsed.blockingCount,
    nonBlockingCount: parsed.nonBlockingSectionMissing ? null : parsed.nonBlockingCount,
    // `pass_id` is the natural key, but a store predating that column projects
    // it as null for every pass. Falling back to a constant would hand every
    // pass in the PR the same finding ids, and a UI keying a list on them would
    // collide. `(round, passKind)` is UNIQUE per PR in both schemas, so it is a
    // sound substitute key.
    findings: parsed.findings.map((finding, index) => ({
      ...context,
      findingId: `${context.repo}#${context.pr}/pass-${passId ?? `${round}-${context.passKind ?? 'unknown'}`}/${index}`,
      ...finding,
    })),
  };
}

/**
 * Group passes into rounds. One `attempt_number` is one review round, and a
 * round can hold several passes (e.g. a review pass and a re-review pass).
 */
export function groupRounds(passes) {
  const byRound = new Map();
  for (const pass of passes) {
    if (!byRound.has(pass.round)) byRound.set(pass.round, []);
    byRound.get(pass.round).push(pass);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, roundPasses]) => {
      const last = roundPasses[roundPasses.length - 1];
      // The round's verdict, findings, and counts all come from the SAME pass —
      // its last one. Earlier passes in the round are superseded, not additive,
      // so summing their findings would let a round report an `approved` verdict
      // alongside a non-zero blockingCount carried over from the pass that
      // verdict already answered. Every pass is still reachable under `passes`.
      const findings = last.findings;
      return {
        round,
        passes: roundPasses,
        findings,
        verdict: last.verdict,
        reviewerClass: last.reviewerClass,
        headSha: last.headSha,
        startedAt: roundPasses[0].startedAt,
        endedAt: last.endedAt,
        // Taken from the last pass rather than recounted off `findings`, so
        // "unknown" survives: a round whose last pass has no body (still
        // running) reports null, not a 0 that would read as "the reviewer
        // found nothing".
        blockingCount: last.blockingCount,
        nonBlockingCount: last.nonBlockingCount,
      };
    });
}

/**
 * Build a store adapter for a config, provisioning the standalone file when ARF
 * owns it. Never opens a writable handle in `in-os` mode.
 */
export function openReviewStore(config) {
  const store = new ReviewStore(config);
  if (store.ownsStore) store.provision();
  return store;
}
