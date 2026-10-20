import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedStackedBaseDefaultBranch, guardStackedBase, holdStackedBase, inspectStackedBase } from '../src/ama/stacked-base.mjs';
import { fetchMergeAgentCandidate } from '../src/merge-agent-candidate.mjs';
import { fetchPRBranchMetadata, ensureJobBranchMetadata } from '../src/remediation-git-pr-io.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';

const repo = 'example/widget';
const prNumber = 41;
const defaultBranch = 'trunk';
const pr = { base: { ref: defaultBranch, repo: { default_branch: defaultBranch } } };
function workspace(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'stacked-default-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('cache lookup tolerates invalid repository inputs even with a populated transport cache', async () => {
  const execFileImpl = async () => ({ stdout: JSON.stringify(pr) });
  await inspectStackedBase({ repo, prNumber, execFileImpl });
  assert.equal(cachedStackedBaseDefaultBranch(repo.toUpperCase(), execFileImpl), defaultBranch);
  for (const invalidRepo of [undefined, null, '', 42, {}, []]) {
    assert.equal(cachedStackedBaseDefaultBranch(invalidRepo, execFileImpl), undefined);
  }
});

test('read-failure warnings follow durable persistence and skip failed writes', async t => {
  const rootDir = workspace(t), warnings = [];
  const path = join(rootDir, 'data', 'stacked-base-holds',
    `${createHash('sha256').update(`${repo}#${prNumber}`).digest('hex')}.json`);
  mkdirSync(path, { recursive: true }); // A directory cannot be replaced by a receipt file.
  const options = { rootDir, repo, prNumber,
    state: { reason: 'stacked-base-read-failed', readError: 'timeout' },
    logger: { warn: message => {
      if (message.includes('readError=')) {
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).readError, 'timeout');
      }
      warnings.push(message);
    } } };
  assert.equal((await holdStackedBase(options)).reason, 'stacked-base-read-failed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hold persistence failed/);
  assert.doesNotMatch(warnings[0], /readError=/);
  rmSync(path, { recursive: true });
  await holdStackedBase(options);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /readError=timeout$/);
  await holdStackedBase(options);
  assert.equal(warnings.length, 2, 'a persisted unchanged hold does not warn again');
});

test('a delivered comment receipt without readError is not rewritten on recheck', async t => {
  const rootDir = workspace(t);
  let reads = 0;
  const options = { rootDir, repo, prNumber,
    state: { reason: 'stacked-base-merged', baseBranch: 'feature/parent', defaultBranch },
    execFileImpl: async () => { reads++; return { stdout: '[]' }; } };
  await holdStackedBase(options);
  const dir = join(rootDir, 'data', 'stacked-base-holds');
  const path = join(dir, readdirSync(dir).find(name => name.endsWith('.json')));
  const before = readFileSync(path, 'utf8'), inode = statSync(path).ino;
  assert.ok(JSON.parse(before).commentedAt);
  assert.equal(JSON.parse(before).readError, undefined);
  assert.equal(reads, 2);
  await holdStackedBase(options);
  assert.equal(reads, 2, 'the existing comment receipt prevents further GitHub reads');
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(statSync(path).ino, inode, 'no atomic receipt replacement occurred');
});

for (const branch of ['main', 'trunk']) {
  test(`supplied matching ${branch} branches skip every API read`, async t => {
    const options = { rootDir: workspace(t), repo, prNumber, baseBranch: branch, defaultBranch: branch,
      execFileImpl: () => assert.fail('known default base must not read GitHub') };
    assert.equal((await inspectStackedBase(options)).ok, true);
    assert.equal(await guardStackedBase(options), null);
  });
}

for (const metadata of [{}, { baseBranch: 'trunk' }, { defaultBranch: 'trunk' },
  { baseBranch: '', defaultBranch: '' }, { baseBranch: 'feature/parent', defaultBranch: 'trunk' }]) {
  test(`missing or differing branch metadata preserves the live read: ${JSON.stringify(metadata)}`, async () => {
    let calls = 0;
    const result = await inspectStackedBase({ repo, prNumber, ...metadata,
      execFileImpl: async () => { calls++; return { stdout: JSON.stringify(pr) }; } });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  });
}

test('a successful read caches the repository default briefly, without caching the PR base', async t => {
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const options = { repo, prNumber, execFileImpl: async () => {
    calls++;
    return { stdout: JSON.stringify(pr) };
  } };
  assert.equal((await inspectStackedBase(options)).ok, true);
  assert.equal((await inspectStackedBase({ ...options, baseBranch: defaultBranch })).ok, true);
  assert.equal(calls, 1);
  await inspectStackedBase(options);
  assert.equal(calls, 2, 'a caller without base evidence still reads');
  now += 60_001;
  await inspectStackedBase({ ...options, baseBranch: defaultBranch });
  assert.equal(calls, 3, 'an expired default requires fresh evidence');
  await inspectStackedBase({ ...options, repo: 'example/other', baseBranch: defaultBranch });
  assert.equal(calls, 4, 'another repository cannot use the cached default');
});

for (const [name, error, readError] of [
  ['killed timeout', { killed: true, signal: 'SIGTERM' }, 'timeout'],
  ['timeout code', { code: 'ETIMEDOUT' }, 'timeout'],
  ['timeout text', { message: 'request timed out' }, 'timeout'],
  ['auth wrapper', { authOutage: true }, 'auth'],
  ['unauthorized', { stderr: 'HTTP 401 Unauthorized' }, 'auth'],
  ['forbidden', { stderr: 'HTTP 403 Forbidden' }, 'unknown'],
  ['rate limited', { stderr: 'HTTP 403: API rate limit exceeded' }, 'unknown'],
  ['too many requests', { status: 429,
    stderr: 'HTTP 429: Too Many Requests' }, 'unknown'],
  ['gateway timeout', { stderr: 'HTTP 504: Gateway Timeout' }, '5xx'],
  ['gateway timeout status', { status: 504, message: 'Gateway Timeout' }, '5xx'],
  ['server stderr', { stderr: 'HTTP 503 Service Unavailable' }, '5xx'],
  ['server status', { status: 502 }, '5xx'],
  ['unknown', { message: 'unavailable' }, 'unknown'],
]) {
  test(`read failure classifies ${name} and logs only the class once per hold`, async t => {
    const rootDir = workspace(t), warnings = [];
    const failure = Object.assign(new Error('synthetic-private-detail'), error);
    const held = await guardStackedBase({ rootDir, repo, prNumber,
      execFileImpl: async () => {
        // Quota failures need a bounded reset hint for the metered transport.
        if (name === 'rate limited' || name === 'too many requests') {
          failure.stderr = `< HTTP/2 ${name === 'rate limited' ? 403 : 429}\n< x-ratelimit-remaining: 0\n< x-ratelimit-reset: ${Math.ceil(Date.now() / 1000) + 1}\n${error.stderr}`;
        }
        throw failure;
      },
      logger: { warn: message => warnings.push(message) } });
    assert.equal(held.reason, 'stacked-base-read-failed');
    assert.equal(held.readError, readError);
    assert.equal(held.retryAfterMs, 60_000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`readError=${readError}$`));
    assert.doesNotMatch(warnings[0], /synthetic-private-detail|Service Unavailable|Forbidden/);
    const file = readdirSync(join(rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
    const receipt = JSON.parse(readFileSync(join(rootDir, 'data', 'stacked-base-holds', file)));
    assert.equal(receipt.readError, readError);
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-private-detail/);
  });
}

for (const stdout of ['invalid json', 'null', '{}', '{"base":{"ref":"trunk"}}']) {
  test(`invalid PR evidence has the parse class: ${stdout}`, async () => {
    const result = await inspectStackedBase({ repo, prNumber, execFileImpl: async () => ({ stdout }) });
    assert.deepEqual(result, { ok: false, reason: 'stacked-base-read-failed', readError: 'parse' });
  });
}

test('a supplied stacked base still detects a merged parent from live evidence', async () => {
  let calls = 0;
  const result = await inspectStackedBase({ repo, prNumber, baseBranch: 'feature/parent', defaultBranch,
    execFileImpl: async () => ({ stdout: JSON.stringify(++calls === 1
      ? { base: { ref: 'feature/parent', repo: { default_branch: defaultBranch } } }
      : [{ merged_at: '2026-10-01T00:00:00Z', head: { ref: 'feature/parent', repo: { full_name: repo } } }]) }) });
  assert.equal(result.reason, 'stacked-base-merged');
  assert.equal(calls, 2);
});

test('cancellation still propagates when matching branches are supplied', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectStackedBase({ repo, prNumber, baseBranch: defaultBranch, defaultBranch,
    signal: controller.signal, execFileImpl: () => assert.fail('aborted read') }), { name: 'AbortError' });
});

test('watcher candidates reuse the learned default on subsequent evaluations', async t => {
  const rootDir = workspace(t);
  let reads = 0;
  const preparedSnapshot = { state: 'OPEN', baseRefName: defaultBranch, labels: [], statusCheckRollup: [] };
  const execFileImpl = async (_cmd, args) => {
    if (args[1] === `repos/${repo}/pulls/${prNumber}`) { reads++; return { stdout: JSON.stringify(pr) }; }
    throw new Error('synthetic missing branch protection');
  };
  const options = { rootDir, preparedSnapshot, execFileImpl };
  assert.equal((await fetchMergeAgentCandidate(repo, prNumber, options)).defaultBranch, defaultBranch);
  assert.equal((await fetchMergeAgentCandidate(repo, prNumber, options)).defaultBranch, defaultBranch);
  assert.equal(reads, 1);
});

test('closer dispatch passes known base metadata and logger to the guard', async t => {
  const logger = { warn() {} };
  const result = await maybeDispatchAmaCloser({ cfg: { enabled: true }, prMetadata: { prNumber },
    dispatchContext: { rootDir: workspace(t), repo, baseBranch: defaultBranch, defaultBranch }, logger,
    guardStackedBaseImpl: async options => {
      assert.equal(options.baseBranch, defaultBranch);
      assert.equal(options.defaultBranch, defaultBranch);
      assert.equal(options.logger, logger);
      return { reason: 'synthetic-hold', skipMergeAgent: true };
    } });
  assert.equal(result.reason, 'synthetic-hold');
});


test('remediation hydration returns the default from its existing metadata read', async () => {
  let calls = 0;
  const execFileImpl = async () => {
    calls++;
    return { stdout: JSON.stringify({ ...pr, head: { ref: 'feature/child' } }) };
  };
  assert.equal((await fetchPRBranchMetadata({ repo, prNumber, execFileImpl })).defaultBranch, defaultBranch);
  const hydrated = await ensureJobBranchMetadata({ job: { repo, prNumber }, execFileImpl });
  assert.equal(hydrated.defaultBranch, defaultBranch);
  assert.equal(hydrated.liveBaseBranch, defaultBranch);
  assert.equal(hydrated.job.baseBranch, defaultBranch);
  assert.equal(calls, 2, 'each existing hydration performs just its own read');
});

test('changed read-failure classes update the receipt and a no-read success clears it', async t => {
  const rootDir = workspace(t);
  const warnings = [];
  const options = { rootDir, repo, prNumber, logger: { warn: message => warnings.push(message) } };
  for (const [status, readError] of [[503, '5xx'], [401, 'auth']]) {
    const held = await guardStackedBase({ ...options,
      execFileImpl: async () => { throw Object.assign(new Error('synthetic'), { status }); } });
    assert.equal(held.readError, readError);
    const file = readdirSync(join(rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
    const receipt = JSON.parse(readFileSync(join(rootDir, 'data', 'stacked-base-holds', file)));
    assert.equal(receipt.readError, readError);
  }
  assert.equal(warnings.length, 2);
  assert.equal(await guardStackedBase({ ...options, baseBranch: defaultBranch, defaultBranch,
    execFileImpl: () => assert.fail('success should clear the receipt without an API read') }), null);
  const file = readdirSync(join(rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
  const receipt = JSON.parse(readFileSync(join(rootDir, 'data', 'stacked-base-holds', file)));
  assert.equal(receipt.reason, null);
  assert.equal(receipt.readError, null);
  assert.ok(receipt.clearedAt);
});

test('hydration separates live base evidence from a recovered job default', async () => {
  const job = { repo, prNumber, baseBranch: 'main' };
  const execFileImpl = async () => ({ stdout: JSON.stringify({
    base: { ref: 'feature/parent', repo: { default_branch: 'main' } },
    head: { ref: 'feature/child' },
  }) });
  const hydrated = await ensureJobBranchMetadata({ job, requireBranch: true, execFileImpl });
  assert.equal(hydrated.job.baseBranch, 'main', 'preserve the existing job contract');
  assert.equal(hydrated.liveBaseBranch, 'feature/parent');
  assert.equal(hydrated.defaultBranch, 'main');
  const unchanged = await ensureJobBranchMetadata({ job,
    execFileImpl: () => assert.fail('no hydration needed') });
  assert.equal(unchanged.hydrated, false);
  assert.equal(unchanged.liveBaseBranch, undefined, 'persisted bases are never live evidence');
});

test('unchanged read failures warn once until the class changes or the hold clears', async t => {
  const warnings = [];
  let status = 401;
  const options = { rootDir: workspace(t), repo, prNumber,
    execFileImpl: async () => { throw Object.assign(new Error('synthetic'), { status }); },
    logger: { warn: message => warnings.push(message) } };
  await guardStackedBase(options);
  await guardStackedBase(options);
  assert.equal(warnings.length, 1);
  status = 403;
  await guardStackedBase(options);
  await guardStackedBase(options);
  assert.equal(warnings.length, 2);
  await guardStackedBase({ ...options, baseBranch: defaultBranch, defaultBranch });
  await guardStackedBase(options);
  assert.equal(warnings.length, 3, 'a new hold episode warns again');
});
