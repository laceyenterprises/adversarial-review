import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveRebaseResult } from '../src/ama/rebase-result.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'rebase-result-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', timeout: 10000 }).trim();
  git(['init', '--bare', '--quiet']);
  const commit = (parent, text, binary = 'original\0bytes', mode = '100644', extraParents = []) => {
    const blob = git(['hash-object', '-w', '--stdin'], text);
    const bin = git(['hash-object', '-w', '--stdin'], binary);
    const tree = git(['mktree'], `${mode} blob ${blob}\tsource\n100644 blob ${bin}\tbinary\n`);
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), ...extraParents.flatMap(p => ['-p', p])], 'fixture\n');
  };
  const ancestor = commit(null, 'base\n\n\n\nauthor\n\n\n\nhammer\n');
  const author = commit(ancestor, 'base\n\n\n\nauthor fixed\n\n\n\nhammer\n');
  const oldHead = commit(author, 'base\n\n\n\nauthor fixed\n\n\n\nhammer fixed\n');
  // Clean overlapping changes need tree replay, not patch-ID/whitespace equivalence.
  const base = commit(ancestor, 'new base\n\n\n\nauthor\n\n\n\nhammer\n');
  const newAuthor = commit(base, 'new base\n\n\n\nauthor fixed\n\n\n\nhammer\n');
  const head = commit(newAuthor, 'new base\n\n\n\nauthor fixed\n\n\n\nhammer fixed\n');
  const prove = (changes = {}) => proveRebaseResult({ oldHead, head, base, git: async args => git(args), ...changes });
  return { git, commit, ancestor, oldHead, base, newAuthor, head, prove };
}

test('LAC-2097: exact replay preserves both author intent and HAM remediation on an overlapping base', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.prove(), { proof: 'exact-rebase-tree-replay', oldHead: f.oldHead,
    head: f.head, base: f.base, commits: [f.newAuthor, f.head] });
});

for (const mutation of ['drop-hammer', 'extra-commit', 'whitespace', 'binary', 'mode', 'merge', 'wrong-base', 'missing-object']) {
  test(`LAC-2097: asynchronous candidate cannot acquire provenance: ${mutation}`, async t => {
    const f = fixture(t);
    const text = f.git(['show', `${f.head}:source`]) + '\n';
    let head = f.head, base = f.base;
    if (mutation === 'drop-hammer') head = f.newAuthor;
    if (mutation === 'extra-commit') head = f.commit(head, text);
    if (mutation === 'whitespace') head = f.commit(f.newAuthor, text.replace('hammer fixed', 'hammer  fixed'));
    if (mutation === 'binary') head = f.commit(f.newAuthor, text, 'changed\0bytes');
    if (mutation === 'mode') head = f.commit(f.newAuthor, text, undefined, '100755');
    if (mutation === 'merge') head = f.commit(f.newAuthor, text, undefined, undefined, [f.oldHead]);
    if (mutation === 'wrong-base') base = f.ancestor;
    if (mutation === 'missing-object') head = 'f'.repeat(40);
    assert.equal(await f.prove({ head, base }), null);
  });
}

test('LAC-2097: conflicting replay and incomplete/oversized histories fail closed', async t => {
  const f = fixture(t);
  const base = f.commit(f.ancestor, 'conflicting replacement\n');
  const head = f.commit(base, 'arbitrary resolution\n');
  assert.equal(await f.prove({ base, head }), null);
  assert.equal(await f.prove({ git: async args => args[0] === 'merge-base' ? f.ancestor
    : Array(257).fill(`${f.head} ${f.base}`).join('\n') }), null);
  assert.equal(await f.prove({ oldHead: 'bad' }), null);
});

test('LAC-2097: known new mutation result waits past an old snapshot even if the old head contains the base', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'known-rebase-result-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const source = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('ham_settle_rebase_snapshot() {'), source.indexOf('ham_base_touches_pr_files() {'))
    .replaceAll('<<RUN_DIR>>', '${TEST_REBASE_DIR}').replaceAll('<<ROOT_DIR>>', 'fixture');
  const from = 'a'.repeat(40), head = 'b'.repeat(40), base = 'c'.repeat(40);
  const result = spawnSync('/bin/bash', ['-c', `
${helper}
BASE_BRANCH=main
POST_REMEDIATION_SHA=${head}
HAM_UPDATE_BRANCH_RETRY_CAP=3
ham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
ham_release_merge_lease() { echo unexpected-release >&2; }
git() { return 0; }
sleep() { :; }
ham_pr() {
  if [ -f "$TEST_REBASE_DIR/first" ]; then candidate=${head}; else candidate=${from}; touch "$TEST_REBASE_DIR/first"; fi
  printf '{"state":"OPEN","baseRefName":"main","headRefOid":"%s"}' "$candidate"
}
ham_settle_rebase_snapshot ${from} ${base} 0 || exit $?
jq -er '.headRefOid' "$TEST_REBASE_DIR/pr-after.json"
`], { cwd, env: { ...process.env, TEST_REBASE_DIR: cwd }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), head);
  assert.equal(result.stderr, '');
});
