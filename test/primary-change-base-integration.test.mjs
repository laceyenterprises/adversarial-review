import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';

const options = {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
  proveDerivedArtifactsImpl: async () => [],
  proveGeneratedBlocksImpl: async () => [],
  proveMigrationRenumbersImpl: async () => [],
  fetchDeadCodeSourcesImpl: async () => [],
};

function fixture(t, { eroded = false, unrelated = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-base-integration-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: rootDir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
  }).trimEnd();
  const source = (a = 1, g = 7) => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    .map((name, i) => `export const ${name} = ${name === 'a' ? a : name === 'g' ? g : i + 1};\n`).join('');
  const save = (path, text, message) => {
    writeFileSync(join(rootDir, path), text);
    git('add', path);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = save('feature.mjs', source(), 'Base');
  git('checkout', '-qb', 'feature');
  const author = save('feature.mjs', source(1, 10), 'Protected author change');
  const hammer = save('repair.mjs', 'export const repair = true;\n', 'Repair\n\nWorker-Class: hammer');
  git('checkout', '-q', 'main');
  if (unrelated) {
    git('checkout', '--orphan', 'unrelated-main');
    git('rm', '-qf', 'feature.mjs');
  }
  const main = unrelated ? save('unrelated.mjs', 'export const unrelated = true;\n', 'Unrelated root')
    : save('feature.mjs', source(9), 'Main advances outside protected region');
  git('checkout', '-q', 'feature');
  git('merge', '--no-ff', '--allow-unrelated-histories', '-m', 'Integrate main', main);
  if (eroded) save('feature.mjs', source(9), 'Erode protected content after integration');
  const headSha = git('rev-parse', 'HEAD');
  const commit = sha => ({ sha,
    parents: git('show', '-s', '--format=%P', sha).split(' ').filter(Boolean).map(sha => ({ sha })),
    commit: { message: git('show', '-s', '--format=%B', sha) } });
  const compare = (from, to) => {
    const mergeBase = git('merge-base', from, to);
    const commits = git('rev-list', '--reverse', `${from}..${to}`).split('\n').filter(Boolean).map(commit);
    const files = git('diff', '--name-status', '--no-renames', mergeBase, to).split('\n').filter(Boolean).map(line => {
      const [status, filename] = line.split('\t');
      const [additions, deletions] = git('diff', '--numstat', mergeBase, to, '--', filename).split('\t').map(Number);
      return { filename, status: { A: 'added', M: 'modified', D: 'removed' }[status],
        additions, deletions,
        sha: git('rev-parse', `${status === 'D' ? mergeBase : to}:${filename}`),
        patch: git('diff', '--no-ext-diff', '--no-renames', '--unified=3', mergeBase, to, '--', filename)
          .split('\n').slice(4).join('\n') };
    });
    return { commits, total_commits: commits.length, files, filesComplete: true,
      status: from === to ? 'identical' : mergeBase === from ? 'ahead' : mergeBase === to ? 'behind' : 'diverged',
      merge_base_commit: { sha: mergeBase } };
  };
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path.endsWith('/pulls/1')) return { base: { sha: main, ref: 'main' }, head: { sha: headSha } };
    if (path.includes('/compare/')) return compare(...path.split('/compare/')[1].split('...'));
    if (path.includes('/commits/')) return commit(path.split('/commits/')[1]);
    throw new Error(`Unexpected offline read: ${path}`);
  };
  return { base, main, author, hammer, headSha, compare, calls,
    args: { repo: 'fixture/project', prNumber: 1, headSha, rootDir, get } };
}

test('main integration projects final content onto the original base and retains the actual author boundary', async t => {
  const f = fixture(t);
  assert.equal(f.compare(f.main, f.author).merge_base_commit.sha, f.base);
  assert.equal(f.compare(f.main, f.headSha).merge_base_commit.sha, f.main);
  const evidence = await fetchPrimaryChange(f.args, options);
  assert.equal(evidence.hasHammerCommits, true);
  assert.equal(evidence.primaryHead, f.author);
  assert.equal(evidence.mergeBase, f.base);
  assert.equal(evidence.comparisonMergeBase, f.main);
  assert.equal(evidence.diagnosticCommitRange[0].sha, f.hammer);
  assert.match(evidence.finalFiles.find(file => file.filename === 'feature.mjs').patch, /-export const a = 1/);
  assert.equal(checkPrimaryChange(evidence, f.headSha).ok, true, JSON.stringify(checkPrimaryChange(evidence, f.headSha)));
});

test('main integration does not conceal eroded protected author content', async t => {
  const f = fixture(t, { eroded: true });
  const evidence = await fetchPrimaryChange(f.args, options);
  assert.equal(evidence.primaryHead, f.author);
  assert.equal(evidence.mergeBase, f.base);
  assert.equal(evidence.hasHammerCommits, true);
  const refusal = checkPrimaryChange(evidence, f.headSha);
  assert.equal(refusal.reason, 'primary-change-reverted', JSON.stringify(refusal));
  assert.equal(refusal.path, 'feature.mjs');
});

test('integrating a genuinely unrelated base cannot establish protected comparison coordinates', async t => {
  const f = fixture(t, { unrelated: true });
  const evidence = await fetchPrimaryChange(f.args, options);
  assert.equal(evidence.hasHammerCommits, null);
  assert.equal(checkPrimaryChange(evidence, f.headSha).ok, false);
});

test('unrelated base, lost author ancestry, wrong projection and capped projection fail closed', async t => {
  for (const mode of ['unrelated-base', 'lost-author', 'wrong-projection', 'capped-projection']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      const get = f.args.get;
      f.args.get = async path => {
        const result = await get(path);
        if (mode === 'unrelated-base' && path.endsWith(`${f.base}...${f.main}`)
          || mode === 'lost-author' && path.endsWith(`${f.author}...${f.headSha}`)) {
          return { ...result, status: 'diverged', merge_base_commit: { sha: 'f'.repeat(40) } };
        }
        if (path.endsWith(`${f.base}...${f.headSha}`)) {
          if (mode === 'wrong-projection') return { ...result, merge_base_commit: { sha: f.main } };
          if (mode === 'capped-projection') return { ...result, filesComplete: false, files: Array(300).fill(result.files[0]) };
        }
        return result;
      };
      const evidence = await fetchPrimaryChange(f.args, options);
      assert.equal(evidence.hasHammerCommits, null);
      assert.equal(checkPrimaryChange(evidence, f.headSha).ok, false);
      if (mode === 'unrelated-base' || mode === 'lost-author') {
        assert.ok(!f.calls.some(path => path.endsWith(`${f.base}...${f.headSha}`)), 'no projection before ancestry proof');
      }
    });
  }
});
