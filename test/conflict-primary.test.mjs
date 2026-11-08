import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hamemptyprimary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  const commit = message => {
    git(['add', 'notes.md']); git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  const write = text => writeFileSync(join(dir, 'notes.md'), text);
  git(['init', '-q', '-b', 'main']);
  write('heading\nSEVDOCS-335 old\nfooter\n');
  const fork = commit('Base');
  git(['checkout', '-qb', 'author']);
  write('heading\nSEVDOCS-335 fixed\nfooter\n');
  const reviewedHead = commit('Author correction');
  git(['checkout', '-q', 'main']);
  write('new heading\nSEVDOCS-335 old\nfooter\n');
  const base = commit('Upstream context');
  git(['checkout', '-q', 'author']);
  assert.throws(() => git(['rebase', 'main']), 'adjacent context causes a real conflict');
  write('new heading\nSEVDOCS-335 fixed\nfooter\n');
  git(['add', 'notes.md']);
  git(['-c', 'core.editor=true', 'rebase', '--continue']);
  const head = git(['rev-parse', 'HEAD']).trim();
  return { dir, git, write, commit, fork, reviewedHead, sourceHead: reviewedHead, head, base };
}

test('HAMEMPTYPRIMARY-01: a real resolved conflict retains the author primary and upstream context', async t => {
  const f = fixture(t);
  const proof = await proveConflictPrimary(f);
  assert.equal(proof?.proof, 'conflict-primary-preserved');
  assert.equal(f.git(['show', `${f.head}:notes.md`]), 'new heading\nSEVDOCS-335 fixed\nfooter\n');
  assert.equal(f.git(['rev-parse', `${f.head}^`]).trim(), f.base);
  assert.notEqual(f.head, f.reviewedHead);
});

test('HAMEMPTYPRIMARY-01: identical text reclassified as HAM loses the primary and is refused', async t => {
  const f = fixture(t);
  f.git(['commit', '--amend', '-qm', 'Conflict repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM']);
  f.head = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(await proveConflictPrimary(f), null);
  const evidence = { headSha: f.head, primaryHead: f.base, mergeBase: f.base,
    hasHammerCommits: true, primaryFiles: [], completeFileLists: true,
    finalFiles: [{ filename: 'notes.md', status: 'modified', patch: '@@ -2 +2 @@\n-SEVDOCS-335 old\n+SEVDOCS-335 fixed' }],
    ciCost: { headSha: f.head, ok: true } };
  const refusal = checkPrimaryChange(evidence, f.head);
  assert.equal(refusal.reason, 'primary-change-unknown');
  assert.match(refusal.detail, /empty primary change/);
});

test('HAMEMPTYPRIMARY-01: subsequent HAM work leaves a nonempty evaluable author primary', t => {
  const f = fixture(t);
  const primary = f.head;
  writeFileSync(join(f.dir, 'post-merge-verify.json'), '{"fixture":true}\n');
  f.git(['add', 'post-merge-verify.json']);
  f.git(['commit', '-qm', 'HAM verification metadata\n\nWorker-Class: hammer\nWorker-Ticket: HAM']);
  const headSha = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(f.git(['rev-parse', `${headSha}^`]).trim(), primary);
  const patch = f.git(['diff', f.base, primary, '--', 'notes.md']).replace(/^[\s\S]*?(?=@@)/, '').trimEnd();
  const file = { filename: 'notes.md', status: 'modified', additions: 1, deletions: 1, patch };
  const metadata = { filename: 'post-merge-verify.json', status: 'added', additions: 1, deletions: 0,
    patch: f.git(['diff', f.base, headSha, '--', 'post-merge-verify.json']).replace(/^[\s\S]*?(?=@@)/, '').trimEnd() };
  const evidence = { headSha, primaryHead: primary, mergeBase: f.base, hasHammerCommits: true,
    primaryFiles: [file], finalFiles: [file, metadata], completeFileLists: true, ciCost: { headSha, ok: true } };
  assert.equal(checkPrimaryChange(evidence, headSha).ok, true);
  assert.equal(checkPrimaryChange({ ...evidence, primaryFiles: [{ ...file, patch: undefined }] }, headSha).reason,
    'primary-change-unknown');
});

test('HAMEMPTYPRIMARY-01: a real reversal cannot claim conflict-only preservation', async t => {
  const f = fixture(t);
  f.write('new heading\nSEVDOCS-335 old\nfooter\n');
  f.git(['add', 'notes.md']); f.git(['commit', '--amend', '--no-edit', '--allow-empty']);
  f.head = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(await proveConflictPrimary(f), null);
});

test('HAMEMPTYPRIMARY-01: an untrusted anchor and unavailable patch fail closed', async t => {
  const f = fixture(t);
  assert.equal(await proveConflictPrimary({ ...f, sourceHead: f.base }), null);
  assert.equal(await proveConflictPrimary({ ...f, git: args => args[0] === 'diff' ? '' : f.git(args) }), null);
  assert.equal(await proveConflictPrimary({ ...f, git: args => {
    if (args[0] === 'diff') throw new Error('unavailable patch');
    return f.git(args);
  } }), null);
});

test('HAMEMPTYPRIMARY-01: the publication helper is read-only and exits nonzero on lost primary', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../bin/hammer-conflict-primary.mjs', import.meta.url));
  const run = () => execFileSync(process.execPath, [cli, f.reviewedHead, f.sourceHead, f.base], {
    cwd: f.dir, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(JSON.parse(run()).proof, 'conflict-primary-preserved');
  assert.equal(f.git(['rev-parse', 'HEAD']).trim(), f.head);
  f.git(['commit', '--amend', '-qm', `HAM rewrite\n\nWorker-Class: hammer\nReviewed-Head: ${f.reviewedHead}`]);
  const collapsed = f.git(['rev-parse', 'HEAD']).trim();
  assert.throws(run, error => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /\nconflict-primary-unproven\n$/);
    return true;
  });
  assert.equal(f.git(['rev-parse', 'HEAD']).trim(), collapsed);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('HAMEMPTYPRIMARY-01: the publication helper preserves Git failure diagnostics', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hamemptyprimary-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/hammer-conflict-primary.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [cli], {
    cwd: dir, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_DIR: join(dir, 'missing.git') },
  }), error => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /conflict-primary-unproven: retain the reviewed author commits and patches before publication/);
    assert.match(error.stderr, /fatal: not a git repository/);
    return true;
  });
});

test('HAMEMPTYPRIMARY-01: conflict procedure proves preservation before publication', () => {
  const text = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const start = text.indexOf('HAM_CONFLICT_SOURCE=$(git rev-parse HEAD)');
  const proof = text.indexOf('/bin/hammer-conflict-primary.mjs', start);
  const publish = text.indexOf('HAM_COMMIT_PUBLICATION_ONLY=1', start);
  assert.ok(start > 0 && proof > start && publish > proof);
  assert.match(text.slice(start, proof), /if \[ "\$HAM_CONFLICT_SOURCE" = "<<REVIEWED_SHA>>" \]/);
});
