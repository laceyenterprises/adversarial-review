import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryRefresher } from '../src/watcher-repository-discovery.mjs';
import { observeRepositoryListing } from '../src/repository-identity.mjs';
import { acquireRepositoryStateOwner } from '../src/repository-state-lock.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
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
  const logs = [], warnings = [], alerts = [], apiCalls = [];
  const logger = { log: (...args) => logs.push(args.join(' ')), warn: (...args) => warnings.push(args.join(' ')), error() {} };
  const options = { config: { org: 'example-org', ...config }, db, rootDir, now: () => time, logger,
    recordApiCall: call => apiCalls.push(call), apiStatusFromResult: () => 200, apiStatusFromError: () => 503,
    deliverAlert: async (text, options) => { alerts.push({ text, ...options }); } };
  const octokit = { rest: { repos: { listForOrg() {} } }, paginate: async () => {
    calls++;
    if (failure) throw failure;
    return listing;
  } };
  return { db, rootDir, logs, warnings, alerts, apiCalls, options, octokit,
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
  assert.match(alertPresentationForDoc(f.alerts[0]).headline, /Zero watched repositories/);
  assert.match(alertPresentationForDoc(f.alerts[0]).action, /repository-state lock contention/);
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

test('startup rename lock contention restores fallback and retries at startup backoff', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'example-org/old')]);
  f.succeed([repository(1, 'example-org/new')]);
  const refresh = f.create();
  const release = acquireRepositoryStateOwner(f.rootDir);
  let fallback;
  try {
    fallback = await refresh(f.octokit, []);
    assert.deepEqual(fallback, ['example-org/old']);
    assert.deepEqual(f.apiCalls.map(call => call.status), [200]);
    assert.ok(f.warnings.some(line => line.includes('Startup repository discovery degraded')));
  } finally { release(); }
  f.advance(2 * minute - 1);
  await refresh(f.octokit, fallback);
  assert.equal(f.calls, 1);
  f.advance(1);
  assert.deepEqual(await refresh(f.octokit, fallback), ['example-org/new']);
  assert.equal(f.calls, 2);
});

test('steady-state rename lock contention still rethrows and consumes the full interval', async t => {
  const f = fixture(t);
  f.succeed([repository(1, 'example-org/old')]);
  const refresh = f.create();
  const repos = await refresh(f.octokit, []);
  f.advance(60 * minute);
  f.succeed([repository(1, 'example-org/new')]);
  const release = acquireRepositoryStateOwner(f.rootDir);
  try {
    await assert.rejects(refresh(f.octokit, repos), { code: 'REPOSITORY_STATE_BUSY' });
  } finally { release(); }
  f.advance(2 * minute);
  assert.deepEqual(await refresh(f.octokit, repos), repos);
  assert.equal(f.calls, 2);
});

test('failed quarantine persistence preserves the successful listing and in-memory conflict fence', async t => {
  const f = fixture(t);
  f.seed([repository(1, 'example-org/reused'), repository(2, 'example-org/stale')]);
  const refresh = f.create();
  f.db.exec(`CREATE TRIGGER fail_quarantine BEFORE INSERT ON repository_discovery_quarantine
    BEGIN SELECT RAISE(ABORT, 'Synthetic SQLite write failure'); END`);
  f.succeed([repository(3, 'example-org/reused'), repository(4, 'example-org/fresh')]);
  assert.deepEqual(await refresh(f.octokit, []), ['example-org/fresh']);
  assert.deepEqual(f.apiCalls.map(call => call.status), [200]);
  assert.ok(f.warnings.some(line => line.includes('Repository quarantine persistence failed')));
  f.advance(2 * minute);
  await refresh(f.octokit, ['example-org/fresh']);
  assert.equal(f.calls, 1, 'a local write failure must not enter startup retry mode');
});

test('successful and fallback listings share case-insensitive short/full-name and static exclusions', async t => {
  for (const fails of [false, true]) {
    const f = fixture(t, {
      repos: ['example-org/static', 'example-org/hidden', 'example-org/kept'],
      excludeRepos: ['STATIC', 'EXAMPLE-ORG/HIDDEN', 'SKIP', 'EXAMPLE-ORG/FULL'],
    });
    const listing = [repository(1, 'example-org/skip'), repository(2, 'example-org/full'),
      repository(3, 'example-org/visible')];
    f.seed(listing);
    if (fails) f.fail();
    else f.succeed(listing);
    assert.deepEqual(await f.create()(f.octokit, []), ['example-org/kept', 'example-org/visible']);
  }
});

test('first-deploy fallback excludes historically ambiguous names without a persisted quarantine', async t => {
  const f = fixture(t, { repos: ['example-org/reused'] });
  f.seed([repository(1, 'example-org/reused'), repository(2, 'example-org/safe')]);
  // An older owner observed this spelling before the quarantine table existed.
  f.db.prepare('INSERT INTO repository_name_history VALUES (?, ?, ?)').run('3', 'EXAMPLE-ORG/REUSED', new Date().toISOString());
  f.fail();
  const refresh = f.create();
  assert.deepEqual(await refresh(f.octokit, []), ['example-org/safe']);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM repository_discovery_quarantine').get().n, 0);
  f.advance(2 * minute);
  f.succeed([repository(1, 'example-org/reused'), repository(2, 'example-org/safe')]);
  assert.deepEqual(await refresh(f.octokit, ['example-org/safe']), ['example-org/reused', 'example-org/safe']);
});

test('retry and zero-scope grace deadlines are evaluated on the next poll', async t => {
  const f = fixture(t);
  f.fail();
  const refresh = f.create();
  await refresh(f.octokit, []);
  f.advance(5 * minute);
  await refresh(f.octokit, []);
  assert.equal(f.calls, 2);
  assert.equal(f.alerts.length, 1);
});

test('static-only scope applies full and short exclusions without org API calls', async t => {
  const f = fixture(t, { org: null, excludeRepos: ['HIDDEN', 'EXAMPLE-ORG/FULL'] });
  assert.deepEqual(await f.create()(null,
    ['example-org/hidden', 'example-org/full', 'example-org/kept']), ['example-org/kept']);
  assert.equal(f.calls, 0);
});

test('static-only exclusions apply after resolving retained rename identities', async t => {
  for (const exclusion of ['NEW', 'EXAMPLE-ORG/NEW']) {
    const f = fixture(t, { org: null, excludeRepos: [exclusion] });
    ensureReviewStateSchema(f.db);
    f.seed([repository(1, 'example-org/old')]);
    f.seed([repository(1, 'example-org/new')]);
    assert.deepEqual(await f.create()(null, ['example-org/old', 'example-org/kept']),
      ['example-org/kept']);
    assert.equal(f.calls, 0);
  }
});

test('static-only scope deduplicates retained aliases and current names in first-seen order', async t => {
  const f = fixture(t, { org: null });
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'example-org/old')]);
  f.seed([repository(1, 'example-org/new')]);
  const refresh = f.create();
  const repos = await refresh(null,
    ['example-org/old', 'example-org/kept', 'example-org/new', 'example-org/kept']);
  assert.deepEqual(repos, ['example-org/new', 'example-org/kept']);
  assert.deepEqual(await refresh(null, repos), repos);
  assert.equal(f.calls, 0);
});

test('chain rename fallback explicitly warns about the current name fenced by history', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'example-org/a'), repository(2, 'example-org/c')]);
  assert.ok(f.seed([repository(2, 'example-org/a'), repository(1, 'example-org/b')])
    .every(row => !row.conflict));
  // A subsequent safe observation does not erase history.
  f.seed([repository(2, 'example-org/a'), repository(1, 'example-org/b')]);
  f.fail();
  assert.deepEqual(await f.create()(f.octokit, []), ['example-org/b']);
  assert.ok(f.warnings.some(text => text.includes('omitted candidate repository example-org/a')
    && text.includes('ambiguous ownership history')));
});

test('fallback warns for fenced static names absent from current identities but skips excluded names', async t => {
  const f = fixture(t, { repos: ['example-org/static', 'example-org/hidden'], excludeRepos: ['HIDDEN'] });
  const refresh = f.create();
  for (const name of ['static', 'hidden']) {
    for (const id of ['1', '2']) {
      f.db.prepare('INSERT INTO repository_name_history VALUES (?, ?, ?)')
        .run(id, `example-org/${name}`, new Date().toISOString());
    }
  }
  f.fail();
  assert.deepEqual(await refresh(f.octokit, []), []);
  const omissions = f.warnings.filter(text => text.includes('Startup fallback omitted'));
  assert.equal(omissions.length, 1);
  assert.match(omissions[0], /omitted candidate repository example-org\/static/);
});

test('busy complete startup listing explains why new repositories await reconciliation', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'example-org/old')]);
  f.succeed([repository(1, 'example-org/renamed'), repository(2, 'example-org/new')]);
  const refresh = f.create();
  const release = acquireRepositoryStateOwner(f.rootDir);
  try {
    assert.deepEqual(await refresh(f.octokit, []), ['example-org/old']);
    assert.ok(f.warnings.some(text => text.includes('new repositories wait for a contention-free listing')));
  } finally { release(); }
});
