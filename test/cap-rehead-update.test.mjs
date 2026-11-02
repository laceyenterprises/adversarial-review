import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capReheadUpdateMode } from '../src/ama/cap-rehead-update.mjs';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';

const options = {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
  proveDerivedArtifactsImpl: async () => [],
  proveMigrationRenumbersImpl: async () => [],
};

function repository(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cap-rehead-history-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: rootDir,
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Builder', GIT_AUTHOR_EMAIL: 'builder@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Builder', GIT_COMMITTER_EMAIL: 'builder@example.invalid' },
  }).trimEnd();
  const commitFile = (path, text, message) => {
    writeFileSync(join(rootDir, path), text);
    git('add', path);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const originalBase = commitFile('base.txt', 'base\n', 'Synthetic base');
  git('checkout', '-qb', 'feature');
  const builder = commitFile('feature.txt', 'builder\n', 'Synthetic feature');
  const commit = sha => ({ sha,
    parents: git('show', '-s', '--format=%P', sha).split(' ').filter(Boolean).map(sha => ({ sha })),
    commit: { message: git('show', '-s', '--format=%B', sha) },
  });
  const commits = (base, head) => git('rev-list', '--reverse', `${base}..${head}`)
    .split('\n').filter(Boolean).map(commit);
  const args = (base, headSha) => ({
    rootDir, repo: 'synthetic/project', prNumber: 1, headSha,
    get: async path => {
      if (path.endsWith('/pulls/1')) return { base: { sha: base }, head: { sha: headSha } };
      if (path.includes('/compare/')) {
        const [from, to] = path.split('/compare/')[1].split('...');
        const range = commits(from, to);
        return { commits: range, total_commits: range.length, files: [],
          merge_base_commit: { sha: git('merge-base', from, to) } };
      }
      throw new Error(`Unexpected offline read: ${path}`);
    },
  });
  return { git, commitFile, originalBase, builder, args };
}

test('builder-only history selects the existing merge-main variant', async t => {
  const f = repository(t);
  assert.equal(await capReheadUpdateMode(f.args(f.originalBase, f.builder), options), 'merge-main');
  f.git('checkout', '-q', 'main');
  const main = f.commitFile('main.txt', 'upstream\n', 'Synthetic upstream repair\n\nWorker-Class: hammer');
  f.git('checkout', '-q', 'feature');
  assert.equal(await capReheadUpdateMode(f.args(main, f.builder), options), 'merge-main');
  f.git('merge', '--no-ff', '-m', 'Synthetic merge-main', 'main');
  const merged = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('show', '-s', '--format=%P', merged).split(' ').length, 2);
  const evidence = await fetchPrimaryChange(f.args(main, merged), options);
  assert.equal(evidence.hasHammerCommits, false, 'hammer commits already in main are outside the PR range');
  assert.deepEqual(checkPrimaryChange(evidence, merged), { ok: true, applicable: false });
});

test('hammer history, including a later builder tip, selects squash using existing detection', async t => {
  const f = repository(t);
  // Worker-Class alone is recognized by primary-change's isHammerCommit; do
  // not narrow strategy selection to authenticated terminal closer commits.
  const hammer = f.commitFile('repair.txt', 'repair\n', 'Synthetic repair\n\nWorker-Class: hammer');
  assert.equal(await capReheadUpdateMode(f.args(f.originalBase, hammer), options), 'squash');
  const tip = f.commitFile('after.txt', 'after\n', 'Synthetic builder follow-up');
  assert.equal(await capReheadUpdateMode(f.args(f.originalBase, tip), options), 'squash');
});

test('merge-main strands primary evidence; one builder squash preserves the tree and clears it', async t => {
  const f = repository(t);
  const hammer = f.commitFile('repair.txt', 'repair\n',
    'Synthetic repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)');
  f.git('checkout', '-q', 'main');
  const currentMain = f.commitFile('main.txt', 'new main\n', 'Synthetic main advance');
  f.git('checkout', '-q', 'feature');
  f.git('merge', '--no-ff', '-m', 'Synthetic merge-main', 'main');
  const merged = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('merge-base', currentMain, f.builder), f.originalBase);
  assert.equal(f.git('merge-base', currentMain, merged), currentMain);
  const stranded = await fetchPrimaryChange(f.args(currentMain, merged), options);
  assert.equal(stranded.hasHammerCommits, null);
  assert.equal(stranded.reason, 'primary and final merge bases are missing or differ');
  assert.equal(checkPrimaryChange(stranded, merged).reason, 'primary-change-unknown');
  assert.equal(await capReheadUpdateMode(f.args(currentMain, merged), options), 'squash');

  f.git('reset', '--hard', currentMain);
  f.git('merge', '--squash', merged);
  f.git('commit', '-qm', 'Synthetic builder refresh');
  const squashed = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('rev-parse', `${squashed}^{tree}`), f.git('rev-parse', `${merged}^{tree}`));
  assert.equal(f.git('rev-list', '--count', `${currentMain}..${squashed}`), '1');
  assert.equal(f.git('rev-parse', `${squashed}^`), currentMain);
  assert.doesNotMatch(f.git('show', '-s', '--format=%B', squashed), /hammer|closer|attestation/i);
  const fresh = await fetchPrimaryChange(f.args(currentMain, squashed), options);
  assert.equal(fresh.hasHammerCommits, false);
  assert.deepEqual(checkPrimaryChange(fresh, squashed), { ok: true, applicable: false });
  assert.equal(await capReheadUpdateMode(f.args(currentMain, squashed), options), 'merge-main');
  // The original, not-yet-merged hammer head produces the same refresh tree.
  f.git('reset', '--hard', currentMain);
  f.git('merge', '--squash', hammer);
  assert.equal(f.git('write-tree'), f.git('rev-parse', `${squashed}^{tree}`));
});

test('unreadable or incomplete history is never mistaken for a builder-only range', async t => {
  const f = repository(t);
  const args = f.args(f.originalBase, f.builder);
  const read = args.get;
  args.get = async path => path.includes('/compare/')
    ? { ...(await read(path)), total_commits: 2 } : read(path);
  await assert.rejects(capReheadUpdateMode(args, options), /missing, malformed or capped commit history/);
});
