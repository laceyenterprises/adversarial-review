import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  amaAuditFilePath,
  appendAmaAuditAttempt,
  composeAmaTrailers,
  readAuditFileMode,
  writeAmaAuditEntry,
} from '../src/ama/audit.mjs';

function freshHqRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-audit-'));
}

const DEFAULT_TUPLE = Object.freeze({
  repo: 'acme/myrepo',
  prNumber: 1234,
  headSha: 'abc12345abc12345abc12345abc12345abc12345',
});

// ---------------------------------------------------------------------------
// Test 1 — writeAmaAuditEntry creates the record with status=in_progress and
// a single attempt. Atomic write succeeds, file lives at the §4.4 path.
// ---------------------------------------------------------------------------

test('writeAmaAuditEntry creates file at the §4.4 path with status=in_progress', () => {
  const hqRoot = freshHqRoot();
  try {
    const { filePath, doc } = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress', reviewerFamily: 'claude-reviewer-lacey' },
      now: '2026-06-11T20:00:00Z',
    });
    // Path matches the documented convention exactly.
    const expected = amaAuditFilePath(hqRoot, DEFAULT_TUPLE.repo, DEFAULT_TUPLE.prNumber, DEFAULT_TUPLE.headSha);
    assert.equal(filePath, expected);
    assert.match(filePath, /\/dispatch\/audit\/adversarial-merge-authority\/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345\.json$/);
    assert.ok(existsSync(filePath));
    assert.equal(doc.status, 'in_progress');
    assert.equal(doc.attempts.length, 1);
    assert.equal(doc.attempts[0].outcome, 'in_progress');
    assert.equal(doc.attempts[0].reviewerFamily, 'claude-reviewer-lacey');
    assert.equal(doc.attempts[0].attemptNumber, 1);
    assert.equal(doc.attempts[0].startedAt, '2026-06-11T20:00:00Z');
    assert.equal(doc.repo, 'acme/myrepo');
    assert.equal(doc.prNumber, 1234);
    assert.equal(doc.schemaVersion, 1);
    // Round-trip via the on-disk file (atomic write succeeded).
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(onDisk, doc);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — append `deferred` outcome → status=deferred; attempts.length=2.
// ---------------------------------------------------------------------------

test('appendAmaAuditAttempt deferred outcome derives status=deferred', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'in_progress' }, now: '2026-06-11T20:00:00Z' });
    const { doc } = appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'deferred', preMergeReasons: ['risk-class-not-permitted'] },
      now: '2026-06-11T20:01:00Z',
    });
    assert.equal(doc.status, 'deferred');
    assert.equal(doc.attempts.length, 2);
    assert.equal(doc.attempts[1].attemptNumber, 2);
    assert.equal(doc.attempts[1].outcome, 'deferred');
    assert.deepEqual(doc.attempts[1].preMergeReasons, ['risk-class-not-permitted']);
    // Prior attempt remains immutable.
    assert.equal(doc.attempts[0].outcome, 'in_progress');
    assert.equal(doc.attempts[0].attemptNumber, 1);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — append `superseded` after `deferred` → status=superseded; attempts.length=3.
// Verifies the surface status mirrors the LATEST attempt (not a vote).
// ---------------------------------------------------------------------------

test('appendAmaAuditAttempt superseded after deferred sets status=superseded', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'in_progress' }, now: '2026-06-11T20:00:00Z' });
    appendAmaAuditAttempt({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'deferred' }, now: '2026-06-11T20:01:00Z' });
    const { doc } = appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'superseded', observedHeadSha: 'def4...' },
      now: '2026-06-11T20:05:00Z',
    });
    assert.equal(doc.status, 'superseded');
    assert.equal(doc.attempts.length, 3);
    assert.equal(doc.attempts[2].attemptNumber, 3);
    // Earlier attempts preserved with their original ordering.
    assert.equal(doc.attempts[0].outcome, 'in_progress');
    assert.equal(doc.attempts[1].outcome, 'deferred');
    assert.equal(doc.attempts[2].outcome, 'superseded');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — append `succeeded` after `deferred` → status=succeeded; history preserved.
// ---------------------------------------------------------------------------

test('appendAmaAuditAttempt succeeded after deferred sets status=succeeded; history preserved', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'in_progress' }, now: '2026-06-11T20:00:00Z' });
    appendAmaAuditAttempt({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'deferred' }, now: '2026-06-11T20:01:00Z' });
    const { doc } = appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'succeeded', mergeCommitSha: '0123abc' },
      now: '2026-06-11T20:10:00Z',
    });
    assert.equal(doc.status, 'succeeded');
    assert.equal(doc.attempts.length, 3);
    assert.equal(doc.attempts[2].mergeCommitSha, '0123abc');
    // Earlier defer remains visible in the audit trail.
    assert.equal(doc.attempts[1].outcome, 'deferred');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5 — append `failed-without-merge` after `succeeded` → ERROR.
// Sticky-succeeded is the load-bearing contract per SPEC §4.4 rule #5.
// ---------------------------------------------------------------------------

test('appendAmaAuditAttempt refuses to demote terminal succeeded', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({ hqRoot, ...DEFAULT_TUPLE, attempt: { outcome: 'succeeded', mergeCommitSha: 'abc' }, now: '2026-06-11T20:00:00Z' });
    assert.throws(
      () => appendAmaAuditAttempt({
        hqRoot,
        ...DEFAULT_TUPLE,
        attempt: { outcome: 'failed-without-merge' },
        now: '2026-06-11T20:05:00Z',
      }),
      /refusing to demote terminal 'succeeded'/,
    );
    // Defer-after-succeeded is also refused — same contract.
    assert.throws(
      () => appendAmaAuditAttempt({
        hqRoot,
        ...DEFAULT_TUPLE,
        attempt: { outcome: 'deferred' },
        now: '2026-06-11T20:05:00Z',
      }),
      /refusing to demote terminal 'succeeded'/,
    );
    // The on-disk record stayed succeeded — the write was atomic.
    const onDisk = JSON.parse(readFileSync(amaAuditFilePath(hqRoot, DEFAULT_TUPLE.repo, DEFAULT_TUPLE.prNumber, DEFAULT_TUPLE.headSha), 'utf8'));
    assert.equal(onDisk.status, 'succeeded');
    assert.equal(onDisk.attempts.length, 1);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6 — composeAmaTrailers snapshot.
// ---------------------------------------------------------------------------

test('composeAmaTrailers produces the SPEC §4.4 trailer block', () => {
  const block = composeAmaTrailers({
    workerClass: 'codex',
    reviewerFamily: 'claude-reviewer-lacey',
    riskClass: 'low',
    eligibilityReason: 'clean review, reviewer family recorded, low risk',
    auditPath: '/Users/airlock/agent-os-hq/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345.json',
  });
  // Snapshot — the trailer block is the contract (SPEC §4.4) and the
  // closing commit's `git interpret-trailers` parser reads exactly
  // these key names. Format drift here is a breaking change to the
  // provenance contract.
  assert.equal(
    block,
    [
      'Closed-By: codex-closer (adversarial-pipe-mode)',
      'Reviewed-By: claude-reviewer-lacey',
      'Risk-Class: low',
      'Eligibility-Reason: clean review, reviewer family recorded, low risk',
      'Eligibility-Trace: /Users/airlock/agent-os-hq/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345.json',
    ].join('\n'),
  );
});

test('composeAmaTrailers refuses CR/LF injection in any field', () => {
  for (const field of ['workerClass', 'reviewerFamily', 'riskClass', 'eligibilityReason', 'auditPath']) {
    const base = {
      workerClass: 'codex',
      reviewerFamily: 'claude-reviewer-lacey',
      riskClass: 'low',
      eligibilityReason: 'clean',
      auditPath: '/tmp/x.json',
    };
    base[field] = `${base[field]}\nMalicious-Trailer: pwned`;
    assert.throws(
      () => composeAmaTrailers(base),
      /CR\/LF/,
      `composeAmaTrailers must refuse CR/LF injection in ${field}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 7 — atomic write contract: tmpfile cleaned up; final mode is 0640.
// ---------------------------------------------------------------------------

test('writeAmaAuditEntry leaves no tmpfile behind and writes mode 0640', () => {
  const hqRoot = freshHqRoot();
  try {
    const { filePath } = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress' },
      now: '2026-06-11T20:00:00Z',
    });
    // Mode is 0640 per the writer's contract.
    assert.equal(readAuditFileMode(filePath), 0o640);
    // No tmpfile residue in the parent dir.
    const parent = dirname(filePath);
    const stragglers = readdirSync(parent).filter((name) =>
      /\.tmp$|^\.[^.]/.test(name) && name !== '.' && name !== '..'
    );
    assert.deepEqual(stragglers, [], `unexpected tmp residue: ${stragglers.join(',')}`);
    // Append also preserves the mode.
    appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'deferred' },
      now: '2026-06-11T20:01:00Z',
    });
    assert.equal(readAuditFileMode(filePath), 0o640);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defensive: outcome validation.
// ---------------------------------------------------------------------------

test('writeAmaAuditEntry rejects an outcome not in the §4.4 enum', () => {
  const hqRoot = freshHqRoot();
  try {
    assert.throws(
      () => writeAmaAuditEntry({
        hqRoot,
        ...DEFAULT_TUPLE,
        attempt: { outcome: 'maybe-merged' },
      }),
      /attempt\.outcome 'maybe-merged' is not in the §4\.4 enum/,
    );
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('appendAmaAuditAttempt throws when no prior record exists', () => {
  const hqRoot = freshHqRoot();
  try {
    assert.throws(
      () => appendAmaAuditAttempt({
        hqRoot,
        ...DEFAULT_TUPLE,
        attempt: { outcome: 'deferred' },
      }),
      /no existing record at .* — call writeAmaAuditEntry first/,
    );
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});
