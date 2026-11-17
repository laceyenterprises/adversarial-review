import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryRefresher } from '../src/watcher-repository-discovery.mjs';
import { ownerScopedOrgClient } from '../src/watcher-additional-org-client.mjs';
import { createGithubOwnerTokenSelector } from '../src/github-owner-token.mjs';
import { observeRepositoryListing } from '../src/repository-identity.mjs';
import { acquireRepositoryStateOwner } from '../src/repository-state-lock.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { loadConfig } from '../src/config-loader.mjs';

const minute = 60_000;
const repo = (id, full) => ({ id, name: full.split('/')[1], full_name: full });

// Fake octokit: listings and failures are keyed by the org it is asked to list.
function fakeClient(label, listings, failures, seen) {
  return { label, rest: { repos: { listForOrg() {} } },
    paginate: async (_fn, params) => {
      seen.push({ client: label, org: params.org });
      if (failures.has(params.org)) throw failures.get(params.org);
      return listings.get(params.org) ?? [];
    } };
}
function fixture(t, { config = {}, additionalOrgs = ['example-second-org'], clients } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'additional-org-discovery-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  let time = Date.parse('2026-01-01T00:00:00Z');
  const listings = new Map(), failures = new Map(), seen = [], warnings = [], logs = [], apiCalls = [], alerts = [];
  const logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => warnings.push(a.join(' ')), error() {} };
  const home = fakeClient('home', listings, failures, seen);
  const orgClients = clients ?? { 'example-second-org': fakeClient('second', listings, failures, seen) };
  const clientCalls = [];
  const refresher = createRepositoryRefresher({ config: { org: 'example-org', ...config }, db, rootDir,
    now: () => time, logger, recordApiCall: c => apiCalls.push(c), apiStatusFromResult: () => 200,
    apiStatusFromError: () => 503, deliverAlert: async (text, o) => { alerts.push({ text, ...o }); },
    additionalOrgs: () => additionalOrgs, clientForOrg: org => { clientCalls.push(org); return orgClients[org] ?? null; } });
  return { db, rootDir, listings, failures, seen, warnings, logs, apiCalls, alerts, home, clientCalls,
    refresh: current => refresher(home, current), advance: ms => { time += ms; },
    seed: repositories => observeRepositoryListing({ db, rootDir, repositories, logger }) };
}

test('empty additionalOrgs behaves exactly as the single-org watcher', async t => {
  const f = fixture(t, { additionalOrgs: [], config: { excludeRepos: ['skip'] } });
  f.listings.set('example-org', [repo(1, 'example-org/alpha'), repo(2, 'example-org/skip')]);
  assert.deepEqual(await f.refresh([]), ['example-org/alpha']);
  assert.deepEqual(f.seen, [{ client: 'home', org: 'example-org' }]);
  assert.deepEqual(f.clientCalls, []);
});

test('the default org and an additional org merge as owner/name', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta'), { id: 3, name: 'old', archived: true }]);
  assert.deepEqual(await f.refresh([]), ['example-org/alpha', 'example-second-org/beta']);
  assert.ok(f.apiCalls.some(c => c.repo === 'example-second-org/*') && f.apiCalls.some(c => c.repo === 'example-org/*'));
});

test('excludeRepos applies across orgs by full and short name', async t => {
  const f = fixture(t, { config: { excludeRepos: ['example-second-org/hidden', 'skip'] } });
  f.listings.set('example-org', [repo(1, 'example-org/alpha'), repo(2, 'example-org/skip')]);
  f.listings.set('example-second-org', [repo(3, 'example-second-org/hidden'),
    repo(4, 'example-second-org/skip'), repo(5, 'example-second-org/kept')]);
  assert.deepEqual(await f.refresh([]), ['example-org/alpha', 'example-second-org/kept']);
});

test('an additional-org failure keeps the default org and that org\'s previous set', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  let repos = await f.refresh([]);
  f.advance(61 * minute);
  f.listings.set('example-org', [repo(1, 'example-org/alpha'), repo(3, 'example-org/gamma')]);
  f.failures.set('example-second-org', new Error('Synthetic second-org failure'));
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha', 'example-org/gamma', 'example-second-org/beta']);
  assert.ok(f.apiCalls.some(c => c.repo === 'example-second-org/*' && c.status === 503));
});

test('additional-org rename lock contention defers discovery and consumes the full interval', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/old')]);
  const repos = await f.refresh([]);
  f.advance(61 * minute);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/new')]);
  const release = acquireRepositoryStateOwner(f.rootDir);
  try {
    await assert.rejects(f.refresh(repos), { code: 'REPOSITORY_STATE_BUSY' });
    assert.deepEqual(f.apiCalls.map(call => call.status), [200, 200, 200, 200]);
    assert.equal(f.db.prepare('SELECT full_name FROM repository_identities WHERE repository_id=?')
      .get('2').full_name, 'example-second-org/old');
  } finally { release(); }
  f.advance(2 * minute);
  assert.deepEqual(await f.refresh(repos), repos);
  assert.equal(f.seen.length, 4, 'contention still consumes the ordinary refresh interval');
  f.advance(59 * minute);
  assert.deepEqual(await f.refresh(repos), ['example-org/alpha', 'example-second-org/new']);
});

test('additional-org local observation failures do not record failed GitHub API calls', async t => {
  for (const priorSuccess of [false, true]) await t.test(`prior listing: ${priorSuccess}`, async t => {
    const clients = {};
    const f = fixture(t, { clients });
    const client = fakeClient('second', f.listings, f.failures, f.seen);
    clients['example-second-org'] = client;
    f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
    f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
    f.seed([repo(2, 'example-second-org/beta')]);
    const repos = priorSuccess ? await f.refresh([]) : [];
    if (priorSuccess) f.advance(61 * minute);
    const paginate = client.paginate;
    client.paginate = async (...args) => {
      const result = await paginate(...args);
      // Fail the local identity read only after the remote listing succeeds.
      t.mock.method(f.db, 'prepare', () => { throw new Error('Synthetic SQLite read failure'); }, { times: 1 });
      return result;
    };
    assert.deepEqual(await f.refresh(repos), ['example-org/alpha', 'example-second-org/beta']);
    assert.ok(f.apiCalls.some(call => call.repo === 'example-second-org/*' && call.status === 200));
    assert.ok(f.apiCalls.every(call => call.status === 200), 'local errors must not become remote failures');
  });
});

test('a default-org failure keeps prior default repos while refreshing additional orgs', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  let repos = await f.refresh([]);
  f.advance(61 * minute);
  f.failures.set('example-org', new Error('Synthetic default-org failure'));
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta'), repo(4, 'example-second-org/delta')]);
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/beta', 'example-second-org/delta']);
});

test('a startup additional-org failure restores that org from durable identities', async t => {
  const f = fixture(t);
  f.seed([repo(7, 'example-second-org/durable')]);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.failures.set('example-second-org', new Error('Synthetic second-org failure'));
  assert.deepEqual(await f.refresh([]), ['example-org/alpha', 'example-second-org/durable']);
});

test('startup additional-org fallback warns for fenced candidates but not excluded names', async t => {
  const f = fixture(t, { config: { excludeRepos: ['hidden'] } });
  f.seed([repo(7, 'example-second-org/durable'), repo(8, 'example-second-org/quarantined'),
    repo(9, 'example-second-org/ambiguous'), repo(10, 'example-second-org/hidden')]);
  f.db.prepare('INSERT INTO repository_discovery_quarantine VALUES (?)').run('EXAMPLE-SECOND-ORG/QUARANTINED');
  f.db.prepare('INSERT INTO repository_discovery_quarantine VALUES (?)').run('example-second-org/hidden');
  f.db.prepare('INSERT INTO repository_name_history VALUES (?, ?, ?)')
    .run('11', 'EXAMPLE-SECOND-ORG/AMBIGUOUS', new Date().toISOString());
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.failures.set('example-second-org', new Error('Synthetic second-org failure'));

  assert.deepEqual(await f.refresh([]), ['example-org/alpha', 'example-second-org/durable']);
  assert.deepEqual(f.warnings.filter(line => line.includes('Startup fallback omitted')), [
    '[watcher] Startup fallback omitted candidate repository example-second-org/ambiguous: persisted quarantine or ambiguous ownership history; an authoritative safe listing is required.',
    '[watcher] Startup fallback omitted candidate repository example-second-org/quarantined: persisted quarantine or ambiguous ownership history; an authoritative safe listing is required.',
  ]);
});

test('a missing owner-scoped client skips that org with one log line and lists the rest', async t => {
  const f = fixture(t, { additionalOrgs: ['example-second-org', 'example-third-org'],
    clients: { 'example-third-org': null } });
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  assert.deepEqual(await f.refresh([]), ['example-org/alpha']);
  f.advance(61 * minute);
  assert.deepEqual(await f.refresh(['example-org/alpha']), ['example-org/alpha']);
  assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 1);
  assert.equal(f.warnings.filter(line => line.includes('example-third-org skipped')).length, 1);
  assert.deepEqual(f.seen.filter(s => s.org !== 'example-org'), []);
});

test('an unavailable owner installation warns once without repeated listing errors', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.failures.set('example-second-org', Object.assign(new Error('owner token unavailable'),
    { code: 'github-owner-token-unavailable' }));
  let repos = await f.refresh([]);
  f.advance(61 * minute);
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha']);
  assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 1);
  assert.equal(f.apiCalls.filter(call => call.repo === 'example-second-org/*').length, 0);
});

test('quarantine is per org: a conflicted repository leaves other orgs untouched', async t => {
  const f = fixture(t);
  f.seed([repo(10, 'example-second-org/taken')]);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  // Same name, different repository id: an identity conflict for this repository only.
  f.listings.set('example-second-org', [repo(11, 'example-second-org/taken'), repo(12, 'example-second-org/fine')]);
  const repos = await f.refresh([]);
  assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/fine']);
  assert.equal(f.alerts.filter(a => a.source === 'adversarial-repository-identity').length, 1);
  assert.deepEqual(f.db.prepare('SELECT full_name FROM repository_discovery_quarantine').all()
    .map(r => r.full_name), ['example-second-org/taken']);
});

test('owner token outages warn again after a successful recovery', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  const outage = Object.assign(new Error('owner token unavailable'),
    { code: 'github-owner-token-unavailable' });
  f.failures.set('example-second-org', outage);
  let repos = await f.refresh([]);
  assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 1);

  f.failures.delete('example-second-org');
  f.advance(61 * minute);
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/beta']);

  f.failures.set('example-second-org', outage);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.advance(61 * minute);
    repos = await f.refresh(repos);
    assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/beta']);
    assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 2);
  }
});

test('the additional org lists through its own client, never the default client', async t => {
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  await f.refresh([]);
  assert.deepEqual(f.seen, [{ client: 'home', org: 'example-org' }, { client: 'second', org: 'example-second-org' }]);
  assert.deepEqual(f.clientCalls, ['example-second-org']);
});

test('an unreadable additional-org config keeps the known orgs and the default listing', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'additional-org-config-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const listings = new Map([['example-org', [repo(1, 'example-org/alpha')]], ['example-second-org', [repo(2, 'example-second-org/beta')]]]);
  const seen = []; let broken = false;
  const warnings = [];
  const refresher = createRepositoryRefresher({ config: { org: 'example-org' }, db, rootDir, now: () => 0,
    logger: { log() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} }, recordApiCall() {},
    apiStatusFromResult: () => 200, apiStatusFromError: () => 503, deliverAlert: async () => {},
    additionalOrgs: () => { if (broken) throw new Error('Synthetic config failure'); return ['example-second-org']; },
    clientForOrg: () => fakeClient('second', listings, new Map(), seen) });
  const octokit = fakeClient('home', listings, new Map(), seen);
  let repos = await refresher(octokit, []);
  broken = true;
  repos = await refresher(octokit, repos);
  assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/beta']);
  assert.ok(warnings.some(line => line.includes('Additional orgs unreadable')));
});

test('a removed additional org stays removed after a later config read error', async t => {
  let configured = ['example-second-org'], broken = false;
  let time = Date.parse('2026-01-01T00:00:00Z');
  const f = fixture(t);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  // Use the same refresher across all three reads to exercise its retained scope.
  const refresher = createRepositoryRefresher({ config: { org: 'example-org' }, db: f.db, rootDir: f.rootDir,
    now: () => time, logger: { log() {}, warn() {}, error() {} }, recordApiCall() {},
    apiStatusFromResult: () => 200, apiStatusFromError: () => 503, deliverAlert: async () => {},
    additionalOrgs: () => { if (broken) throw new Error('Synthetic config failure'); return configured; },
    clientForOrg: () => fakeClient('second', f.listings, new Map(), f.seen) });
  let repos = await refresher(f.home, []);
  assert.deepEqual(repos, ['example-org/alpha', 'example-second-org/beta']);
  configured = [];
  time += 61 * minute;
  repos = await refresher(f.home, repos);
  assert.deepEqual(repos, ['example-org/alpha']);
  broken = true;
  time += 61 * minute;
  repos = await refresher(f.home, repos);
  assert.deepEqual(repos, ['example-org/alpha']);
});

test('removing an additional org evicts its client and outage warning before reconfiguration', async t => {
  const configured = ['example-second-org'], clients = {};
  const f = fixture(t, { additionalOrgs: configured, clients });
  clients['example-second-org'] = fakeClient('old', f.listings, f.failures, f.seen);
  f.listings.set('example-org', [repo(1, 'example-org/alpha')]);
  f.failures.set('example-second-org', Object.assign(new Error('owner token unavailable'),
    { code: 'github-owner-token-unavailable' }));
  let repos = await f.refresh([]);
  assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 1);
  configured.length = 0;
  f.advance(61 * minute);
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha']);

  clients['example-second-org'] = fakeClient('new', f.listings, f.failures, f.seen);
  configured.push('example-second-org');
  f.advance(61 * minute);
  repos = await f.refresh(repos);
  assert.deepEqual(repos, ['example-org/alpha']);
  assert.deepEqual(f.clientCalls, ['example-second-org', 'example-second-org']);
  assert.equal(f.seen.at(-1).client, 'new');
  assert.equal(f.warnings.filter(line => line.includes('example-second-org skipped')).length, 2);

  f.failures.delete('example-second-org');
  f.listings.set('example-second-org', [repo(2, 'example-second-org/beta')]);
  f.advance(61 * minute);
  assert.deepEqual(await f.refresh(repos), ['example-org/alpha', 'example-second-org/beta']);
});

test('ownerScopedOrgClient authenticates with the org token and declines unrouted orgs', async () => {
  const selected = [], created = [];
  const tokens = { routedOwner: target => (target.owner === 'example-second-org' ? 'example-second-org' : null),
    select: async options => { selected.push(options); return 'second-org-token'; } };
  const create = options => { created.push(options); return { created: true }; };
  assert.equal(ownerScopedOrgClient('example-org', { tokens, create, env: {} }), null);
  const env = { GITHUB_TOKEN: 'home-token', GH_TOKEN: 'fallback-token',
    OAUTH_BROKER_SHARED_SECRET_FILE: 'fixture-secret' };
  const client = ownerScopedOrgClient('example-second-org', { tokens, create, env });
  assert.deepEqual(client, { created: true });
  assert.equal(await created[0].authProvider({ url: '/orgs/example-second-org/repos' }), 'second-org-token');
  assert.deepEqual(selected, [{ token: 'home-token', env, role: 'merge-agent', target: { owner: 'example-second-org' } }]);
});

test('ownerScopedOrgClient accepts GH_TOKEN with the watcher role and real owner token selector', async () => {
  const minted = [], created = [];
  const tokens = createGithubOwnerTokenSelector({ readHomeOwner: () => 'example-org',
    mint: async options => { minted.push(options); return { token: 'second-org-token' }; } });
  const create = options => { created.push(options); return { created: true }; };
  const env = { GH_TOKEN: 'home-token', OAUTH_BROKER_SHARED_SECRET_FILE: 'fixture-secret',
    WATCHER_GH_BROKER_ROLE: 'watcher-app' };
  assert.equal(ownerScopedOrgClient('example-second-org', { tokens, create, env: {} }), null);
  assert.equal(ownerScopedOrgClient('example-second-org', { tokens, create,
    env: { GH_TOKEN: 'home-token' } }), null);
  assert.deepEqual(ownerScopedOrgClient('example-second-org', { tokens, create, env }), { created: true });
  assert.equal(await created[0].authProvider(), 'second-org-token');
  assert.deepEqual(minted.map(({ role, owner }) => ({ role, owner })),
    [{ role: 'watcher-app', owner: 'example-second-org' }]);
});

test('additional_orgs is an optional host-local key validated as org logins', t => {
  const dir = mkdtempSync(join(tmpdir(), 'additional-org-cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  const localPath = join(dir, 'config.local.yaml');
  writeFileSync(topPath, 'version: 1\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).getAdditionalWatchedOrgs(), []);
  writeFileSync(localPath, 'version: 1\ngithub:\n  additional_orgs:\n    - example-second-org\n');
  assert.deepEqual(loadConfig({ topPath, env: {} }).getAdditionalWatchedOrgs(), ['example-second-org']);
  for (const valid of ['a', 'a1', 'example-second-org', 'a'.repeat(39)]) {
    writeFileSync(localPath, `version: 1\ngithub:\n  additional_orgs:\n    - ${JSON.stringify(valid)}\n`);
    assert.deepEqual(loadConfig({ topPath, env: {} }).getAdditionalWatchedOrgs(), [valid]);
  }
  for (const bad of ['-leading-dash', 'example-org-', '-', 'a'.repeat(40), 'has space', 'owner/repo', '']) {
    writeFileSync(localPath, `version: 1\ngithub:\n  additional_orgs:\n    - ${JSON.stringify(bad)}\n`);
    assert.throws(() => loadConfig({ topPath, env: {} }), /github\.additional_orgs\[0\]/, bad);
  }
});

test('the committed default configuration names no additional orgs', () => {
  assert.deepEqual(loadConfig({ env: {} }).getAdditionalWatchedOrgs(), []);
});
