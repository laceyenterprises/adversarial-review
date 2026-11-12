import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';

function fixture(t, { message = 'Author correction', sameLine = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamemptyprimary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, config = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...config,
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
  const reviewedHead = commit(message);
  git(['checkout', '-q', 'main']);
  write(sameLine ? 'new heading\nSEVDOCS-335 upstream\nfooter\n' : 'new heading\nSEVDOCS-335 old\nfooter\n');
  const base = commit('Upstream context');
  git(['checkout', '-q', 'author']);
  const rebaseConfig = {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commentChar', GIT_CONFIG_VALUE_0: ';',
  };
  assert.throws(() => git(['rebase', 'main'], rebaseConfig), 'expected a real conflict');
  write('new heading\nSEVDOCS-335 fixed\nfooter\n');
  git(['add', 'notes.md']);
  git(['-c', 'core.editor=true', 'rebase', '--continue'], rebaseConfig);
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

test('HAMEMPTYPRIMARY-01: conflicted replay preserves Markdown and issue references in the message', async t => {
  const f = fixture(t, { message: 'Author correction\n\n## Summary\n#123 reference' });
  assert.match(f.git(['show', '-s', '--format=%B', f.head]), /## Summary\n#123 reference/);
  assert.equal((await proveConflictPrimary(f))?.proof, 'conflict-primary-preserved');
});

test('HAMEMPTYPRIMARY-01: same-line resolution requires reviewed remediation', async t => {
  const f = fixture(t, { sameLine: true });
  assert.equal(f.git(['show', `${f.head}:notes.md`]), 'new heading\nSEVDOCS-335 fixed\nfooter\n');
  assert.equal(await proveConflictPrimary(f), null);
});

test('HAMEMPTYPRIMARY-01: a commit already upstream cannot be certified as replayed', async t => {
  const f = fixture(t);
  f.git(['checkout', '-qb', 'equivalent-upstream', f.fork]);
  f.git(['cherry-pick', '-x', f.reviewedHead]);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['checkout', '--detach', f.reviewedHead]);
  f.git(['rebase', 'equivalent-upstream']);
  const head = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(head, base);
  assert.equal(await proveConflictPrimary({ ...f, base, head }), null);
});

test('HAMEMPTYPRIMARY-01: a reviewed merge commit cannot be certified as linear replay', async t => {
  const f = fixture(t);
  f.git(['checkout', '-qb', 'side', f.fork]);
  writeFileSync(join(f.dir, 'side.txt'), 'side content\n');
  f.git(['add', 'side.txt']);
  f.git(['commit', '-qm', 'Side change']);
  f.git(['checkout', '--detach', f.reviewedHead]);
  f.git(['merge', '--no-edit', 'side']);
  const reviewedHead = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(await proveConflictPrimary({ ...f, reviewedHead, sourceHead: reviewedHead }), null);
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
  await assert.rejects(proveConflictPrimary({ ...f, git: args => {
    if (args[0] === 'diff') throw new Error('unavailable patch');
    return f.git(args);
  } }), /unavailable patch/);
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
    // INCONCLUSIVERETRY-01b: a proof that could not run is not a refusal.
    assert.equal(error.status, 75);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /conflict-primary-failed: the preservation proof could not run; retry/);
    assert.match(error.stderr, /fatal: not a git repository/);
    return true;
  });
});

test('HAMEMPTYPRIMARY-01: Git errors inside the proof reach the publication diagnostic', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../bin/hammer-conflict-primary.mjs', import.meta.url));
  const missing = '1'.repeat(40);
  assert.throws(() => execFileSync(process.execPath, [cli, missing, missing, f.base], {
    cwd: f.dir, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }), error => {
    assert.equal(error.status, 75, 'missing proof evidence is inconclusive');
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /conflict-primary-failed/);
    assert.match(error.stderr, /fatal: Not a valid commit name/);
    return true;
  });
});

test('HAMEMPTYPRIMARY-01: conflict procedure proves preservation before publication', () => {
  // HAMCONFLICTSYNC-01: the procedure is the shipped conflict repair, and the
  // prompt sends the closer back to the close command (publication) after it.
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const invoke = prompt.indexOf('/bin/hammer-conflict-repair.sh');
  assert.ok(invoke > 0 && prompt.indexOf('HAM_COMMIT_PUBLICATION_ONLY=1', invoke) > invoke);
  const text = readFileSync(new URL('../bin/hammer-conflict-repair.sh', import.meta.url), 'utf8');
  const start = text.indexOf('HAM_CONFLICT_SOURCE=$(git rev-parse HEAD)');
  const proof = text.indexOf('/bin/hammer-conflict-primary.mjs', start);
  const done = text.indexOf('HAM next: rerun the close command', start);
  assert.ok(start > 0 && proof > start && done > proof);
  const gate = text.slice(proof, done);
  assert.match(gate, /conflict-primary-unproven/);
  assert.match(gate, /conflict-primary-timeout/);
  assert.match(gate, /hammer-terminal-audit\.mjs" "\$HAM_CONFLICT_PROOF_REASON"/);
  assert.match(text.slice(0, start), /export "GIT_CONFIG_KEY_\$\{count\}=core\.commentChar"/);
  assert.match(text.slice(start, proof), /ham_conflict_comment_char; git rebase "origin\/\$BASE_BRANCH"/);
  assert.match(text.slice(start, proof), /ham_conflict_comment_char; hq generated-conflicts resolve/);
  assert.match(text.slice(start, proof), /if \[ "\$HAM_CONFLICT_SOURCE" = "\$HAM_REVIEWED_SHA" \]/);
});
