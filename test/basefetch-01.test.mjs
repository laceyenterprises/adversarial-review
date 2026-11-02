import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardedGit = spawnSync('/bin/bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const source = readFileSync(join(repoRoot, 'bin/hammer-verify-head.sh'), 'utf8');
const functions = source.slice(source.indexOf('ham_update_branch_transient() {'),
  source.indexOf('ham_update_branch_with_retries() {'));
const strictness = source.match(/^ham_resolve_base_strictness\(\) \{\n[\s\S]*?^\}/m)[0];
const revalidation = source.slice(source.indexOf('HAM_EFFECTIVE_VALIDATION_BASE_SHA="$HAM_VALIDATION_BASE_SHA"'),
  source.indexOf('# CONFIRM THE REBASE HOLDS:'));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basefetch-01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', TMPDIR: dir, HAM_NODE_BIN: process.execPath,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, AGENT_OS_CONFIG_PATH: join(dir, 'config.yaml') };
  writeFileSync(env.AGENT_OS_CONFIG_PATH, 'version: 1\nadversarial:\n  reviewer:\n    load_aware:\n      enabled: true\n      max_multiplier: 2\n');
  const render = text => text.replaceAll('<<ROOT_DIR>>', repoRoot).replaceAll('<<RUN_DIR>>', dir)
    .replaceAll('<<PR_NUMBER>>', '42').replaceAll('<<REPO>>', 'fixture/repo');
  const run = (text, extra = {}) => spawnSync('/bin/bash', ['-uc', render(text)], {
    cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000,
  });
  return { dir, env, run, script: (name, text) => writeFileSync(join(dir, 'bin', name), text, { mode: 0o755 }) };
}

function localRemote(f) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  };
  git('-c', 'init.templateDir=', 'init', '--initial-branch=main', 'remote');
  const remoteGit = (...args) => git('-C', 'remote', ...args);
  remoteGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'synthetic base');
  const base = remoteGit('rev-parse', 'HEAD');
  remoteGit('checkout', '-b', 'other');
  remoteGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'synthetic concurrent fetch');
  const other = remoteGit('rev-parse', 'HEAD');
  git('-c', 'init.templateDir=', 'init', '--initial-branch=main');
  remoteGit('tag', 'fixture-tag', base);
  git('remote', 'add', 'origin', join(f.dir, 'remote'));
  return { git, base, other };
}

for (const trial of [1, 2, 3]) test(`BASEFETCH-01: a competing fetch cannot replace the captured base SHA (trial ${trial})`, t => {
  const f = fixture(t);
  const { git, base, other } = localRemote(f);
  // Interleave deterministically at the vulnerable fetch/read boundary. This
  // delegates to real local git and overwrites FETCH_HEAD after our fetch.
  f.script('git', `#!/bin/bash
if [ "$1" = fetch ]; then
  "$BASEFETCH_GIT" "$@" || exit $?
  exec "$BASEFETCH_GIT" fetch --no-tags origin refs/heads/other
fi
exec "$BASEFETCH_GIT" "$@"
`);
  f.env.BASEFETCH_GIT = guardedGit;
  const result = f.run(`
${functions}
BASE_BRANCH=main
ham_capture_current_base_sha || exit 1
printf '%s' "$HAM_CAPTURED_BASE_SHA"
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'FETCH_HEAD'), other, 'prove the interleaving happened');
  assert.equal(result.stdout, base);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/ham-basefetch/'), '', 'private ref cleaned');
});

test('BASEFETCH-01: fetch only the base and preserve successful stderr even with configured pruning', t => {
  const f = fixture(t);
  const { git, base } = localRemote(f);
  git('fetch', '--no-tags', 'origin', 'main');
  git('config', 'fetch.prune', 'true');
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  const commands = Array.from({ length: 256 }, (_, i) => `update refs/remotes/origin/stale-${i} ${base}`).join('\n') + '\n';
  const seeded = spawnSync('git', ['update-ref', '--stdin'], { cwd: f.dir, env: f.env, input: commands, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  f.script('git', `#!/bin/bash
if [ "$1" = fetch ]; then printf '%s\\n' "$*" >> fetch-args; echo 'synthetic successful fetch diagnostic' >&2; fi
exec "$BASEFETCH_GIT" "$@"
`);
  f.env.BASEFETCH_GIT = guardedGit;
  const result = f.run(`
${functions}
BASE_BRANCH=main
ham_capture_current_base_sha || exit 1
printf '%s' "$HAM_CAPTURED_BASE_SHA"
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, base);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/').split('\n').filter(ref => ref.includes('/stale-')).length, 256);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/tags/'), '');
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), base, 'downstream revalidation retains tracking ref');
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/other'), '');
  assert.match(readFileSync(join(f.dir, 'fetch-base.stderr'), 'utf8'), /synthetic successful fetch diagnostic/);
  const args = readFileSync(join(f.dir, 'fetch-args'), 'utf8');
  assert.match(args, /--no-prune/);
  assert.match(args, /--no-tags/);
  assert.match(args, /--refmap=/);
  assert.doesNotMatch(args, /refs\/heads\/\*|--prune(?:\s|$)/);
});

test('BASEFETCH-01: a failed fetch clears the prior capture without cleanup diagnostics', t => {
  const f = fixture(t);
  const { git, base } = localRemote(f);
  const result = f.run(`
${functions}
BASE_BRANCH=missing-base
HAM_CAPTURED_BASE_SHA=${base}
if ham_capture_current_base_sha; then exit 90; fi
printf '%s' "$HAM_CAPTURED_BASE_SHA"
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/ham-basefetch/'), '');
  assert.match(readFileSync(join(f.dir, 'fetch-base.stderr'), 'utf8'), /couldn't find remote ref/);
  // Real Git treats deleting an absent ref as a silent success. Keep teardown
  // unconditional so a failed fetch that did write the private ref cleans up.
  assert.equal(readFileSync(join(f.dir, 'rev-parse-base.stderr'), 'utf8'), '');
  assert.equal(result.stderr, '');
});

test('BASEFETCH-01: stalled fetch keeps scaled deadline and stderr when ps cannot sample CPU', t => {
  const f = fixture(t);
  const preload = join(f.dir, 'load.mjs');
  writeFileSync(preload, `import os from 'node:os';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
os.loadavg = () => [6, 6, 6];
os.cpus = () => [{}, {}];
cp.execFileSync = () => { throw new Error('synthetic CPU sample denied'); };
syncBuiltinESMExports();\n`);
  f.script('git', `#!/bin/bash
[ "$1" = fetch ] || exit 0
echo 'synthetic transport stalled' >&2
trap 'exit 143' TERM
while :; do /bin/sleep 0.1; done
`);
  f.script('sleep', '#!/bin/sh\nexit 0\n');
  const result = f.run(`${functions}\nBASE_BRANCH=main\nham_capture_current_base_sha`, {
    HAM_GIT_SYNC_NOMINAL_SECONDS: '1', NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const stderr = readFileSync(join(f.dir, 'fetch-base.stderr'), 'utf8');
  assert.match(stderr, /CPU sample unavailable; using full load-based corroboration/);
  assert.equal((stderr.match(/git fetch timed out after 2s/g) || []).length, 2, stderr);
  assert.equal((stderr.match(/synthetic transport stalled/g) || []).length, 2, stderr);
});

for (const [valid, fetched, expected] of [
  [false, true, 'validation-base-sha-invalid'],
  [true, false, 'validation-base-fetch-failed'],
]) test(`BASEFETCH-01: revalidation distinguishes ${expected}`, t => {
  const f = fixture(t);
  const result = f.run(`
${functions}
HAM_FORCE_REVALIDATION=0
HAM_VALIDATION_BASE_SHA=${valid ? 'a'.repeat(40) : 'invalid'}
HAM_PRODUCED_HEAD=${'b'.repeat(40)}
POST_REMEDIATION_SHA=$HAM_PRODUCED_HEAD
BASE_BRANCH=main
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=${'c'.repeat(40)}; return ${fetched ? 0 : 1}; }
git() { return 1; }
${revalidation}
cat '<<RUN_DIR>>/merge-lease-revalidation.json'
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { needsRevalidation: true, reason: expected });
});

test('BASEFETCH-01: plan-unavailable protection 403 cannot fail the base read or force revalidation', t => {
  const f = fixture(t);
  const { git, base } = localRemote(f);
  git('fetch', '--no-tags', 'origin', 'main');
  git('checkout', '--detach', base);
  const result = f.run(`
${functions}
${strictness}
BASE_BRANCH=main
HAM_FORCE_REVALIDATION=0
HAM_VALIDATION_BASE_SHA=${base}
HAM_PRODUCED_HEAD=${base}
POST_REMEDIATION_SHA=${base}
HAM_PHASE_OUTCOME=fixture
ham_gh() {
  if [[ "$2" == */required_status_checks ]]; then
    echo 'Upgrade to GitHub Pro or make this repository public (HTTP 403)' >&2; return 1
  fi
  printf '%s' '{"name":"main","protected":false,"commit":{"sha":"${base}"}}'
}
ham_resolve_base_strictness
ham_capture_current_base_sha || { HAM_PHASE_OUTCOME=merge-lease-base-read-failed; exit 1; }
${revalidation}
printf '%s\\n' "$HAM_PHASE_OUTCOME" "$HAM_REQUIRES_UP_TO_DATE" "$HAM_NEEDS_REVALIDATION"
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), 'fixture\n0\nfalse');
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'merge-lease-revalidation.json'), 'utf8')).reason, 'base-not-advanced');
  assert.match(readFileSync(join(f.dir, 'required-status-checks.stderr'), 'utf8'), /HTTP 403/);
});
