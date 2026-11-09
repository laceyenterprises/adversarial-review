// PATH fake, using the same GitHub-shaped local Git transport as the primary
// change fixtures. Unknown requests fail loudly rather than reaching GitHub.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS } from '../../src/ama/ham-provenance.mjs';

const f = JSON.parse(readFileSync(join(process.env.HAM_RUN_DIR, 'fixture.json'), 'utf8'));
const args = process.argv.slice(2);
appendFileSync(join(process.env.HAM_RUN_DIR, 'gh-calls.jsonl'), JSON.stringify(args) + '\n');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trimEnd();
const commit = sha => ({
  sha, author: { login: 'synthetic-builder' }, committer: { login: 'synthetic-builder' },
  parents: git('show', '-s', '--format=%P', sha).split(' ').filter(Boolean).map(sha => ({ sha })),
  commit: { message: git('show', '-s', '--format=%B', sha), verification: { verified: true, reason: 'valid' } },
});
const file = { filename: 'src/example.mjs', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -2 +2 @@\n-old\n+new' };
let path = args.find(arg => arg.startsWith('repos/'));
let value;
if (args[0] !== 'api' || !path || args.includes('-X')) {
  throw Error(`unexpected fixture GitHub invocation: ${JSON.stringify(args)}`);
}
if (args.includes('--method')) {
  if (args[args.indexOf('--method') + 1] !== 'POST' || !/\/issues\/42\/comments$/.test(path)) {
    throw Error('unexpected fixture mutation');
  }
  value = { node_id: 'IC_synthetic', user: { login: [...HAM_AUDIT_COMMENT_AUTHOR_LOGINS][0] },
    body: args.find(arg => arg.startsWith('body=')).slice(5) };
} else if (/\/pulls\/42$/.test(path)) value = {
  number: 42, state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
  head: { sha: f.head, ref: 'author', repo: { full_name: 'fixture/repo' } },
  base: { sha: f.base, ref: 'main', repo: { default_branch: 'main' } },
  user: { login: 'synthetic-builder' }, body: 'Preserve the synthetic correction.', labels: [],
};
else if (/\/reviews\/1$/.test(path)) value = f.review;
else if (/\/reviews(?:\?|$)/.test(path)) value = [f.review];
else if (/\/branches\/main\/protection$/.test(path)) value = { required_status_checks: { strict: false, contexts: ['test'] } };
else if (/\/check-runs/.test(path)) value = { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: f.head }] };
else if (/\/status(?:\?|$)/.test(path)) value = { state: 'success', statuses: [] };
else if (/\/statuses(?:\?|$)/.test(path)) value = [];
else if (/\/(?:comments|timeline)(?:\?|$)/.test(path)) value = [];
else if (/\/compare\//.test(path)) {
  const [from, to] = path.split('/compare/')[1].split('?')[0].split('...');
  const commits = git('rev-list', '--reverse', `${from}..${to}`).split('\n').filter(Boolean).map(commit);
  value = { status: 'ahead', total_commits: commits.length, commits, files: [file],
    merge_base_commit: { sha: git('merge-base', from, to) } };
} else if (/\/git\/trees\//.test(path)) {
  const ref = path.split('/git/trees/')[1].split('?')[0];
  value = { truncated: false, tree: git('ls-tree', '-r', '-t', ref).split('\n').filter(Boolean).map(line => {
    const [, mode, type, sha, path] = /^(\d+) (\S+) (\S+)\t(.+)$/.exec(line);
    return { mode, type, sha, path };
  }) };
} else if (/\/git\/blobs\//.test(path)) {
  const blobSha = path.split('/git/blobs/')[1].split('?')[0];
  const bytes = execFileSync('git', ['cat-file', 'blob', blobSha], { timeout: 5000 });
  value = { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
} else if (/\/commits\//.test(path)) {
  const sha = path.split('/commits/')[1].split('?')[0];
  value = { ...commit(sha), files: [file] };
} else if (/\/contents\//.test(path)) {
  value = { encoding: 'base64', content: Buffer.from('jobs: {}\n').toString('base64') };
} else throw Error(`unhandled fixture GitHub path: ${path}`);
if (args.includes('--jq')) {
  const jq = args[args.indexOf('--jq') + 1];
  const commitFields = '{sha, commit: {message: .commit.message, author: .commit.author, committer: .commit.committer}, author, committer, parents: [.parents[] | {sha}]}';
  const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key] ?? null]));
  const projectCommit = entry => ({
    ...pick(entry, ['sha', 'author', 'committer']),
    commit: pick(entry.commit, ['message', 'author', 'committer']),
    parents: entry.parents.map(parent => pick(parent, ['sha'])),
  });
  const compareMetadata = () => ({
    ...pick(value, ['status', 'total_commits']),
    merge_base_commit: pick(value.merge_base_commit, ['sha']),
  });
  if (jq === '.') { /* identity projection from the history reader */ }
  else if (jq === '.head.sha') value = value.head.sha;
  else if (jq === '.base.sha') value = value.base.sha;
  else if (jq === '.content') value = value.content;
  else if (jq === '.sha') value = value.sha;
  else if (jq === '{sha, verification: .commit.verification}') {
    value = { sha: value.sha, verification: value.commit.verification };
  }
  else if (jq === '{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}}') {
    value = compareMetadata();
  }
  else if (jq === `{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}, commits: [.commits[] | ${commitFields}]}`) {
    value = { ...compareMetadata(), commits: value.commits.map(projectCommit) };
  }
  else if (jq === `${commitFields.slice(0, -1)}, files: [.files[] | {filename, previous_filename, status, sha, patch, additions, deletions}]}`) {
    value = { ...projectCommit(value), files: value.files.map(entry =>
      pick(entry, ['filename', 'previous_filename', 'status', 'sha', 'patch', 'additions', 'deletions'])) };
  }
  else if (jq === '{tree: [.tree[] | {path, mode, type, sha}], truncated}') {
    value = { tree: value.tree.map(entry => pick(entry, ['path', 'mode', 'type', 'sha'])), truncated: value.truncated };
  }
  else if (jq === '{encoding, content, size}') value = pick(value, ['encoding', 'content', 'size']);
  else throw Error(`unhandled fixture jq: ${jq}`);
}
if (args.includes('-i') || args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\n\r\n');
process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
