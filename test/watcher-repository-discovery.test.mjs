import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryRefresher } from '../src/watcher-repository-discovery.mjs';
import { observeRepositoryListing } from '../src/repository-identity.mjs';
import { alertPresentationForDoc } from '../src/alert-delivery.mjs';

const minute = 60_000;
const repository = (id, name) => ({ id, name: name.split('/')[1], full_name: name });
function fixture(t, config = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repository-discovery-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  let time = Date.parse('2026-01-01T00:00:00Z');
  let calls = 0;
  let listing = [];
  let failure = null;
  const logs = [], warnings = [], alerts = [];
  const logger = { log: (...args) => logs.push(args.join(' ')), warn: (...args) => warnings.push(args.join(' ')), error() {} };
  const options = { config: { org: 'example-org', ...config }, db, rootDir, now: () => time, logger,
    recordApiCall() {}, apiStatusFromResult: () => 200, apiStatusFromError: () => 503,
    deliverAlert: async (text, options) => { alerts.push({ text, ...options }); } };
  const octokit = { rest: { repos: { listForOrg() {} } }, paginate: async () => {
    calls++;
    if (failure) throw failure;
    return listing;
  } };
  return { db, rootDir, logs, warnings, alerts, options, octokit,
    create: () => createRepositoryRefresher(options),
    seed: repositories => observeRepositoryListing({ db, rootDir, repositories, logger }),
    advance: ms => { time += ms; },
    fail: (deferMs = null) => { failure = Object.assign(new Error('Synthetic listing failure'), deferMs === null ? {} : {
      budgetDeferred: true, observation: { resetAt: new Date(time + deferMs).toISOString() },
    }); },
    succeed: repositories => { failure = null; listing = repositories; },
    get calls() { return calls; },
  };
}

test('startup failure immediately restores durable names with scope and exclusions', async t => {
  const f = fixture(t, { repos: ['example-org/static'], excludeRepos: ['skip', 'example-org/hidden'] });
  f.seed([repository(1, 'example-org/alpha'), repository(2, 'example-org/skip'),
    repository(3, 'example-org/hidden'), repository(4, 'another-org/other')]);
  f.fail();
  const repos = await f.create()(f.octokit, ['example-org/static']);
  assert.deepEqual(repos, ['example-org/static', 'example-org/alpha']);
  assert.ok(f.logs.some(line => line.includes('watching 2 repos (fallback: last known set)')));
});

test('empty startup warns each poll, alerts once after grace, and retries at deferral end', async t => {
  const f = fixture(t);
  f.fail(3 * minute);
  const refresh = f.create();
  assert.deepEqual(await refresh(f.octokit, []), []);
  assert.equal(f.alerts.length, 0);
  f.advance(2 * minute); // First bounded backoff is earlier than the deferral.
  await refresh(f.octokit, []);
  assert.equal(f.calls, 2);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].event, 'adversarial-repository-discovery');
  assert.equal(alertPresentationForDoc(f.alerts[0]).severity, 'SEV2');
  f.advance(minute - 1);
  await refresh(f.octokit, []);
  assert.equal(f.calls, 2);
  f.advance(1);
  await refresh(f.octokit, []);
  assert.equal(f.calls, 3); // Original error still names the budget's end.
  assert.equal(f.alerts.length, 1);
  assert.equal(f.warnings.filter(line => line.includes('Zero watched repositories')).length, 4);
});

test('a deferral earlier than the first backoff is retried exactly when due', async t => {
  const f = fixture(t);
  f.fail(minute);
  const refresh = f.create();
  await refresh(f.octokit, []);
  f.advance(minute - 1);
  await refresh(f.octokit, []);
  assert.equal(f.calls, 1);
  f.advance(1);
  f.succeed([repository(1, 'example-org/ready')]);
  assert.deepEqual(await refresh(f.octokit, []), ['example-org/ready']);
  assert.equal(f.calls, 2);
});

test('steady-state failure keeps the previous set and full interval even for budget errors', async t => {
  const f = fixture(t);
  f.succeed([repository(1, 'example-org/alpha')]);
  const refresh = f.create();
  let repos = await refresh(f.octokit, []);
  f.advance(60 * minute);
  f.fail(minute);
  repos = await refresh(f.octokit, repos);
  assert.deepEqual(repos, ['example-org/alpha']);
  f.advance(60 * minute - 1);
  await refresh(f.octokit, repos);
  assert.equal(f.calls, 2);
  f.advance(1);
  await refresh(f.octokit, repos);
  assert.equal(f.calls, 3);
});

test('successful listing replaces fallback and begins steady-state cadence', async t => {
  const f = fixture(t);
  f.seed([repository(1, 'example-org/stale')]);
  f.fail();
  const refresh = f.create();
  const fallback = await refresh(f.octokit, []);
  f.advance(2 * minute);
  f.succeed([repository(2, 'example-org/current'), { ...repository(3, 'example-org/archived'), archived: true }]);
  const repos = await refresh(f.octokit, fallback);
  assert.deepEqual(repos, ['example-org/current']);
  f.advance(10 * minute);
  await refresh(f.octokit, repos);
  assert.equal(f.calls, 2);
});

test('startup backoff progresses through two, five and ten minutes and stays capped', async t => {
  const f = fixture(t, { repoRefreshIntervalMs: 7 * minute });
  f.fail();
  const refresh = f.create();
  await refresh(f.octokit, []);
  for (const delay of [2, 5, 7, 7]) {
    const before = f.calls;
    f.advance(delay * minute - 1);
    await refresh(f.octokit, []);
    assert.equal(f.calls, before);
    f.advance(1);
    await refresh(f.octokit, []);
    assert.equal(f.calls, before + 1);
  }
});

test('identity conflict quarantine survives restart and is cleared by an authoritative safe listing', async t => {
  const f = fixture(t);
  f.seed([repository(1, 'example-org/reused'), repository(2, 'example-org/safe')]);
  f.succeed([repository(3, 'example-org/reused'), repository(2, 'example-org/safe')]);
  assert.deepEqual(await f.create()(f.octokit, []), ['example-org/safe']);
  // Absence from a later listing cannot prove that the conflicting name is safe.
  f.succeed([repository(2, 'example-org/safe')]);
  await f.create()(f.octokit, []);
  f.fail();
  const restarted = f.create();
  const fallback = await restarted(f.octokit, []);
  assert.deepEqual(fallback, ['example-org/safe']);
  f.advance(2 * minute);
  f.succeed([repository(1, 'example-org/reused'), repository(2, 'example-org/safe')]);
  assert.deepEqual(await restarted(f.octokit, fallback), ['example-org/reused', 'example-org/safe']);
});

test('a partial paginated failure restores only durable observations', async t => {
  const f = fixture(t);
  f.seed([repository(1, 'example-org/known')]);
  f.octokit.paginate.iterator = async function* () {
    yield { data: [repository(2, 'example-org/partial')] };
    throw new Error('Synthetic pagination failure');
  };
  assert.deepEqual(await f.create()(f.octokit, []), ['example-org/known']);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM repository_identities').get().n, 1);
});

test('empty successful and static scopes warn and alert without triggering extra discovery', async t => {
  for (const config of [{}, { org: null }]) {
    const f = fixture(t, config);
    const refresh = f.create();
    await refresh(f.octokit, []);
    f.advance(2 * minute);
    await refresh(f.octokit, []);
    await refresh(f.octokit, []);
    assert.equal(f.alerts.length, 1);
    assert.equal(f.calls, config.org === null ? 0 : 1);
    await refresh(f.octokit, ['example-org/static']);
    await refresh(f.octokit, []);
    f.advance(2 * minute);
    await refresh(f.octokit, []);
    assert.equal(f.alerts.length, 2);
  }
});

test('failed alert enqueue is retried while discovery remains throttled', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.options.deliverAlert = async () => { if (++attempts === 1) throw new Error('Synthetic outbox failure'); };
  const refresh = f.create();
  await refresh(f.octokit, []);
  f.advance(2 * minute);
  await refresh(f.octokit, []);
  await refresh(f.octokit, []);
  await refresh(f.octokit, []);
  assert.equal(attempts, 2);
  assert.equal(f.calls, 1);
});
