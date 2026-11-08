// Kept in src for this findings batch's explicitly restricted edit scope.
// Run with: node --test src/watcher-repository-discovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryRefresher } from './watcher-repository-discovery.mjs';
import { observeRepositoryListing } from './repository-identity.mjs';
import { acquireRepositoryStateOwner } from './repository-state-lock.mjs';
import { ensureReviewStateSchema } from './review-state.mjs';

const repository = (id, name) => ({ id, full_name: `example-org/${name}` });
function fixture(t, config = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'discovery-findings-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const warnings = [];
  const logger = { log() {}, error() {}, warn: text => warnings.push(text) };
  const options = { db, rootDir, config: { org: 'example-org', ...config }, logger,
    recordApiCall() {}, apiStatusFromResult: () => 200, apiStatusFromError: () => 503,
    deliverAlert: async () => {} };
  const octokit = { rest: { repos: { listForOrg() {} } }, paginate: async () => {
    throw new Error('offline listing unavailable');
  } };
  return { db, rootDir, warnings, options, octokit,
    seed: repositories => observeRepositoryListing({ db, rootDir, repositories, logger }),
    refresh: () => createRepositoryRefresher(options) };
}

test('static-only scope applies full and short exclusions without org API calls', async t => {
  const f = fixture(t, { org: null, excludeRepos: ['HIDDEN', 'EXAMPLE-ORG/FULL'] });
  assert.deepEqual(await f.refresh()(null,
    ['example-org/hidden', 'example-org/full', 'example-org/kept']), ['example-org/kept']);
});

test('chain rename fallback explicitly warns about the current name fenced by history', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'a'), repository(2, 'c')]);
  assert.ok(f.seed([repository(2, 'a'), repository(1, 'b')]).every(row => !row.conflict));
  // A subsequent safe observation does not erase history.
  f.seed([repository(2, 'a'), repository(1, 'b')]);
  assert.deepEqual(await f.refresh()(f.octokit, []), ['example-org/b']);
  assert.ok(f.warnings.some(text => text.includes('omitted current repository example-org/a')
    && text.includes('ambiguous ownership history')));
});

test('busy complete startup listing explains why new repositories await reconciliation', async t => {
  const f = fixture(t);
  ensureReviewStateSchema(f.db);
  f.seed([repository(1, 'old')]);
  f.octokit.paginate = async () => [repository(1, 'renamed'), repository(2, 'new')];
  const refresh = f.refresh();
  const release = acquireRepositoryStateOwner(f.rootDir);
  try {
    assert.deepEqual(await refresh(f.octokit, []), ['example-org/old']);
    assert.ok(f.warnings.some(text => text.includes('new repositories wait for a contention-free listing')));
  } finally { release(); }
});
