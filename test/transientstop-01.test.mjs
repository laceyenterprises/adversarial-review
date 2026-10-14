import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateHammerStopHold,
  HISTORY_READ_FAILURE_PAGE_GRACE_MS,
  _resetHammerStopHoldPageDebounceForTests,
} from '../src/ama/hammer-stop-hold.mjs';

const repo = 'fixture/repo';
const head = 'a'.repeat(40);
const start = Date.parse('2026-10-01T00:00:00Z');
const at = ms => new Date(start + ms).toISOString();
const logger = { log() {}, info() {}, warn() {}, error() {} };

function fixture(t, predicate = 'history-read-failed') {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'transientstop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const args = {
    rootDir, hqRoot: rootDir, repo, prNumber: 1, headSha: head,
    prMetadata: { headSha: head, mergeableState: 'MERGEABLE', statusCheckRollup: [] },
    // An old audit must not turn the first failed probe into an immediate page.
    readAuditImpl: () => ({ attempts: [{ head, outcome: 'failed-without-merge',
      reason: predicate, startedAt: at(-45 * 60_000), path: 'hammer' }] }),
    fetchPrimaryChangeImpl: async () => ({ headSha: head, historyReadFailed: true }),
    deliverAlertImpl: async (text, options) => pages.push({ text, options }), logger,
  };
  return { args, pages };
}

test('TRANSIENTSTOP-01: persistent failed probes page once at ten minutes, including after restart', async t => {
  const { args, pages } = fixture(t);
  for (const ms of [0, 5 * 60_000, HISTORY_READ_FAILURE_PAGE_GRACE_MS - 1]) {
    const result = await evaluateHammerStopHold({ ...args, now: at(ms) });
    assert.equal(result.action, 'hold');
    assert.equal(result.hammerStop.paged, false);
    assert.equal(pages.length, 0);
  }
  _resetHammerStopHoldPageDebounceForTests();
  for (const ms of [HISTORY_READ_FAILURE_PAGE_GRACE_MS, 15 * 60_000]) {
    const result = await evaluateHammerStopHold({ ...args, now: at(ms) });
    assert.equal(result.hammerStop.paged, true);
    assert.equal(pages.length, 1);
    _resetHammerStopHoldPageDebounceForTests();
  }
});

test('TRANSIENTSTOP-01: successful evidence at the page deadline releases without sending a page', async t => {
  const { args, pages } = fixture(t);
  await evaluateHammerStopHold({ ...args, now: at(0) });
  const result = await evaluateHammerStopHold({ ...args, now: at(HISTORY_READ_FAILURE_PAGE_GRACE_MS),
    fetchPrimaryChangeImpl: async () => ({ headSha: head, hasHammerCommits: false }) });
  assert.equal(result.action, 'release');
  assert.deepEqual(result.changed, ['primary-change-evidence']);
  assert.equal(pages.length, 0);
});

test('TRANSIENTSTOP-01: thrown probes get the same grace; other stop predicates still page immediately', async t => {
  const { args, pages } = fixture(t);
  const failed = { ...args, fetchPrimaryChangeImpl: async () => { throw new Error('synthetic connection failure'); } };
  await evaluateHammerStopHold({ ...failed, now: at(0) });
  assert.equal(pages.length, 0);
  await evaluateHammerStopHold({ ...failed, now: at(HISTORY_READ_FAILURE_PAGE_GRACE_MS) });
  assert.equal(pages.length, 1);
  for (const predicate of ['ci-not-green', 'primary-change-unknown', 'primary-change-read-failed']) {
    const other = fixture(t, predicate);
    assert.equal((await evaluateHammerStopHold({ ...other.args, now: at(0) })).action, 'hold');
    assert.equal(other.pages.length, 1, predicate);
    await evaluateHammerStopHold({ ...other.args, now: at(5 * 60_000) });
    assert.equal(other.pages.length, 1, predicate);
  }
});
