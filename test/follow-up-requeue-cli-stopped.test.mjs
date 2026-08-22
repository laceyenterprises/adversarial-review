// Regression: the requeue CLI must reach retriggerable STOPPED jobs.
//
// `requeueFollowUpJobForNextRound` already decides what may be requeued — it
// refuses a stopped job unless its stop code is in RETRIGGERABLE_STOP_CODES, and
// `review-settled` is deliberately in that set for exactly this case ("an
// explicit operator retrigger ... means 'address the remaining non-blocking
// flags'").
//
// The CLI's own path guard excluded `stopped/`, duplicating that decision and
// getting it wrong. On 2026-08-22 it stranded ~10 PRs at `stopped:review-settled`
// with no operator path to reclassify them after the settled-clean deadlock fix
// (#883) landed — the fix corrects future classifications, but jobs already on
// disk need a requeue to pick it up.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requeueFollowUpJobForNextRound } from '../src/follow-up-jobs.mjs';

const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'requeue-'));
  tempRoots.push(root);
  return root;
}

function seedStoppedJob(rootDir, { stopCode, prNumber = 5673 }) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(rootDir, 'data', 'follow-up-jobs', 'pending'), { recursive: true });
  const jobId = `laceyenterprises__agent-os-pr-${prNumber}-2026-08-22T13-21-24-461Z`;
  const jobPath = path.join(dir, `${jobId}.json`);
  writeFileSync(
    jobPath,
    JSON.stringify({
      schemaVersion: 2,
      kind: 'adversarial-review-follow-up',
      status: 'stopped',
      jobId,
      repo: 'laceyenterprises/agent-os',
      prNumber,
      baseBranch: 'main',
      domainId: 'code-pr',
      revisionRef: 'dca43964c527c2e17179d69dad04a37a0bbfaf31',
      riskClass: 'medium',
      builderTag: 'claude-code',
      critical: false,
      reviewBody: '## Blocking issues\n- None.\n\n## Verdict\nComment only\n',
      remediationPlan: {
        mode: 'bounded-manual-rounds',
        maxRounds: 3,
        currentRound: 0,
        rounds: [],
        stop: {
          code: stopCode,
          reason: 'Latest adversarial review verdict is non-blocking; no remediation worker required.',
          stoppedAt: '2026-08-22T13:21:52.149Z',
          sourceStatus: 'pending',
          currentRound: null,
          maxRounds: 3,
        },
      },
    }),
    'utf8',
  );
  return jobPath;
}

test('a stopped:review-settled job can be requeued', () => {
  const root = createTempRoot();
  const jobPath = seedStoppedJob(root, { stopCode: 'review-settled' });
  const result = requeueFollowUpJobForNextRound({ rootDir: root, jobPath, requestedBy: 'operator' });
  assert.ok(result, 'requeue returned no result');
  assert.ok(!existsSync(jobPath), 'the stopped job should have moved out of stopped/');
});

test('a stopped job with a non-retriggerable code is still refused', () => {
  const root = createTempRoot();
  const jobPath = seedStoppedJob(root, { stopCode: 'abandoned' });
  assert.throws(
    () => requeueFollowUpJobForNextRound({ rootDir: root, jobPath, requestedBy: 'operator' }),
    /Cannot requeue follow-up job .* from stopped:abandoned/,
    'widening the CLI must not widen what the library accepts',
  );
});
