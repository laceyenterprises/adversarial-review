import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  HAMMER_RETRY_CAP_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  evaluateHammerRetryCap,
  hammerRetryCapFilePath,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const REPO = 'acme/myrepo';
const PR_NUMBER = 3116;
const REVIEWED_HEAD = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';

test('evaluateHammerRetryCap accumulates by logical review job key', () => {
  const first = evaluateHammerRetryCap(null, { jobKey: REVIEWED_HEAD, headSha: 'h1' });
  assert.equal(first.priorAttemptCount, 0);
  assert.equal(first.nextAttemptCount, 1);
  assert.equal(first.capExhausted, false);

  const second = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 1 },
    { jobKey: REVIEWED_HEAD, headSha: 'h2' },
  );
  assert.equal(second.nextAttemptCount, 2);
  assert.equal(second.capExhausted, false);

  const third = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2 },
    { jobKey: REVIEWED_HEAD, headSha: 'h3' },
  );
  assert.equal(third.nextAttemptCount, 3);
  assert.equal(third.capExhausted, true);
  assert.equal(HAMMER_RETRY_CAP_TOTAL_DISPATCHES, 2);
});

test('evaluateHammerRetryCap resets for a genuinely fresh review head', () => {
  const decision = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2, suppressed: true },
    { jobKey: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', headSha: 'newhead' },
  );
  assert.equal(decision.jobKeyChanged, true);
  assert.equal(decision.priorAttemptCount, 0);
  assert.equal(decision.alreadySuppressed, false);
  assert.equal(decision.capExhausted, false);
});

test('hammer retry cap ledger round-trips and corrupt ledgers fail closed', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-unit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };

  const afterFirst = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h1',
    now: '2026-07-05T00:00:00Z',
  });
  assert.equal(afterFirst.attemptCount, 1);

  const afterSecond = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h2',
    now: '2026-07-05T00:05:00Z',
  });
  assert.equal(afterSecond.attemptCount, 2);
  assert.deepEqual(afterSecond.dispatchHeads, ['h1', 'h2']);

  const suppressed = markHammerRetryCapExhausted(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h3',
    attemptCount: 2,
    alertEmitted: true,
    now: '2026-07-05T00:10:00Z',
  });
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).alertedAt, '2026-07-05T00:10:00Z');

  const corruptRoot = mkdtempSync(join(tmpdir(), 'hammer-cap-corrupt-'));
  t.after(() => rmSync(corruptRoot, { recursive: true, force: true }));
  const corruptPath = hammerRetryCapFilePath(corruptRoot, identity);
  mkdirSync(dirname(corruptPath), { recursive: true });
  writeFileSync(corruptPath, '{ "attemptCount": 2, "jobKey":', 'utf8');
  const corrupt = readHammerRetryCapLedger(corruptRoot, identity, { logger: { warn() {} } });
  assert.equal(corrupt?.__corrupt, true);
  assert.equal(
    evaluateHammerRetryCap(corrupt, { jobKey: REVIEWED_HEAD, headSha: 'h1' }).capExhausted,
    true,
  );
});
