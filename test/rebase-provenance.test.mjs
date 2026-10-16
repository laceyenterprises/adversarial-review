import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
import { proveReviewedRebase } from '../src/ama/reviewed-rebase.mjs';

function fixture(t, { generated = false, changed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rebase-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  run('init', '-q'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
  const write = (path, data) => writeFileSync(join(dir, path), data);
  const commit = message => { run('add', '--all'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  write('source.txt', 'original\n'); write('generated.txt', 'old output\n');
  const fork = commit('Initial');
  write('feature.txt', 'reviewed feature\n');
  const reviewedHead = commit(`Reviewed\n\nWorker-Class: hammer\nReviewed-Head: ${fork}\nClosed-By: hammer (adversarial-pipe-mode)`);
  run('checkout', '-qb', 'base', fork); write('base.txt', 'new base\n');
  if (generated) write('generated.txt', 'merged output\n');
  const base = commit('Base advancement');
  run('checkout', '-qb', 'replay');
  if (generated) write('generated.txt', 'regenerated merged output\n');
  write('feature.txt', changed ? 'unreviewed change\n' : 'reviewed feature\n');
  const head = commit(`Replayed\n\nWorker-Class: hammer\nReviewed-Head: ${fork}\nClosed-By: hammer (adversarial-pipe-mode)\nWorker-Class: codex`);
  write('repair.txt', 'hammer remediation\n'); const currentHead = commit(`Hammer fix\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${reviewedHead}\nClosed-By: hammer (adversarial-pipe-mode)`);
  return { base, options: { repo: 'fixture/repo', reviewedHead, currentHead, hammerBaseHead: head,
    git: async args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }),
    generatedFiles: generated ? ['generated.txt'] : [],
    verifyGenerated: async sha => run('show', `${sha}:generated.txt`) === 'regenerated merged output',
    get: async path => { if (path.endsWith('/commits/main')) return { sha: base }; throw new Error('No ancestry proof'); } } };
}
for (const generated of [false, true]) {
  test(`REBASEPROV-01 base-only rebase with generated=${generated} covers a later hammer head`, async t => {
    const { options } = fixture(t, { generated });
    const range = await fetchHammerHeadRange(options);
    assert.equal(range?.proof, 'reviewed-rebase-patch-equivalence');
    assert.equal(range.currentHead, options.currentHead);
  });
}
test('REBASEPROV-01 unreviewed source resolution fails closed', async t => {
  const { options } = fixture(t, { generated: true, changed: true });
  // A trusted fleet push actor is not authority for unreviewed source edits.
  options.env = { OAUTH_BROKER_CODEX_AGENT_PROVIDER: 'github-app-synthetic-owner' };
  options.prNumber = 42;
  options.loadActivityPage = async () => ({ nodes: [
    { before: options.hammerBaseHead, after: options.currentHead },
    { before: options.reviewedHead, after: options.hammerBaseHead },
  ].map(event => ({ ...event, ref: 'refs/heads/feature', activity_type: 'force_push',
    actor: { type: 'Bot', login: 'synthetic-owner[bot]' }, timestamp: '2026-01-01T00:00:00Z' })), next: null });
  const get = options.get;
  options.get = async path => {
    if (path.endsWith('/pulls/42')) return { head: { ref: 'feature', repo: { full_name: 'fixture/repo' } } };
    if (path.includes('/compare/')) return { status: 'diverged' };
    if (path.endsWith(`/commits/${options.hammerBaseHead}`) || path.endsWith(`/commits/${options.currentHead}`)) {
      return { sha: path.split('/').at(-1), author: { login: 'synthetic-owner[bot]' }, committer: { login: 'web-flow' },
        commit: { verification: { verified: true, reason: 'valid' } } };
    }
    return get(path);
  };
  assert.equal(await fetchHammerHeadRange(options), null);
});
test('REBASEPROV-01 unverified generated output fails closed', async t => {
  const { options } = fixture(t, { generated: true });
  options.verifyGenerated = async () => false;
  assert.equal(await fetchHammerHeadRange(options), null);
});

test('REBASEPROV-01 coverage uses the live PR base even when it has no main ref', async t => {
  const { base, options } = fixture(t, { generated: true });
  options.loadRebaseBase = async () => ({ sha: base });
  options.get = async () => { throw new Error('No main branch or API ancestry proof'); };
  assert.equal((await fetchHammerHeadRange(options))?.proof, 'reviewed-rebase-patch-equivalence');
});

for (const extra of ['empty', 'generated']) {
  for (const replay of ['preserve', 'drop', 'move']) {
    test(`REBASEPROV-01 ${replay} ${extra} commit preserves one-to-one patch positions`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'rebase-series-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
      const write = (path, data) => writeFileSync(join(dir, path), data);
      const commit = message => {
        run('add', '--all'); run('commit', '--allow-empty', '-qm', message);
        return run('rev-parse', 'HEAD');
      };
      const intermediate = () => {
        if (extra === 'generated') write('generated.txt', 'updated output\n');
        commit('Intermediate');
      };
      const feature = () => { write('feature.txt', 'reviewed feature\n'); return commit('Feature'); };
      run('init', '-q'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
      write('generated.txt', 'original output\n');
      const fork = commit('Initial');
      intermediate();
      const reviewedHead = feature();
      run('checkout', '-qb', 'base', fork);
      write('base.txt', 'base advancement\n');
      const base = commit('Base');
      if (replay === 'preserve') intermediate();
      feature();
      if (replay === 'move') intermediate();
      const head = run('rev-parse', 'HEAD');
      const verified = [];
      const proof = await proveReviewedRebase({ reviewedHead, head, base,
        git: async args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }),
        generatedFiles: ['generated.txt'], verifyGenerated: async sha => { verified.push(sha); return true; } });
      assert.equal(proof?.proof ?? null, replay === 'preserve' ? 'reviewed-rebase-patch-equivalence' : null);
      if (replay === 'preserve') {
        assert.equal(proof.reviewedCommits.length, 2);
        assert.equal(proof.replayedCommits.length, 2);
        assert.equal(verified.length, extra === 'generated' ? 2 : 0);
      }
    });
  }
}

for (const kind of ['generated', 'empty']) {
  for (const valid of [true, false]) {
    test(`REBASEPROV-01 ${kind}-only series with valid=${valid} content`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'rebase-only-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      const commit = () => {
        git(['add', '--all']); git(['commit', '--allow-empty', '-qm', 'Fixture']);
        return git(['rev-parse', 'HEAD']).trim();
      };
      git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(dir, 'generated.txt'), 'initial output\n');
      const fork = commit();
      if (kind === 'generated') writeFileSync(join(dir, 'generated.txt'), 'reviewed output\n');
      const reviewedHead = commit();
      git(['checkout', '-qb', 'replay', fork]);
      writeFileSync(join(dir, 'base.txt'), 'base advancement\n');
      const base = commit();
      if (kind === 'generated') writeFileSync(join(dir, 'generated.txt'), 'regenerated output\n');
      if (kind === 'empty' && !valid) writeFileSync(join(dir, 'unexpected.txt'), 'unreviewed\n');
      const head = commit();
      const verified = [];
      const proof = await proveReviewedRebase({ reviewedHead, head, base, git,
        generatedFiles: kind === 'generated' ? ['generated.txt'] : [],
        verifyGenerated: async (sha, paths) => { verified.push({ sha, paths }); return valid; } });
      assert.equal(Boolean(proof), valid);
      assert.deepEqual(verified, kind === 'generated' ? [{ sha: head, paths: ['generated.txt'] }] : []);
    });
  }
}

for (const changed of [false, true]) {
  for (const generated of [false, true]) {
    test(`REBASEPROV-01 subdirectory caller sees sibling changes=${changed}, generated=${generated}`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'rebase-subdir-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      const commit = () => {
        run(['add', '--all']); run(['commit', '-qm', 'Fixture']);
        return run(['rev-parse', 'HEAD']).trim();
      };
      run(['init', '-q']); run(['config', 'user.name', 'Fixture']); run(['config', 'user.email', 'fixture@example.invalid']);
      mkdirSync(join(dir, 'tools'));
      writeFileSync(join(dir, 'tools/local.txt'), 'initial\n');
      writeFileSync(join(dir, 'sibling.txt'), 'initial\n');
      writeFileSync(join(dir, 'generated.txt'), 'initial\n');
      const fork = commit();
      const feature = data => {
        writeFileSync(join(dir, 'tools/local.txt'), 'reviewed\n');
        writeFileSync(join(dir, 'sibling.txt'), data);
        if (generated) writeFileSync(join(dir, 'generated.txt'), 'regenerated\n');
        return commit();
      };
      const reviewedHead = feature('reviewed\n');
      run(['checkout', '-qb', 'replay', fork]);
      writeFileSync(join(dir, 'base.txt'), 'new base\n');
      const base = commit();
      const head = feature(changed ? 'unreviewed\n' : 'reviewed\n');
      const proof = await proveReviewedRebase({ reviewedHead, head, base,
        git: args => execFileSync('git', args, { cwd: join(dir, 'tools'), encoding: 'utf8' }),
        generatedFiles: generated ? ['generated.txt'] : [], verifyGenerated: async () => true });
      assert.equal(Boolean(proof), !changed);
    });
  }
}
