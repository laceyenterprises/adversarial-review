import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { activeHammerPublication } from '../src/ama/hammer-publication-ownership.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = 'fixture/repo';
const identity = { repo, prNumber: 42 };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lac-2252-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'origin.git'), author = join(dir, 'author'), closer = join(dir, 'closer');
  const bin = join(dir, 'bin'), controller = join(dir, 'controller.json');
  mkdirSync(bin);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    HAMMER_LACEY_GH_TOKEN: 'synthetic-hammer', HAM_CONTROLLER_RECORD: controller, HAM_CONTROLLER_TOKEN: 'synthetic-owner',
    HAM_CONTROLLER_PID: String(process.pid), HAM_RUN_DIR: dir, ADVERSARIAL_REVIEW_STATE_DIR: join(dir, 'state'),
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json'), HAM_NODE_BIN: process.execPath,
  };
  writeFileSync(controller, JSON.stringify({ state: 'running', startedAt: new Date().toISOString(),
    controllerPid: process.pid, token: env.HAM_CONTROLLER_TOKEN }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (cwd, file) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, author);
  commit(author, 'base');
  git(author, 'push', '-q', 'origin', 'main');
  git(author, 'checkout', '-qb', 'feature');
  const start = commit(author, 'original');
  git(author, 'push', '-q', 'origin', 'feature');
  git(dir, 'clone', '-qb', 'feature', remote, closer);
  env.HAM_BASE_HEAD = start;
  const remoteHead = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/feature');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const {execFileSync} = require('node:child_process');
if (process.env.GH_TOKEN !== 'synthetic-hammer' || process.argv.slice(2).join(' ') !== 'api repos/fixture/repo/pulls/42') process.exit(91);
if (process.env.FIXTURE_READ_OUTAGE) process.exit(92);
const head = ref => execFileSync('git', ['--git-dir', ${JSON.stringify(remote)}, 'rev-parse', ref]).toString().trim();
console.log(JSON.stringify({head: {ref: 'feature', sha: process.env.FIXTURE_STALE_HEAD || head('refs/heads/feature')}, base: {sha: head('refs/heads/main')}}));
`, { mode: 0o755 });
  const pushLog = join(dir, 'push-log');
  writeFileSync(join(closer, '.git', 'hooks', 'pre-push'), `#!/bin/sh\nprintf 'push\\n' >> '${pushLog}'\n`, { mode: 0o755 });
  const rendered = join(dir, 'publish.sh');
  writeFileSync(rendered, renderHammerProcedure('hammer-publish', { ROOT_DIR: root, RUN_DIR: dir, HQ_ROOT: dir,
    REPO: repo, PR_NUMBER: '42', PR_URL: '42', REVIEWED_SHA: start, TARGET_REMEDIATION_SHA: start }));
  const run = (command, args, extra = {}) => {
    const result = spawnSync(command, args, { cwd: closer, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    return result;
  };
  const api = () => run(process.execPath, [join(root, 'bin', 'hammer-api-publish.mjs'), repo, '42']);
  const direct = (candidate, expected, extra) => run(process.execPath,
    [join(root, 'bin', 'hammer-owned-publication.mjs'), repo, '42', 'head', candidate, 'feature', expected], extra);
  const phase = extra => run('/bin/bash', ['-c', `
export HAM_COMMIT_PUBLICATION_ONLY=1
HAM_MERGE_LEASE_HELD=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
if source "$1"; then status=0; else status=$?; fi
printf 'exit=%s outcome=%s held=%s pushed=%s\\n' "$status" "$HAM_PHASE_OUTCOME" "$HAM_MERGE_LEASE_HELD" "$HAM_PUSHED_HEAD"
exit "$status"
`, '_', rendered], extra);
  return { dir, bin, remote, author, closer, git, start, commit, remoteHead, pushLog, api, direct, phase,
    advance: () => { const head = commit(author, 'concurrent-repair'); git(author, 'push', '-q', 'origin', 'feature'); return head; } };
}

const output = result => JSON.parse(result.stdout.split('\n')[0]);

test('LAC-2252: stale A cannot replace descendant B through API fallback or a direct exact lease', t => {
  const f = fixture(t);
  const moved = f.advance();
  assert.equal(f.git(f.closer, 'rev-parse', 'refs/remotes/origin/feature'), f.start);
  const phase = f.phase();
  assert.equal(phase.status, 20, phase.stderr);
  assert.equal(output(phase).route, 'refused');
  assert.equal(output(phase).fallbackHead, undefined);
  assert.match(phase.stdout, /exit=20 outcome=head-changed held=0 pushed=$/m);
  // A direct caller already knows B and leases on B. The independent DAG check must refuse.
  const direct = f.direct(f.start, moved);
  assert.equal(direct.status, 20, direct.stderr);
  assert.equal(output(direct).phaseOutcome, 'head-changed');
  assert.equal(f.remoteHead(), moved);
  assert.equal(f.git(f.closer, 'rev-parse', 'HEAD'), f.start);
  assert.equal(existsSync(f.pushLog), false);
  assert.equal(activeHammerPublication({ rootDir: f.dir, ...identity, headSha: moved }), null);
});

test('LAC-2252: exact replay is publishable, repeated publication is a no-op, and unreadable or unbound sources refuse', t => {
  const f = fixture(t);
  f.git(f.author, 'checkout', '-q', 'main');
  const base = f.commit(f.author, 'new-base');
  f.git(f.author, 'push', '-q', 'origin', 'main');
  f.git(f.closer, 'fetch', '-q', 'origin');
  f.git(f.closer, 'rebase', 'origin/main');
  const candidate = f.git(f.closer, 'rev-parse', 'HEAD');
  assert.notEqual(candidate, f.start);
  assert.equal(f.git(f.closer, 'rev-parse', 'HEAD^'), base);
  assert.deepEqual(output(f.api()), { route: 'git-fallback', branch: 'feature', fallbackHead: f.start, localHead: candidate, previousHead: f.start });
  for (const env of [{ FIXTURE_READ_OUTAGE: '1' }, { HAM_CONTROLLER_TOKEN: '' }, { HAMMER_LACEY_GH_TOKEN: '' }, { HAM_BASE_HEAD: '' }]) {
    assert.equal(output(f.direct(candidate, f.start, env)).route, 'refused');
    assert.equal(f.remoteHead(), f.start);
    assert.equal(existsSync(f.pushLog), false);
  }
  f.git(f.closer, 'remote', 'set-url', 'origin', join(f.dir, 'unreadable.git'));
  assert.equal(output(f.direct(candidate, f.start)).phaseOutcome, 'source-publication-refused');
  f.git(f.closer, 'remote', 'set-url', 'origin', f.remote);
  const published = f.direct(candidate, f.start);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(output(published).route, 'published');
  assert.equal(f.remoteHead(), candidate);
  rmSync(f.pushLog);
  assert.deepEqual(output(f.direct(candidate, f.start)), { route: 'unchanged', head: candidate, previousHead: candidate });
  assert.equal(output(f.api()).route, 'unchanged');
  assert.equal(existsSync(f.pushLog), false);
});

test('LAC-2252: a pre-mutation fallback cannot repin after the source moves', t => {
  const f = fixture(t);
  f.commit(f.closer, 'first-local-edit');
  const candidate = f.commit(f.closer, 'second-local-edit');
  const fallback = output(f.api());
  assert.equal(fallback.route, 'git-fallback');
  const moved = f.advance();
  for (const env of [{}, { FIXTURE_STALE_HEAD: f.start }]) {
    const direct = f.direct(candidate, fallback.fallbackHead, env);
    assert.equal(direct.status, 20, direct.stderr);
    assert.equal(output(direct).phaseOutcome, 'head-changed');
  }
  assert.equal(f.remoteHead(), moved);
  assert.equal(f.git(f.closer, 'rev-parse', 'HEAD'), candidate);
  assert.equal(existsSync(f.pushLog), false);
});


test('LAC-2252: the physical lease refuses movement after the direct publisher verifies the source', t => {
  const f = fixture(t);
  const candidate = f.commit(f.closer, 'local-edit');
  const moved = f.commit(f.author, 'late-author-edit');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(f.bin, 'git'), `#!${process.execPath}
const {spawnSync, execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
if (args[0] === 'push') execFileSync(realGit, ['-C', ${JSON.stringify(f.author)}, 'push', 'origin', 'feature']);
process.exit(spawnSync(realGit, args, {stdio: 'inherit'}).status);
`, { mode: 0o755 });
  const result = f.direct(candidate, f.start);
  assert.equal(result.status, 20, result.stdout + result.stderr);
  assert.equal(output(result).phaseOutcome, 'head-changed');
  assert.equal(f.remoteHead(), moved);
  assert.equal(f.git(f.closer, 'rev-parse', 'HEAD'), candidate);
  assert.equal(activeHammerPublication({ rootDir: f.dir, ...identity, headSha: moved }), null);
});
