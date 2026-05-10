import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main } from '../src/reset-pr.mjs';
import {
  buildFollowUpJob,
  getFollowUpJobDir,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';

function makeCaptureStream() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

function writeJob(rootDir, dirKey, id, {
  repo = 'laceyenterprises/agent-os',
  prNumber = 480,
  reReview = undefined,
} = {}) {
  const dir = getFollowUpJobDir(rootDir, dirKey);
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, `${id}.json`);
  writeFollowUpJob(jobPath, {
    ...buildFollowUpJob({
      repo,
      prNumber,
      reviewerModel: 'codex',
      reviewBody: '## Summary\nReset me',
      reviewPostedAt: '2026-05-09T08:00:00.000Z',
      critical: false,
    }),
    jobId: id,
    status: dirKey === 'inProgress' ? 'inProgress' : dirKey,
    ...(reReview === undefined ? {} : { reReview }),
  });
  return jobPath;
}

test('reset-pr moves stopped entries to operator reset archive and writes receipt', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reset-pr-'));
  const stoppedPath = writeJob(rootDir, 'stopped', 'job-stopped');
  writeFileSync(`${stoppedPath}.posted`, 'posted sidecar\n', 'utf8');
  writeJob(rootDir, 'failed', 'job-other-pr', { prNumber: 481 });

  const out = makeCaptureStream();
  const rc = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:00:00.000Z',
  });

  assert.equal(rc, 0);
  const result = JSON.parse(out.text());
  assert.equal(result.outcome, 'reset');
  assert.equal(result.movedJobCount, 1);
  assert.equal(result.movedEntryCount, 2);
  assert.equal(existsSync(stoppedPath), false);
  assert.equal(existsSync(`${stoppedPath}.posted`), false);

  const resetDir = path.join(
    rootDir,
    'data',
    'follow-up-jobs',
    '_operator-reset',
    '2026-05-09T19-00-00-000Z',
    'stopped'
  );
  assert.deepEqual(readdirSync(resetDir).sort(), ['job-stopped.json', 'job-stopped.json.posted']);

  const receiptPath = path.join(
    rootDir,
    'data',
    'operator-mutations',
    '2026-05-09T19-00-00-000Z.json'
  );
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.verb, 'hq.adversarial.reset-pr');
  assert.equal(receipt.repo, 'laceyenterprises/agent-os');
  assert.equal(receipt.pr, 480);
  assert.equal(receipt.outcome, 'reset');
});

test('reset-pr does not merge retry-suffixed job sidecars into the first candidate', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reset-pr-'));
  const base = 'laceyenterprises__adversarial-review-pr-480-2026-05-09T19-00-00-000Z';
  const first = writeJob(rootDir, 'stopped', base);
  const second = writeJob(rootDir, 'stopped', `${base}-2`);
  writeFileSync(`${first}.posted`, 'first sidecar\n', 'utf8');
  writeFileSync(`${second}.posted`, 'second sidecar\n', 'utf8');

  const out = makeCaptureStream();
  const rc = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:00:00.000Z',
  });

  assert.equal(rc, 0);
  const result = JSON.parse(out.text());
  assert.equal(result.movedJobCount, 2);
  assert.deepEqual(result.moved.map((item) => item.entries.length), [2, 2]);

  const resetDir = path.join(
    rootDir,
    'data',
    'follow-up-jobs',
    '_operator-reset',
    '2026-05-09T19-00-00-000Z',
    'stopped'
  );
  assert.deepEqual(
    readdirSync(resetDir).sort(),
    [
      `${base}-2.json`,
      `${base}-2.json.posted`,
      `${base}.json`,
      `${base}.json.posted`,
    ]
  );
});

test('reset-pr includes pending and completed rereview-requested jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reset-pr-'));
  writeJob(rootDir, 'pending', 'job-pending');
  writeJob(rootDir, 'completed', 'job-completed-rereview', {
    reReview: { requested: true },
  });
  const settled = writeJob(rootDir, 'completed', 'job-completed-settled', {
    reReview: { requested: false },
  });

  const out = makeCaptureStream();
  const rc = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:00:00.000Z',
  });

  assert.equal(rc, 0);
  const result = JSON.parse(out.text());
  assert.equal(result.movedJobCount, 2);
  assert.equal(existsSync(settled), true);
  assert.deepEqual(result.moved.map((item) => item.status).sort(), ['completed', 'pending']);
});

test('reset-pr disambiguates receipt paths created in the same millisecond', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reset-pr-'));

  const first = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
    '--quiet',
  ], {
    stdout: makeCaptureStream(),
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:00:00.000Z',
  });
  const second = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
    '--quiet',
  ], {
    stdout: makeCaptureStream(),
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:00:00.000Z',
  });

  assert.equal(first, 0);
  assert.equal(second, 0);
  assert.deepEqual(
    readdirSync(path.join(rootDir, 'data', 'operator-mutations')).sort(),
    ['2026-05-09T19-00-00-000Z-2.json', '2026-05-09T19-00-00-000Z.json']
  );
});

test('reset-pr is idempotent when no matching entries remain', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reset-pr-'));

  const out = makeCaptureStream();
  const rc = main([
    'laceyenterprises/agent-os',
    '480',
    '--root-dir', rootDir,
  ], {
    stdout: out,
    stderr: makeCaptureStream(),
    now: () => '2026-05-09T19:01:00.000Z',
  });

  assert.equal(rc, 0);
  const result = JSON.parse(out.text());
  assert.equal(result.outcome, 'noop');
  assert.equal(result.movedJobCount, 0);
  assert.equal(result.movedEntryCount, 0);
  assert.equal(existsSync(path.join(
    rootDir,
    'data',
    'operator-mutations',
    '2026-05-09T19-01-00-000Z.json'
  )), true);
});
