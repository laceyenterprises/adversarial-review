import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { execPath } from 'node:process';

import {
  AmaAuditRefusedWriteError,
  amaAuditFilePath,
  amaAuditTraceRef,
  appendAmaAuditAttempt,
  composeAmaTrailers,
  readAuditFileMode,
  readAmaAuditEntry,
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

function runAmaAuditCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, ['bin/ama-audit.mjs', ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runConcurrentAppend({ hqRoot, marker, delayMs = 0 }) {
  const script = `
    import { appendAmaAuditAttempt } from ${JSON.stringify(new URL('../src/ama/audit.mjs', import.meta.url).pathname)};
    const { HQ_ROOT, MARKER, DELAY_MS } = process.env;
    if (Number(DELAY_MS) > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(DELAY_MS));
    }
    appendAmaAuditAttempt({
      hqRoot: HQ_ROOT,
      repo: ${JSON.stringify(DEFAULT_TUPLE.repo)},
      prNumber: ${DEFAULT_TUPLE.prNumber},
      headSha: ${JSON.stringify(DEFAULT_TUPLE.headSha)},
      attempt: { outcome: 'deferred', marker: MARKER },
      now: MARKER === 'A' ? '2026-06-11T20:01:00Z' : '2026-06-11T20:01:01Z',
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HQ_ROOT: hqRoot,
        MARKER: marker,
        DELAY_MS: String(delayMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`concurrent append ${marker} failed: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

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
    assert.deepEqual(doc.reconciliation, {
      needsRepair: false,
      lastVerifiedAt: '2026-06-11T20:01:00Z',
    });
    // Prior attempt remains immutable.
    assert.equal(doc.attempts[0].outcome, 'in_progress');
    assert.equal(doc.attempts[0].attemptNumber, 1);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('appendAmaAuditAttempt projects repair-needed reconciliation from appended attempt', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress' },
      metadata: {
        reconciliation: {
          needsRepair: false,
          lastVerifiedAt: '2026-06-11T20:00:00Z',
        },
      },
      now: '2026-06-11T20:00:00Z',
    });
    const { doc } = appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress', needsRepair: true, cliExitCode: 0 },
      now: '2026-06-11T20:02:00Z',
    });
    assert.equal(doc.status, 'in_progress');
    assert.deepEqual(doc.reconciliation, {
      needsRepair: true,
      lastVerifiedAt: '2026-06-11T20:02:00Z',
    });
    assert.equal(doc.attempts.length, 2);
    assert.equal(doc.attempts[1].needsRepair, true);
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
      (err) => err instanceof AmaAuditRefusedWriteError && /refusing to demote terminal 'succeeded'/.test(err.message),
    );
    // Defer-after-succeeded is also refused — same contract.
    assert.throws(
      () => appendAmaAuditAttempt({
        hqRoot,
        ...DEFAULT_TUPLE,
        attempt: { outcome: 'deferred' },
        now: '2026-06-11T20:05:00Z',
      }),
      (err) => err instanceof AmaAuditRefusedWriteError && /refusing to demote terminal 'succeeded'/.test(err.message),
    );
    // The on-disk record stayed succeeded — the write was atomic.
    const onDisk = JSON.parse(readFileSync(amaAuditFilePath(hqRoot, DEFAULT_TUPLE.repo, DEFAULT_TUPLE.prNumber, DEFAULT_TUPLE.headSha), 'utf8'));
    assert.equal(onDisk.status, 'succeeded');
    assert.equal(onDisk.attempts.length, 1);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('writeAmaAuditEntry refreshes an existing record with a fresh in_progress attempt', () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'deferred', bootstrap: true },
      metadata: { reviewedBy: 'claude-reviewer-lacey' },
      now: '2026-06-11T20:00:00Z',
    });
    const second = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress', bootstrap: false },
      metadata: { reviewedBy: 'different-reviewer', riskClass: 'low' },
      now: '2026-06-11T20:05:00Z',
    });
    assert.equal(second.doc.status, 'in_progress');
    assert.equal(second.doc.reviewedBy, 'different-reviewer');
    assert.equal(second.doc.riskClass, 'low');
    assert.equal(second.doc.attempts.length, 2);
    assert.equal(second.doc.attempts[0].outcome, 'deferred');
    assert.equal(second.doc.attempts[0].bootstrap, true);
    assert.equal(second.doc.attempts[1].outcome, 'in_progress');
    assert.equal(second.doc.attempts[1].attemptNumber, 2);
    assert.equal(second.doc.attempts[1].startedAt, '2026-06-11T20:05:00Z');
    assert.equal(second.doc.attempts[1].bootstrap, false);
    assert.equal(second.doc.createdAt, '2026-06-11T20:00:00Z');
    assert.equal(second.doc.updatedAt, '2026-06-11T20:05:00Z');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('audit writer-owned canonical fields cannot be overridden by caller payloads', () => {
  const hqRoot = freshHqRoot();
  try {
    const { doc } = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: {
        outcome: 'in_progress',
        attemptNumber: 99,
        startedAt: '1999-01-01T00:00:00Z',
      },
      metadata: {
        schemaVersion: 999,
        repo: 'evil/repo',
        prNumber: 1,
        headSha: 'evil',
        createdAt: '1999-01-01T00:00:00Z',
        updatedAt: '1999-01-01T00:00:00Z',
        status: 'succeeded',
        attempts: [{ outcome: 'succeeded' }],
        reviewedBy: 'claude-reviewer-lacey',
      },
      now: '2026-06-11T20:00:00Z',
    });
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.repo, DEFAULT_TUPLE.repo);
    assert.equal(doc.prNumber, DEFAULT_TUPLE.prNumber);
    assert.equal(doc.headSha, DEFAULT_TUPLE.headSha);
    assert.equal(doc.createdAt, '2026-06-11T20:00:00Z');
    assert.equal(doc.updatedAt, '2026-06-11T20:00:00Z');
    assert.equal(doc.status, 'in_progress');
    assert.equal(doc.reviewedBy, 'claude-reviewer-lacey');
    assert.equal(doc.attempts.length, 1);
    assert.equal(doc.attempts[0].attemptNumber, 1);
    assert.equal(doc.attempts[0].startedAt, '2026-06-11T20:00:00Z');

    const refreshed = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: {
        outcome: 'deferred',
        attemptNumber: 100,
        startedAt: '1999-01-01T00:00:00Z',
      },
      metadata: {
        schemaVersion: 999,
        status: 'succeeded',
        attempts: [],
      },
      now: '2026-06-11T20:05:00Z',
    }).doc;
    assert.equal(refreshed.schemaVersion, 1);
    assert.equal(refreshed.status, 'deferred');
    assert.equal(refreshed.attempts.length, 2);
    assert.equal(refreshed.attempts[1].attemptNumber, 2);
    assert.equal(refreshed.attempts[1].startedAt, '2026-06-11T20:05:00Z');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6 — composeAmaTrailers snapshot.
// ---------------------------------------------------------------------------

test('composeAmaTrailers produces the SPEC §4.4 trailer block', () => {
  const auditRef = amaAuditTraceRef('acme/myrepo', 1234, 'abc12345');
  const block = composeAmaTrailers({
    workerClass: 'codex',
    reviewerFamily: 'claude-reviewer-lacey',
    riskClass: 'low',
    eligibilityReason: 'clean review, reviewer family recorded, low risk',
    auditRef,
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
      'Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345',
    ].join('\n'),
  );
});

test('composeAmaTrailers renders Closed-By: gemini-closer for the gemini harness', () => {
  // GMW-04: only the executing harness changes; the trailer is generic
  // (`${workerClass}-closer`), so a gemini closer must attribute as
  // `gemini-closer (adversarial-pipe-mode)`.
  const auditRef = amaAuditTraceRef('acme/myrepo', 1234, 'abc12345');
  const block = composeAmaTrailers({
    workerClass: 'gemini',
    reviewerFamily: 'codex-reviewer-lacey',
    riskClass: 'high',
    eligibilityReason: 'clean review, reviewer family recorded, high risk',
    auditRef,
  });
  assert.equal(
    block,
    [
      'Closed-By: gemini-closer (adversarial-pipe-mode)',
      'Reviewed-By: codex-reviewer-lacey',
      'Risk-Class: high',
      'Eligibility-Reason: clean review, reviewer family recorded, high risk',
      'Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345',
    ].join('\n'),
  );
});

test('composeAmaTrailers refuses CR/LF injection in any field', () => {
  for (const field of ['workerClass', 'reviewerFamily', 'riskClass', 'eligibilityReason', 'auditRef']) {
    const base = {
      workerClass: 'codex',
      reviewerFamily: 'claude-reviewer-lacey',
      riskClass: 'low',
      eligibilityReason: 'clean',
      auditRef: 'ama-audit:acme/myrepo:pr-1234:head-abc',
    };
    base[field] = `${base[field]}\nMalicious-Trailer: pwned`;
    assert.throws(
      () => composeAmaTrailers(base),
      /CR\/LF/,
      `composeAmaTrailers must refuse CR/LF injection in ${field}`,
    );
  }
});

test('composeAmaTrailers refuses filesystem paths as Eligibility-Trace refs', () => {
  assert.throws(
    () => composeAmaTrailers({
      workerClass: 'codex',
      reviewerFamily: 'claude-reviewer-lacey',
      riskClass: 'low',
      eligibilityReason: 'clean',
      auditRef: '/Users/airlock/agent-os-hq/dispatch/audit/x.json',
    }),
    /logical trace reference/,
  );
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

test('appendAmaAuditAttempt serializes concurrent appends so both attempts survive', async () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress' },
      now: '2026-06-11T20:00:00Z',
    });
    await Promise.all([
      runConcurrentAppend({ hqRoot, marker: 'A', delayMs: 0 }),
      runConcurrentAppend({ hqRoot, marker: 'B', delayMs: 0 }),
    ]);
    const doc = readAmaAuditEntry(
      hqRoot,
      DEFAULT_TUPLE.repo,
      DEFAULT_TUPLE.prNumber,
      DEFAULT_TUPLE.headSha,
    );
    assert.equal(doc.attempts.length, 3);
    assert.deepEqual(
      doc.attempts.map((attempt) => attempt.marker).filter(Boolean).sort(),
      ['A', 'B'],
    );
    assert.deepEqual(
      doc.attempts.map((attempt) => attempt.attemptNumber),
      [1, 2, 3],
    );
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('appendAmaAuditAttempt reaps stale malformed lockfiles by mtime', () => {
  const hqRoot = freshHqRoot();
  try {
    const { filePath } = writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'in_progress' },
      now: '2026-06-11T20:00:00Z',
    });
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '', { mode: 0o640 });
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const { doc } = appendAmaAuditAttempt({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'deferred', marker: 'after-malformed-lock' },
      now: '2026-06-11T20:02:00Z',
    });
    assert.equal(doc.status, 'deferred');
    assert.equal(doc.attempts.length, 2);
    assert.equal(doc.attempts[1].marker, 'after-malformed-lock');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('ama-audit CLI reserves exit code 65 for sticky-succeeded refusal only', async () => {
  const hqRoot = freshHqRoot();
  try {
    writeAmaAuditEntry({
      hqRoot,
      ...DEFAULT_TUPLE,
      attempt: { outcome: 'succeeded' },
      now: '2026-06-11T20:00:00Z',
    });
    const refused = await runAmaAuditCli([
      'append',
      '--hq-root', hqRoot,
      '--repo', DEFAULT_TUPLE.repo,
      '--pr', String(DEFAULT_TUPLE.prNumber),
      '--head', DEFAULT_TUPLE.headSha,
      '--outcome', 'deferred',
      '--now', '2026-06-11T20:01:00Z',
    ]);
    assert.equal(refused.code, 65);
    assert.match(refused.stderr, /ama-audit-refused: sticky-succeeded/);

    const failed = await runAmaAuditCli([
      'append',
      '--hq-root', hqRoot,
      '--repo', DEFAULT_TUPLE.repo,
      '--pr', String(DEFAULT_TUPLE.prNumber),
      '--head', 'missing-head',
      '--outcome', 'deferred',
      '--now', '2026-06-11T20:01:00Z',
    ]);
    assert.equal(failed.code, 70);
    assert.match(failed.stderr, /ama-audit-error:/);
    assert.doesNotMatch(failed.stderr, /ama-audit-refused:/);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('ama-audit trailers exits 70 for trailer composition errors', async () => {
  const rendered = await runAmaAuditCli([
    'trailers',
    '--worker-class', 'codex',
    '--reviewer', 'claude-reviewer-lacey',
    '--risk-class', 'low',
    '--reason', 'clean',
    '--audit-ref', 'ama-audit:acme/myrepo:pr-1234:head-abc12345',
  ]);
  assert.equal(rendered.code, 0);
  assert.match(rendered.stdout, /Eligibility-Trace: ama-audit:acme\/myrepo:pr-1234:head-abc12345/);

  const failed = await runAmaAuditCli([
    'trailers',
    '--worker-class', 'codex',
    '--reviewer', 'claude-reviewer-lacey',
    '--risk-class', 'low',
    '--reason', 'clean',
    '--audit-ref', '/Users/airlock/agent-os-hq/dispatch/audit/x.json',
  ]);
  assert.equal(failed.code, 70);
  assert.match(failed.stderr, /logical trace reference/);
});
