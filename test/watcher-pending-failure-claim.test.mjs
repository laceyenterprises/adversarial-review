import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  prepareMarkUnknownFailureRetryAttemptStarted,
  prepareMarkReviewPopulationRetryAttemptStarted,
  prepareMarkInfraAutoRecoveryAttemptStarted,
  prepareMarkDaemonBounceRecoveryAttemptStarted,
  prepareMarkTokenRefreshRecoveryAttemptStarted,
  prepareMarkAttemptStarted,
  prepareFinalizePendingTerminalFailure,
  prepareReviewRowInTerminalFailureState,
} from '../src/review-state-statements.mjs';
import {
  INFRA_RECOVERABLE_FAILURE_CLASSES,
  infraRecoverableFailureClass,
  unknownReviewerCommandFailureClass,
} from '../src/reviewer-failure-classification.mjs';
import { reviewPopulationRetryDecision } from '../src/reviewer-route-selection.mjs';
import { DAEMON_BOUNCE_FAILURE_CLASS, isDaemonBounceFailure } from '../src/daemon-bounce-recovery.mjs';

const REPO = 'example-org/example-repo';
const PR = 421;
const HEAD = 'a'.repeat(40);
const FAILED_AT = '2026-10-20T12:00:00.000Z';
const ATTEMPT_AT = '2026-10-20T12:10:00.000Z';

for (const [branch, message] of [
  ['UnknownFailure', '[unknown] Command failed with code 1'],
  ['ReviewPopulation', 'Reviewer session fixture-session is no longer alive and no GitHub review was found'],
]) {
  test(`PENDINGCLAIM-01 reproduction: lease-released ${branch} failure is claimed`, () => {
    const db = new Database(':memory:');
    try {
      ensureReviewStateSchema(db);
      db.prepare(`INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         failed_at, failure_message, review_attempts, reviewer_head_sha,
         reviewer_session_uuid, reviewer_pgid)
        VALUES (?, ?, ?, 'codex', 'open', 'pending', ?, ?, 1, ?, 'fixture-session', 12345)`)
        .run(REPO, PR, FAILED_AT, FAILED_AT, message, HEAD);
      const prefix = [ATTEMPT_AT, 'replacement-session', HEAD, HEAD, 60000, '2026-10-20T12:11:00.000Z'];
      const args = branch === 'UnknownFailure'
        ? [...prefix, REPO, PR, HEAD, 3]
        : [...prefix, HEAD, ATTEMPT_AT, HEAD, REPO, PR, HEAD, HEAD, 1];
      const prepare = branch === 'UnknownFailure'
        ? prepareMarkUnknownFailureRetryAttemptStarted : prepareMarkReviewPopulationRetryAttemptStarted;
      const result = prepare(db).run(...args);
      assert.equal(result.changes, 1);
      assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'reviewing');
    } finally { db.close(); }
  });
}

// Execute the production classifier and single-claim closure with an in-memory
// handle. Importing pollonce-phases directly opens the process-wide state DB;
// slicing these exact blocks keeps this invariant independent of any host state,
// service, CLI, or network. Missing/moved anchors fail rather than skip coverage.
const source = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production block ${start} exists`);
  return source.slice(from, to);
}
function execute(code, bindings) {
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}

const terminalPredicate = between('export function reviewRowInTerminalFailureState(',
  'export function finalizePendingTerminalFailureState(').replace('export ', '');
const classify = between('      const inTerminalFailure = reviewRowInTerminalFailureState(current,',
  '      if (populationRetry.matched && populationRetry.action');
const retryablePopulation = between('      const reviewPopulationRetryable = Boolean(',
  '      if (inTerminalFailure && !infraRecoveryClass');
const claimClosure = between('            const claimBranch = tokenRefreshRecovery',
  '            const claim = (holdReleaseId');
const claimAndFailureLog = between('            const claim = (holdReleaseId',
  "            if (route.reviewerModel === 'codex')");
const parkUnknown = between('        if (unknownFailureClass) {\n          finalizePendingTerminalFailureState(current);',
  "        if (populationRetry.matched && populationRetry.action === 'exhausted')");

const factories = {
  stmtMarkUnknownFailureRetryAttemptStarted: prepareMarkUnknownFailureRetryAttemptStarted,
  stmtMarkReviewPopulationRetryAttemptStarted: prepareMarkReviewPopulationRetryAttemptStarted,
  stmtMarkInfraAutoRecoveryAttemptStarted: prepareMarkInfraAutoRecoveryAttemptStarted,
  stmtMarkDaemonBounceRecoveryAttemptStarted: prepareMarkDaemonBounceRecoveryAttemptStarted,
  // These two are deliberate controls: their SQL must remain unchanged.
  stmtMarkTokenRefreshRecoveryAttemptStarted: prepareMarkTokenRefreshRecoveryAttemptStarted,
  stmtMarkAttemptStarted: prepareMarkAttemptStarted,
};
const cases = [
  ['unknown', 'Command failed with code 1', 'stmtMarkUnknownFailureRetryAttemptStarted'],
  ['population', 'generated-but-not-posted: no GitHub review found', 'stmtMarkReviewPopulationRetryAttemptStarted'],
  ['infra', '[hcp-unavailable] synthetic failure', 'stmtMarkInfraAutoRecoveryAttemptStarted'],
  ['tagged command failure', '[unknown] Command failed with code 1', 'stmtMarkInfraAutoRecoveryAttemptStarted'],
  ['daemon bounce', '[daemon-bounce] synthetic interruption', 'stmtMarkDaemonBounceRecoveryAttemptStarted'],
  ['token refresh control', '[token-refresh-pending] synthetic hold', 'stmtMarkTokenRefreshRecoveryAttemptStarted'],
];

function fixture(overrides = {}) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  const row = {
    repo: REPO, pr_number: PR, reviewed_at: FAILED_AT, reviewer: 'codex', pr_state: 'open',
    review_status: 'pending', review_attempts: 1, failed_at: FAILED_AT,
    failure_message: 'Command failed with code 1', reviewer_head_sha: HEAD,
    reviewer_started_at: FAILED_AT, reviewer_session_uuid: 'fixture-session', reviewer_pgid: 12345,
    ...overrides,
  };
  db.prepare(`INSERT INTO reviewed_prs (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  const read = () => db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
  const stmtReviewRowInTerminalFailureState = prepareReviewRowInTerminalFailureState(db);
  const predicate = execute(`${terminalPredicate}; return reviewRowInTerminalFailureState;`,
    { stmtReviewRowInTerminalFailureState, isDaemonBounceFailure });
  return { db, read, predicate };
}

function route(f, head = HEAD) {
  return execute(`${classify}\n${retryablePopulation}
    return { inTerminalFailure, infraRecoveryClass, unknownFailureClass, populationRetry,
      unknownFailureAttempts, unknownFailureRetryable, reviewPopulationRetryable, reviewPopulationRetryConfig };`, {
    current: f.read(), subject: { headSha: head }, reviewRowInTerminalFailureState: f.predicate,
    infraRecoverableFailureClass, unknownReviewerCommandFailureClass,
    normalizeReviewPopulationRetryConfig: config => config,
    resolveReviewPopulationRetryConfig: () => ({ maxAttempts: 1, backoffSeconds: 0 }),
    reviewPopulationRetryDecision, REVIEW_UNKNOWN_FAILURE_MAX_RETRIES: 3,
  });
}

function claimBindings(f, decision, head = HEAD) {
  const selected = [];
  const statements = Object.fromEntries(Object.entries(factories).map(([name, prepare]) => {
    const stmt = prepare(f.db);
    return [name, { run(...args) { selected.push(name); return stmt.run(...args); } }];
  }));
  return {
    selected,
    bindings: {
      ...decision, ...statements, current: f.read(), tokenRefreshRecovery: decision.infraRecoveryClass === 'token-refresh-pending',
      DAEMON_BOUNCE_FAILURE_CLASS, attemptAt: ATTEMPT_AT, reviewerSessionUuid: 'replacement-session',
      reviewerHeadSha: head, pendingRevisionRef: head, reviewerTimeoutMs: 60000,
      reviewerLeaseExpiresAt: '2026-10-20T12:11:00.000Z', repoPath: REPO, prNumber: PR,
      INFRA_AUTO_RECOVER_CAP: 3, REVIEW_UNKNOWN_FAILURE_MAX_RETRIES: 3, cascadeRetryDue: false,
    },
  };
}

const unresolvedModelMessage = '[unknown] Command failed with code 1\n'
  + 'stderr tail:\n[reviewer-model-unresolved] governed model unavailable for worker-registry; '
  + 'worker registry requires async prefetch\nstdout tail:\nsynthetic reviewer startup';
for (const status of ['failed', 'pending']) {
  test(`PENDINGCLAIM-01 nested unresolved model failure claims: ${status}`, () => {
    const f = fixture({ review_status: status, failure_message: unresolvedModelMessage,
      review_attempts: 1 });
    try {
      const decision = route(f);
      assert.equal(decision.infraRecoveryClass, 'reviewer-model-unresolved');
      const { bindings, selected } = claimBindings(f, decision);
      const result = execute(`${claimClosure}\nreturn claimReviewer();`, bindings);
      assert.deepEqual(selected, ['stmtMarkInfraAutoRecoveryAttemptStarted']);
      assert.equal(result.changes, 1);
    } finally { f.db.close(); }
  });
}

for (const failureClass of INFRA_RECOVERABLE_FAILURE_CLASSES) {
  const message = failureClass === 'reviewer-command-failed'
    ? '[unknown] Command failed with code 1'
    : failureClass === 'github-review-create-transient'
      ? 'review-create HTTP 503'
      : `[${failureClass}] synthetic failure`;
  for (const status of ['failed', 'pending']) {
    for (const changed of [false, true]) {
      test(`all recoverable classes claim their snapshot: ${failureClass}, ${status}, changed=${changed}`, () => {
        const f = fixture({ review_status: status, failure_message: message });
        try {
          const decision = route(f);
          assert.equal(decision.infraRecoveryClass, failureClass);
          const { bindings, selected } = claimBindings(f, decision);
          if (changed) {
            // Keep the class, timestamp, head and status unchanged. Only the
            // exact message snapshot can reject this competing settlement.
            f.db.prepare('UPDATE reviewed_prs SET failure_message = ?')
              .run(`${message}\nsynthetic newer failure`);
          }
          // Bounce and token refresh retain their separate production CASes.
          // Still prove the infra CAS accepts every classifier result without
          // re-deciding its class, including these separately routed controls.
          const separateClaim = ['daemon-bounce', 'token-refresh-pending'].includes(failureClass);
          const claim = separateClaim
            ? bindings.stmtMarkInfraAutoRecoveryAttemptStarted.run(
              ATTEMPT_AT, 'replacement-session', HEAD, HEAD, 60000, ATTEMPT_AT,
              REPO, PR, bindings.current.failed_at, bindings.current.reviewer_head_sha,
              3, 0, bindings.current.failure_message)
            : execute(`${claimClosure}\nreturn claimReviewer();`, bindings);
          assert.equal(claim.changes, changed ? 0 : 1);
          assert.deepEqual(selected, ['stmtMarkInfraAutoRecoveryAttemptStarted']);
          assert.equal(f.read().infra_auto_recover_attempts, changed ? 0 : 1);
        } finally { f.db.close(); }
      });
    }
  }
}

test('invariant table covers every production claim branch, including unchanged controls', () => {
  const productionClaims = [...claimClosure.matchAll(/\b(stmt\w+)\.run\(/g)].map(match => match[1]);
  const covered = [...new Set([...cases.map(row => row[2]), 'stmtMarkAttemptStarted'])];
  assert.deepEqual(productionClaims.sort(), covered.sort());
});

for (const [name, message, expectedClaim] of cases) {
  for (const status of ['failed', 'pending']) {
    test(`terminal classifier/CAS invariant: ${name}, ${status}`, () => {
      const f = fixture({ review_status: status, failure_message: message,
        // Bounce recovery is uncharged; it must also accept zero attempts.
        review_attempts: name === 'daemon bounce' ? 0 : 1 });
      try {
        const decision = route(f);
        assert.equal(decision.inTerminalFailure, true);
        assert.equal(decision.reviewPopulationRetryable || decision.unknownFailureRetryable || Boolean(decision.infraRecoveryClass), true);
        const { bindings, selected } = claimBindings(f, decision);
        const result = execute(`${claimClosure}\nreturn claimReviewer();`, bindings);
        assert.deepEqual(selected, [expectedClaim]);
        assert.equal(result.changes, 1);
        const row = f.read();
        assert.equal(row.review_status, 'reviewing');
        assert.equal(row.reviewer_session_uuid, 'replacement-session');
        assert.equal(row.reviewer_pgid, null);
        assert.equal(row.failed_at, null);
        assert.equal(row.failure_message, null);
        // The claim never resets the same-head failure budget.
        assert.equal(row.review_attempts, name === 'daemon bounce' ? 0 : 1);
        assert.equal(execute(`${claimClosure}\nreturn claimReviewer();`, bindings).changes, 0,
          'the selected CAS cannot claim a second reviewer');
      } finally { f.db.close(); }
    });
  }
}

test('moved-head lease release selects the plain pending claim and resets attempts', () => {
  const f = fixture({ review_attempts: 3 });
  try {
    const head = 'b'.repeat(40);
    const decision = route(f, head);
    assert.equal(decision.inTerminalFailure, false);
    const { bindings, selected } = claimBindings(f, decision, head);
    assert.equal(execute(`${claimClosure}\nreturn claimReviewer();`, bindings).changes, 1);
    assert.deepEqual(selected, ['stmtMarkAttemptStarted']);
    assert.equal(f.read().review_attempts, 0);
    assert.equal(f.read().reviewer_head_sha, head);
  } finally { f.db.close(); }
});

test('unknown failure at the cap parks without claiming or charging another attempt', async () => {
  const f = fixture({ review_attempts: 3 });
  try {
    const decision = route(f);
    assert.equal(decision.unknownFailureClass, 'unknown');
    assert.equal(decision.unknownFailureRetryable, false);
    const parked = [];
    const finalizeSource = between('export function finalizePendingTerminalFailureState(',
      'const REVIEWER_WORKER_CLASS_BY_MODEL').replace('export ', '');
    const finalize = execute(`${finalizeSource}; return finalizePendingTerminalFailureState;`, {
      stmtFinalizePendingTerminalFailure: prepareFinalizePendingTerminalFailure(f.db),
    });
    await execute(`return (async () => { ${parkUnknown} })();`, {
      ...decision, current: f.read(), finalizePendingTerminalFailureState: finalize,
      parkExhaustedReview: async args => parked.push(args), ROOT: '/synthetic-root',
      repoPath: REPO, prNumber: PR, subject: { headSha: HEAD },
      REVIEW_UNKNOWN_FAILURE_MAX_RETRIES: 3, deliverAlertFn: () => assert.fail('no live alert'),
    });
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, 'unknown reviewer failure attempts=3/3');
    assert.equal(f.read().review_status, 'failed');
    assert.equal(f.read().review_attempts, 3);
    const { bindings } = claimBindings(f, decision);
    assert.equal(bindings.stmtMarkUnknownFailureRetryAttemptStarted.run(
      ATTEMPT_AT, 'replacement-session', HEAD, HEAD, 60000, ATTEMPT_AT, REPO, PR, HEAD, 3).changes, 0);
  } finally { f.db.close(); }
});

for (const field of [null, 'review_status', 'reviewer_session_uuid', 'failed_at']) {
  test(`zero-row CAS diagnostic: ${field || 'unchanged shape'}`, () => {
    const f = fixture();
    try {
      const { bindings } = claimBindings(f, route(f));
      // The real CAS refuses an unrecognized failure message. The
      // snapshot is deliberately stale in untested fields only for mismatch.
      const snapshot = f.read();
      f.db.prepare("UPDATE reviewed_prs SET failure_message = 'synthetic deterministic failure'").run();
      if (field) f.db.prepare(`UPDATE reviewed_prs SET ${field} = ?`).run(
        field === 'review_status' ? 'reviewing' : 'changed');
      const lines = [];
      const result = execute(`${claimClosure}\n${claimAndFailureLog}`, {
        ...bindings, current: snapshot, holdReleaseId: null, reviewerPoolConfig: { enabled: false },
        stmtGetReviewRow: { get: () => f.read() }, console: { log: line => lines.push(line) },
      });
      assert.equal(result.reason, 'claim-race-lost');
      assert.equal(lines.length, 1);
      if (field) assert.match(lines[0], /Lost claim race/);
      else assert.match(lines[0], /claim-shape-mismatch branch=unknown-failure status=pending/);
      assert.equal(f.read().review_attempts, 1);
    } finally { f.db.close(); }
  });
}

for (const name of ['UnknownFailure', 'ReviewPopulation', 'InfraAutoRecovery', 'DaemonBounceRecovery']) {
  test(`retry shape refuses ordinary pending and changed-head lease release: ${name}`, () => {
    const message = cases.find(row => row[2] === `stmtMark${name}${name.includes('Recovery') ? '' : 'Retry'}AttemptStarted`)?.[1];
    assert.ok(message);
    for (const overrides of [{ failed_at: null }, { review_attempts: 0 }, { reviewer_head_sha: 'b'.repeat(40) }]) {
      // Zero-attempt bounce is deliberately terminal, covered in the invariant.
      if (name === 'DaemonBounceRecovery' && overrides.review_attempts === 0) continue;
      const f = fixture({ failure_message: message, ...overrides });
      try {
        assert.equal(f.predicate(f.read(), HEAD), false);
      } finally { f.db.close(); }
    }
  });
}
