import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';

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
  return { options: { repo: 'fixture/repo', reviewedHead, currentHead, hammerBaseHead: head,
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
