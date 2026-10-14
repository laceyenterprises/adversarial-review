export function primaryChangeFixture(headSha) {
  const file = { filename: 'src/config-loader.mjs', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-shadow_only: true\n+shadow_only: false' };
  return { headSha, ciCost: { headSha, ok: true }, hasHammerCommits: true, primaryHead: 'a'.repeat(40), mergeBase: 'b'.repeat(40),
    primaryFiles: [file], finalFiles: [file] };
}
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHistoryReader } from '../../src/ama/history-reader.mjs';


// Real Git objects back an entirely offline GitHub-shaped transport. Compare
// files come from the production tree/blob reader, including its lack of rename
// inference for files which were not present at the merge base.
export function primaryRenameRepository(t, { changed = false, deleted = false,
  modified = false, author = 'hammer-worker', committer = 'hammer-worker',
  verification = undefined, laterHammer = false, existingDestination = false, binary = false, restored = false,
  baseMerge = false, earlierHammer = false, destination = 'named-guide.txt' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-rename-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).trimEnd();
  git('init', '-q');
  const source = 'guide.txt';
  mkdirSync(dirname(join(rootDir, destination)), { recursive: true });
  if (modified) { writeFileSync(join(rootDir, source), 'Base guide\n'); git('add', source); }
  if (existingDestination) { writeFileSync(join(rootDir, destination), 'Builder guide\n'); git('add', destination); }
  git('commit', '-q', '--allow-empty', '-m', 'Fixture base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(rootDir, source), binary ? 'Builder\0guide\n' : 'Builder guide\n');
  git('add', source);
  git('commit', '-q', '-m', 'Add builder guide');
  const builder = git('rev-parse', 'HEAD');
  const blob = git('rev-parse', `HEAD:${source}`);
  let earlierHammerSha;
  if (earlierHammer) {
    git('commit', '-q', '--allow-empty', '-m', 'Earlier repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)');
    earlierHammerSha = git('rev-parse', 'HEAD');
  }
  if (deleted) git('rm', '-q', source);
  else {
    git('mv', '-f', source, destination);
    if (changed) { writeFileSync(join(rootDir, destination), 'Builder Guide\n'); git('add', destination); }
    if (restored) { writeFileSync(join(rootDir, source), 'Base guide\n'); git('add', source); }
  }
  git('commit', '-q', '-m', 'Repair guide name\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)');
  if (baseMerge) {
    const merge = git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-p', builder, '-p', base,
      '-m', git('show', '-s', '--format=%B', 'HEAD'));
    git('update-ref', 'HEAD', merge);
  }
  const renameSha = git('rev-parse', 'HEAD');
  if (laterHammer) {
    writeFileSync(join(rootDir, 'other-guide.txt'), 'Unrelated repair\n');
    git('add', 'other-guide.txt');
    git('commit', '-q', '-m', 'Repair another guide\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)');
  }
  const headSha = git('rev-parse', 'HEAD');
  const commit = sha => ({ sha, author: sha === renameSha ? author && { login: author }
    : { login: sha === headSha ? 'hammer-worker' : 'fixture-builder' },
    committer: sha === renameSha ? committer && { login: committer }
      : { login: sha === headSha ? 'hammer-worker' : 'fixture-builder' },
    parents: git('show', '-s', '--format=%P', sha).split(' ').filter(Boolean).map(sha => ({ sha })),
    commit: { message: git('show', '-s', '--format=%B', sha), author: { name: 'Fixture Author' }, verification } });
  const calls = [];
  const get = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
    const path = args[1]; calls.push(path);
    let data;
    if (path.endsWith('/pulls/1')) data = { head: { sha: headSha }, base: { sha: base } };
    else if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1].split('?')[0].split('...');
      const commits = git('rev-list', '--reverse', `${from}..${to}`).split('\n').filter(Boolean).map(commit);
      data = { status: from === to ? 'identical' : 'ahead', total_commits: commits.length, commits,
        merge_base_commit: { sha: git('merge-base', from, to) } };
    } else if (path.includes('/git/trees/')) data = { truncated: false,
      tree: git('ls-tree', path.split('/git/trees/')[1]).split('\n').filter(Boolean).map(line => {
        const [, mode, type, sha, path] = /^(\d+) (\S+) (\S+)\t(.+)$/.exec(line);
        return { mode, type, sha, path };
      }) };
    else if (path.includes('/git/blobs/')) {
      const bytes = execFileSync('git', ['cat-file', 'blob', path.split('/git/blobs/')[1]], { cwd: rootDir, timeout: 5000 });
      data = { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
    } else if (path.includes('/commits/')) {
      const sha = path.split('/commits/')[1].split('?')[0];
      const files = git('diff', '-M', '--name-status', `${sha}^1`, sha).split('\n').filter(Boolean).map(line => {
        const [status, first, second] = line.split('\t');
        const filename = second || first;
        return { filename, ...(second ? { previous_filename: first } : {}),
          status: status.startsWith('R') ? 'renamed' : status === 'D' ? 'removed' : status === 'A' ? 'added' : 'modified',
          sha: git('rev-parse', `${status === 'D' ? `${sha}^` : sha}:${filename}`),
          ...(status === 'R100' ? { additions: 0, deletions: 0 } : {}) };
      });
      data = { ...commit(sha), files };
      if (args.at(-1) === '{sha, verification: .commit.verification}') data = { sha, verification };
      else delete data.commit.verification;
    } else if (path.includes('/comments') || path.includes('/reviews')) data = [];
    else throw new Error(`Unexpected fixture read: ${path}`);
    for (const entry of data.commits || []) delete entry.commit.verification;
    return { stdout: JSON.stringify(data) };
  } });
  return { rootDir, source, destination, builder, blob, renameSha, earlierHammerSha, calls,
    args: { repo: 'fixture/repo', prNumber: 1, headSha, rootDir, get } };
}
