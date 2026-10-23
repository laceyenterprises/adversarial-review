import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactSandbox, proveDerivedArtifacts, runArtifactBuild } from '../src/ama/derived-artifacts.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';

// Execute only this file's synthetic commands under the clean build environment.
// OS sandbox availability is tested separately; no production bypass exists.
const runFixtureBuild = async spec => execFileSync('/bin/sh', spec.args.slice(-2), {
  cwd: spec.cwd, env: spec.env, timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
});
const proveFixture = (args, evidence) => proveDerivedArtifacts(args, evidence, { runBuildImpl: runFixtureBuild });

function fixture(t, { command = 'npm pack --ignore-scripts --offline', declared = true,
  tamper = false, finalCommand = command, symlink = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'derived-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'sdk');
  mkdirSync(cwd);
  const env = { ...process.env, NODE_OPTIONS: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    npm_config_ignore_scripts: 'true', npm_config_offline: 'true', npm_config_cache: join(root, '.npm') };
  const gitBytes = (...args) => execFileSync('git', args, { cwd: root, env, timeout: 5000 });
  const git = (...args) => gitBytes(...args).toString('utf8').trimEnd();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'Fixture base');
  const mergeBase = git('rev-parse', 'HEAD');
  const archive = 'sdk/fixture-sdk-1.0.0.tgz';
  const key = 'build:artifact:fixture-sdk-1.0.0.tgz';
  const manifest = value => JSON.stringify({ name: 'fixture-sdk', version: '1.0.0', files: ['source.txt'],
    scripts: { ...(declared ? { [key]: value } : {}),
      prepack: 'node -e "require(\'fs\').writeFileSync(\'source.txt\', \'unexpected lifecycle script\')"' } });
  const pack = () => execFileSync('npm', ['pack', '--ignore-scripts', '--offline'],
    { cwd, env, timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
  writeFileSync(join(cwd, 'package.json'), manifest(command));
  writeFileSync(join(cwd, 'source.txt'), 'Author source\n');
  pack();
  git('add', 'sdk'); git('commit', '-q', '-m', 'Fixture author');
  const primaryHead = git('rev-parse', 'HEAD');
  const primaryBlob = git('rev-parse', `HEAD:${archive}`);
  writeFileSync(join(cwd, 'source.txt'), 'Repaired author source\n');
  writeFileSync(join(cwd, 'package.json'), manifest(finalCommand));
  pack();
  if (tamper) writeFileSync(join(root, archive), Buffer.concat([readFileSync(join(root, archive)), Buffer.from('hand-edited\0archive')]));
  if (symlink) git('update-index', '--add', '--cacheinfo', '120000',
    git('hash-object', '-w', '--stdin'), 'host-link');
  git('add', 'sdk'); git('commit', '-q', '-m', 'Fixture repair\n\nWorker-Class: hammer');
  const headSha = git('rev-parse', 'HEAD');
  const finalBlob = git('rev-parse', `HEAD:${archive}`);
  const source = value => ({ filename: 'sdk/source.txt', status: 'added', additions: 1, deletions: 0,
    patch: `@@ -0,0 +1 @@\n+${value}` });
  const evidence = { headSha, primaryHead, mergeBase, hasHammerCommits: true,
    ciCost: { headSha, ok: true },
    primaryFiles: [source('Author source'), { filename: archive, status: 'added', sha: primaryBlob }],
    finalFiles: [source('Repaired author source'), { filename: archive, status: 'added', sha: finalBlob }] };
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path.includes('/git/trees/')) return { truncated: false,
      tree: git('ls-tree', path.split('/git/trees/')[1]).split('\n').filter(Boolean).map(line => {
        const [, mode, type, sha, path] = /^(\d+) (\S+) (\S+)\t(.+)$/.exec(line);
        return { mode, type, sha, path };
      }) };
    if (path.includes('/git/blobs/')) {
      const bytes = gitBytes('cat-file', 'blob', path.split('/git/blobs/')[1]);
      return { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
    }
    if (path.endsWith('/pulls/1')) return { head: { sha: headSha }, base: { sha: mergeBase } };
    if (path.includes('/compare/')) {
      const head = path.split('...')[1];
      return { merge_base_commit: { sha: mergeBase }, status: 'ahead', total_commits: head === headSha ? 2 : 1,
        commits: [{ sha: primaryHead, parents: [{ sha: mergeBase }], commit: { message: 'Fixture author' } },
          ...(head === headSha ? [{ sha: headSha, parents: [{ sha: primaryHead }], commit: { message: 'Fixture repair\n\nWorker-Class: hammer' } }] : [])],
        files: head === headSha ? evidence.finalFiles : evidence.primaryFiles };
    }
    throw new Error(`unexpected fixture read: ${path}`);
  };
  return { root, archive, key, evidence, calls, args: { repo: 'fixture/repo', prNumber: 1, headSha, get } };
}

test('declared npm archive rebuilt from repaired sources passes the shared collector and predicate', async t => {
  const f = fixture(t);
  const evidence = await fetchPrimaryChange(f.args, { fetchCiCostImpl: async () => f.evidence.ciCost,
    proveDerivedArtifactsImpl: proveFixture });
  assert.equal(evidence.derivedArtifacts?.length, 1);
  assert.equal(evidence.derivedArtifacts[0].comparison, 'git-blob-sha1');
  assert.equal(checkPrimaryChange(evidence, f.args.headSha).ok, true);
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-unknown');
  assert.equal(readFileSync(join(f.root, 'sdk/source.txt'), 'utf8'), 'Repaired author source\n');
  // The proof never allows a source reversal or a stale/misbound artifact.
  const reverted = { ...evidence, finalFiles: evidence.finalFiles.slice(1) };
  assert.equal(checkPrimaryChange(reverted, f.args.headSha).reason, 'primary-change-reverted');
  for (const field of ['headSha', 'primaryHead', 'primaryBlob', 'blob', 'path', 'comparison']) {
    const bad = { ...evidence, derivedArtifacts: [{ ...evidence.derivedArtifacts[0], [field]: 'wrong' }] };
    assert.equal(checkPrimaryChange(bad, f.args.headSha).reason, 'primary-change-unknown', field);
  }
});

test('npm lifecycle hooks stay disabled even when the recorded command omits ignore-scripts', async t => {
  const f = fixture(t, { command: 'npm pack --offline' });
  assert.equal((await proveFixture(f.args, f.evidence)).length, 1);
});

for (const [name, options] of [
  ['hand-edited archive', { tamper: true }],
  ['undeclared binary', { declared: false }],
  ['failed build', { command: 'exit 1' }],
  ['no-op build cannot reuse the committed archive', { command: 'true' }],
  ['closer changes the recorded command', { finalCommand: 'true' }],
  ['symlink in source tree', { symlink: true }],
]) test(`${name} keeps primary-change-unknown`, async t => {
  const f = fixture(t, options);
  const derivedArtifacts = await proveFixture(f.args, f.evidence);
  assert.deepEqual(derivedArtifacts, []);
  assert.equal(checkPrimaryChange({ ...f.evidence, derivedArtifacts }, f.args.headSha).reason, 'primary-change-unknown');
});

test('native sandbox rebuilds archives and denies network and host file writes', async t => {
  const f = fixture(t);
  const spec = artifactSandbox(f.root, f.root, 'true');
  const probe = spawnSync(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, encoding: 'utf8', timeout: 5000 });
  if (probe.error?.code === 'ENOENT' || /sandbox_apply: Operation not permitted|No permissions to create new namespace|Creating new namespace failed: Operation not permitted/.test(probe.stderr || '')) {
    assert.deepEqual(await proveDerivedArtifacts(f.args, f.evidence), []);
    t.skip(`OS sandbox unavailable: ${probe.error?.message || probe.stderr.trim()}`);
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  assert.equal((await proveDerivedArtifacts(f.args, f.evidence)).length, 1);
  const sentinel = join(tmpdir(), `derived-host-${process.pid}`);
  t.after(() => rmSync(sentinel, { force: true }));
  for (const command of [
    `node -e 'require("fs").writeFileSync(${JSON.stringify(sentinel)}, "bad")'`,
    'node -e \'require("net").connect({host:"127.0.0.1",port:9}).on("error",()=>process.exit(1))\'',
    'test -n "$GITHUB_TOKEN"',
  ]) {
    const denied = fixture(t, { command });
    assert.deepEqual(await proveDerivedArtifacts(denied.args, denied.evidence), []);
  }
  assert.throws(() => readFileSync(sentinel), { code: 'ENOENT' });
});

test('sandbox specification isolates Linux and strips inherited secrets', () => {
  const spec = artifactSandbox('/tmp/fixture', '/tmp/fixture/sdk', 'npm pack', 'linux');
  assert.ok(spec.args.includes('--unshare-all'));
  assert.equal(spec.env.npm_config_ignore_scripts, 'true');
  assert.equal(spec.env.GITHUB_TOKEN, undefined);
  assert.throws(() => artifactSandbox('/tmp/fixture', '/tmp/fixture', 'true', 'unsupported'));
});

test('build cancellation kills background descendants before returning', async t => {
  const root = mkdtempSync(join(tmpdir(), 'derived-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = join(root, 'descendant.pid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(runArtifactBuild({ file: '/bin/sh', args: ['-c', 'sleep 60 & echo $! > descendant.pid; wait'],
      cwd: root, env: { PATH: '/usr/bin:/bin' } }, controller.signal), /failed or exceeded/);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { clearTimeout(timer); }
});

test('incomplete trees, corrupt blobs and cancellation fail closed', async t => {
  const f = fixture(t);
  for (const get of [
    async () => ({ truncated: true, tree: [] }),
    async path => path.includes('/git/blobs/')
      ? { encoding: 'base64', content: 'eA==', size: 1 } : f.args.get(path),
  ]) assert.deepEqual(await proveFixture({ ...f.args, get }, f.evidence), []);
  assert.deepEqual(await proveFixture({ ...f.args, signal: AbortSignal.abort() }, f.evidence), []);
});
