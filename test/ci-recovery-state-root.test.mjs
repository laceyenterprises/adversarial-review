// CIRECOVERDIRT-01: CI-recovery budgets are runtime state and must never land
// in the repository working tree. Production deploys this repo as an agent-os
// submodule, and an untracked file there makes main-catchup refuse to deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ciRecoveryStateDir, recoverCancelledChecks } from '../src/ci-recovery.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const repo = 'acme/searchlight';
const headSha = 'c1dec0de'.padEnd(40, '0');
const check = { name: 'ci', state: 'CANCELLED', detailsUrl: `https://github.com/${repo}/actions/runs/7` };
const reservationName = identity => `${createHash('sha256').update(identity).digest('hex')}.json`;
const workflowIdentity = sha => `workflow-rerun:${repo}:${sha}:7`;

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cirecoverdirt-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function cancelledRun(posts, sha = headSha) {
  return async (_cmd, args) => {
    if (args[0] === 'pr') return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: sha }) };
    if (args.includes('POST')) { posts.push(args); return { stdout: '' }; }
    return { stdout: JSON.stringify({ head_sha: sha, status: 'completed', conclusion: 'cancelled', run_attempt: 1 }) };
  };
}

function untracked(rootDir) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: rootDir, encoding: 'utf8' });
}

// The daemon and reviewer admission default rootDir to the checkout root. The
// suite never writes the real checkout, so stand one up from this repo's own
// .gitignore and assert reserve() leaves `git status` exactly as it found it.
function checkoutFixture(t, { dropDispatchRule = false } = {}) {
  const rootDir = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: rootDir });
  let ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  if (dropDispatchRule) {
    ignore = ignore.split('\n').filter(line => !/^\/?dispatch\/?$/.test(line.trim())).join('\n');
  }
  writeFileSync(join(rootDir, '.gitignore'), ignore);
  execFileSync('git', ['add', '.gitignore'], { cwd: rootDir });
  return rootDir;
}

for (const dropDispatchRule of [false, true]) {
  test(`reserve() under a checkout root leaves the working tree clean${dropDispatchRule
    ? ' without the dispatch/ defense-in-depth rule' : ''}`, async t => {
    const rootDir = checkoutFixture(t, { dropDispatchRule });
    const status = untracked(rootDir);
    const posts = [];
    assert.equal(await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha, failedChecks: [check],
      execFileImpl: cancelledRun(posts) }), true);
    assert.equal(posts.length, 1);
    assert.ok(readdirSync(ciRecoveryStateDir(rootDir)).length > 0, 'reservation written under the runtime root');
    assert.equal(relative(rootDir, ciRecoveryStateDir(rootDir)).split('/')[0], 'data');
    assert.equal(untracked(rootDir), status, 'reserve() created nothing visible in the working tree');
    assert.equal(existsSync(join(rootDir, 'dispatch')), false);
  });
}

test('a legacy dispatch/ reservation migrates once and keeps the once-per-head budget', async t => {
  const rootDir = fixture(t);
  const legacyDir = join(rootDir, 'dispatch', 'ci-recovery');
  mkdirSync(legacyDir, { recursive: true });
  const name = reservationName(workflowIdentity(headSha));
  const legacy = { runId: '7', attempt: 1, state: 'posted', reservedAt: '2026-10-05T21:08:00Z' };
  writeFileSync(join(legacyDir, name), JSON.stringify(legacy));
  const posts = [];
  const args = { rootDir, repo, prNumber: 2, headSha, failedChecks: [check], execFileImpl: cancelledRun(posts) };
  assert.equal(await recoverCancelledChecks(args), true);
  assert.equal(await recoverCancelledChecks(args), true);
  assert.equal(posts.length, 0, 'migrated budget is already spent');
  assert.deepEqual(JSON.parse(readFileSync(join(ciRecoveryStateDir(rootDir), name), 'utf8')), legacy);
  assert.deepEqual(readdirSync(legacyDir), [], 'legacy path is read once and never written again');
});

test('a legacy reservation never replaces one already at the runtime root', async t => {
  const rootDir = fixture(t);
  const name = reservationName(workflowIdentity(headSha));
  const legacyDir = join(rootDir, 'dispatch', 'ci-recovery');
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(ciRecoveryStateDir(rootDir), { recursive: true });
  writeFileSync(join(legacyDir, name), JSON.stringify({ runId: '7', attempt: 1, state: 'reserved', reservedAt: '2020-01-01T00:00:00Z' }));
  const current = { runId: '7', attempt: 1, state: 'posted', reservedAt: '2026-10-05T22:00:00Z' };
  writeFileSync(join(ciRecoveryStateDir(rootDir), name), JSON.stringify(current));
  const posts = [];
  await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha, failedChecks: [check], execFileImpl: cancelledRun(posts) });
  assert.equal(posts.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(ciRecoveryStateDir(rootDir), name), 'utf8')), current);
  assert.deepEqual(readdirSync(legacyDir), []);
});

test('no src module joins a watcher root with the repository dispatch/ tree', () => {
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs')) {
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, index) => {
          // The read-only legacy migration source is the one sanctioned reference.
          if (/join\(\s*(rootDir|ROOT|repoRoot|REPO_ROOT)\s*,\s*'dispatch'/.test(line)
            && !/function legacyCiRecoveryStateDir\(/.test(lines[index - 1] || '')) {
            offenders.push(`${relative(ROOT, path)}:${index + 1}`);
          }
        });
      }
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(offenders, []);
});
