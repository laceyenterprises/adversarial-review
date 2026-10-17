import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcherReviewerQuotaPollFactory } from '../src/watcher-reviewer-quota.mjs';
import { readAfhReviewerGrounding, DEFAULT_AFH_STALE_IF_ERROR_MS } from '../src/afh-reviewer-fallback.mjs';
import { FLEET_QUOTA_STATUS_TIMEOUT_MS, resolveReviewerWorkerClassWithFallback } from '../src/review-worker-class-fallback.mjs';

const stdout = JSON.stringify({ providerStatuses: [
  { provider: 'openai', authPath: 'oauth', state: 'ok' },
  { provider: 'anthropic', authPath: 'oauth', state: 'exhausted' },
  { provider: 'google', authPath: 'oauth', state: 'exhausted' },
] });
const quiet = { log() {}, warn() {}, error() {} };

function fixture(quotaStdout = stdout) {
  let now = 1000, reads = 0, fail = false;
  const logs = [], timeouts = [];
  const beginPoll = createWatcherReviewerQuotaPollFactory({ env: {}, nowFn: () => now,
    logger: { ...quiet, log: line => logs.push(line) },
    readImpl: options => readAfhReviewerGrounding({ ...options, retryDelaysMs: [] }),
  });
  return { beginPoll: () => beginPoll(async (_command, _args, options) => {
    timeouts.push(options.timeout);
    reads++;
    if (fail) throw new Error('synthetic quota read failure');
    return { stdout: quotaStdout };
  }), reads: () => reads, logs, timeouts,
  advance: ms => { now += ms; }, fail: () => { fail = true; } };
}

async function fallback(snapshot) {
  return resolveReviewerWorkerClassWithFallback({ authorClass: 'gemini', primary: 'claude-code',
    fallbackWorkerClasses: ['codex'], env: {}, fleetQuotaStatus: snapshot.fleetQuotaStatus,
    execFileImpl: () => { assert.fail('a candidate must use the poll snapshot'); }, logger: quiet });
}

test('STARTADMIT-01: concurrent candidates and late posted handlers share one quota read past the old TTL', async () => {
  const f = fixture();
  const poll = f.beginPoll();
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => poll.getGrounding()));
  f.advance(20 * 60_000);
  const posted = await poll.getGrounding();
  for (const snapshot of snapshots) assert.equal(snapshot, posted);
  assert.equal((await fallback(posted)).workerClass, 'codex');
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.timeouts, [FLEET_QUOTA_STATUS_TIMEOUT_MS], 'the shared read retains the loaded-watcher timeout');
  poll.logReads();
  assert.match(f.logs[0], /poll=1 reads=1/);
  await f.beginPoll().getGrounding();
  assert.equal(f.reads(), 2, 'the next poll refreshes even within a TTL');
});

test('STARTADMIT-01: a failed poll pins the last good snapshot for every candidate and posted handler', async () => {
  const f = fixture();
  const good = await f.beginPoll().getGrounding();
  f.advance(60_001); f.fail();
  const poll = f.beginPoll();
  const stale = await poll.getGrounding();
  assert.ok(stale.staleIfError);
  assert.equal(stale.providers, good.providers);
  assert.equal(stale.fleetQuotaStatus.stdout, stdout);
  assert.deepEqual(await poll.execFile('hq', ['fleet', 'quota', 'status', '--json']), { stdout, stderr: '' },
    'posted handlers receive the same stale-if-error quota evidence');
  assert.equal(stale.claudeAccountSelection, null, 'legacy quota evidence stays account-agnostic');
  assert.equal((await fallback(stale)).workerClass, 'codex');
  f.advance(DEFAULT_AFH_STALE_IF_ERROR_MS + 1);
  assert.equal(await poll.getGrounding(), stale, 'even late posted handlers see the poll snapshot');
  assert.equal(f.reads(), 2);
  const expired = await f.beginPoll().getGrounding();
  assert.equal(expired.available, false, 'the next poll must respect the stale evidence age bound');
  assert.equal(expired.staleIfError, undefined);
  assert.equal(f.reads(), 3);
});

test('STARTADMIT-01: cold failure is shared and does not create fresh account evidence', async () => {
  const f = fixture(); f.fail();
  const poll = f.beginPoll();
  const first = await poll.getGrounding();
  f.advance(90_000);
  assert.equal(await poll.getGrounding(), first);
  assert.equal(first.available, false);
  assert.equal((await fallback(first)).reason, 'fleet-quota-status-unavailable');
  assert.equal(f.reads(), 1);
});

test('STARTADMIT-01: AFH rollback still shares the fallback quota read and delegates other commands', async () => {
  let reads = 0;
  const beginPoll = createWatcherReviewerQuotaPollFactory({ env: { ADVERSARIAL_AFH_REVIEWER_FALLBACK: 'false' } });
  const poll = beginPoll(async (_command, args) => { reads++; return args[0] === 'fleet' ? { stdout } : 'delegated'; });
  assert.equal((await poll.getGrounding()).reason, 'afh-reviewer-fallback-disabled');
  const options = { authorClass: 'gemini', primary: 'claude-code', fallbackWorkerClasses: ['codex'],
    env: {}, execFileImpl: poll.execFile, fleetQuotaStatusCacheTtlMs: 0, logger: quiet };
  for (let candidate = 0; candidate < 4; candidate++) await resolveReviewerWorkerClassWithFallback(options);
  assert.equal(reads, 1);
  assert.equal(await poll.execFile('synthetic', ['other']), 'delegated');
  assert.equal(reads, 2);
});


test('STARTADMIT-01: stale poll evidence keeps the independently ready managed account held', async () => {
  const payload = JSON.parse(stdout);
  payload.providerStatuses.push({ provider: 'anthropic', authPath: 'oauth-corp', state: 'ok' });
  payload.reserveFloors = { 'anthropic-oauth-corp': { active: false, paused: false, nearCap: false,
    weeklyMeasurement: { status: 'measured', percentRemaining: 80 } } };
  payload.brokerAuth = { provider_states: { 'claude-code-corp': { ready: true, can_serve: true } } };
  const f = fixture(JSON.stringify(payload));
  const good = await f.beginPoll().getGrounding();
  assert.equal(good.claudeAccountSelection.hold, false);
  f.advance(60_001); f.fail();
  const poll = f.beginPoll();
  const stale = await poll.getGrounding();
  assert.equal(stale.claudeAccountSelection.hold, true);
  assert.equal(stale.claudeAccountSelection.reason, 'claude-account-evidence-unknown');
  assert.equal(await poll.getGrounding(), stale);
});
