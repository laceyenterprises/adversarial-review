import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { enqueueRemediationCloser, startRemediationCloserDrain } from '../src/remediation-closer-queue.mjs';

const repo = 'fixture/project', headSha = 'a'.repeat(40);
const quiet = { warn() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediation-closer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'remediation-closer-queue');
  const enqueue = (jobId, extra = {}) => enqueueRemediationCloser(rootDir, {
    repo, prNumber: 1, jobId, completedAt: '2026-11-20T00:00:00Z', ...extra,
  }, headSha);
  return { rootDir, dir, enqueue };
}

test('completion creates its queue before watcher startup and preserves duplicate events', async t => {
  const { rootDir, dir, enqueue } = fixture(t);
  enqueue('first');
  const [name] = readdirSync(dir);
  assert.ok(name);
  const original = readFileSync(join(dir, name), 'utf8');
  enqueue('first', { reReview: { requested: true } });
  assert.equal(readFileSync(join(dir, name), 'utf8'), original);
  const events = [];
  const queue = startRemediationCloserDrain({ rootDir, logger: quiet, decide: event => { events.push(event); } });
  t.after(() => queue.close());
  await queue.drain();
  assert.deepEqual(events, [{ repo, prNumber: 1, headSha, reviewRequested: false }]);
  assert.deepEqual(readdirSync(dir), []);
});

test('malformed JSON is quarantined once with original bytes while valid events drain', async t => {
  const { rootDir, dir, enqueue } = fixture(t);
  const invalid = ['', '{"repo":', 'invalid JSON'];
  const seen = new Set();
  const files = invalid.map((contents, i) => {
    enqueue(`bad-${i}`);
    const name = readdirSync(dir).find(name => !seen.has(name));
    seen.add(name);
    writeFileSync(join(dir, name), contents);
    return name;
  });
  enqueue('valid');
  const warnings = [], events = [];
  const queue = startRemediationCloserDrain({ rootDir, logger: { warn: line => warnings.push(line) },
    decide: event => { events.push(event); } });
  t.after(() => queue.close());
  await queue.drain();
  await queue.drain();
  assert.equal(events.length, 1);
  assert.equal(warnings.length, invalid.length);
  assert.deepEqual(readdirSync(dir), ['dead-letter']);
  files.forEach((name, i) => assert.equal(readFileSync(join(dir, 'dead-letter', name), 'utf8'), invalid[i]));
  // Restarting the watcher cannot re-admit quarantined files.
  queue.close();
  const restarted = startRemediationCloserDrain({ rootDir, logger: quiet, decide: assert.fail });
  t.after(() => restarted.close());
  await restarted.drain();
});

test('decision exceptions remain retryable rather than being quarantined as JSON errors', async t => {
  const { rootDir, dir, enqueue } = fixture(t);
  enqueue('retry');
  let now = Date.now(), attempts = 0;
  t.mock.method(Date, 'now', () => now);
  const queue = startRemediationCloserDrain({ rootDir, logger: quiet, decide: () => {
    if (++attempts === 1) throw new SyntaxError('decision failed');
  } });
  t.after(() => queue.close());
  await queue.drain();
  assert.equal(readdirSync(dir).length, 1);
  await queue.drain();
  assert.equal(attempts, 1);
  now += 15_001;
  await queue.drain();
  assert.equal(attempts, 2);
  assert.deepEqual(readdirSync(dir), []);
});

// Execute the actual watcher callback without booting daemon services.
const watcher = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
const callback = watcher.slice(watcher.indexOf('const decideRemediationCloser ='),
  watcher.indexOf('const remediationCloser = startRemediationCloserDrain'));
assert.ok(callback.startsWith('const decideRemediationCloser ='));
function watcherDecision({ activeRepos = [repo], fetchPr = async () => null, handle = assert.fail } = {}) {
  return runInNewContext(`${callback}\ndecideRemediationCloser`, {
    console: quiet, db: {}, activeRepos, ROOT: '/fixture', WATCHER_PRIMARY_DOMAIN_ID: 'fixture',
    canonicalRepositoryName: (_db, name) => name,
    stmtGetReviewRow: { get: () => ({ review_status: 'posted' }) },
    withGitHubBudgetScope: (_options, run) => run(),
    timePostedReviewStep: (_stage, _key, _logger, run) => run({ signal: new AbortController().signal }),
    fetchHammerPr: fetchPr, waitForReviewerHandoff: async () => {},
    createWatcherOperatorSurface: () => ({}), createHeadCloserCommitSuppressionResolver: () => ({}),
    execFileAsync: assert.fail, handlePostedReviewRow: handle,
  });
}

for (const scenario of ['unmanaged repository', 'missing PR']) {
  test(`${scenario} is evicted from the queue without retries or dispatch`, async t => {
    const { rootDir, dir, enqueue } = fixture(t);
    enqueue('terminal');
    let fetches = 0;
    const decide = watcherDecision({
      activeRepos: scenario === 'unmanaged repository' ? [] : [repo],
      fetchPr: async (_repo, _pr, options) => {
        fetches++;
        assert.equal(options.optional, true);
        return null;
      },
    });
    const warnings = [];
    const queue = startRemediationCloserDrain({ rootDir, decide, logger: { warn: line => warnings.push(line) } });
    t.after(() => queue.close());
    await queue.drain();
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(warnings, []);
    assert.equal(fetches, scenario === 'missing PR' ? 1 : 0);
  });
}

test('managed open PRs still reach ordinary closure and retain retryable ownership', async t => {
  const { rootDir, dir, enqueue } = fixture(t);
  enqueue('managed');
  let decisions = 0;
  const decide = watcherDecision({
    fetchPr: async () => ({ state: 'OPEN', headRefOid: headSha }),
    handle: async options => {
      assert.equal(options.expectedHead, headSha);
      assert.equal(options.repoPath, repo);
      decisions++;
      return { outcome: 'posted-review-in-flight' };
    },
  });
  const queue = startRemediationCloserDrain({ rootDir, decide, logger: quiet });
  t.after(() => queue.close());
  await queue.drain();
  assert.equal(decisions, 1);
  assert.equal(readdirSync(dir).length, 1);
});
