import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { runDerivedGenerator } from '../src/ama/derived-artifacts.mjs';
import { proveLegacyGeneratedPreservation } from '../src/ama/legacy-generated-preservation.mjs';
import { localPrimaryHistory } from './helpers/local-primary-history.mjs';

const repository = 'laceyenterprises/agent-os';
const paths = ['modules/worker-pool/failure-classes.json', 'platform/app-sdk/state-machines.json',
  'scripts/ledger-sql-baseline.json'];
const verifier = 'scripts/verify-legacy-generated-preservation.py';
const baseText = '[\n  "alpha",\n  "charlie",\n  "delta",\n  "zulu"\n]\n';
const authorText = baseText.replace('"zulu"', '"zulu",\n  "bravo"');
const finalText = baseText.replace('"alpha",', '"alpha",\n  "bravo",');

// Stand-in deployed executable. It checks exact fixture bytes and unchanged
// inputs, then speaks the producer's protocol. The real producer is replayed
// separately against the three pinned incident histories.
const script = `
import argparse, json, subprocess, sys
parser = argparse.ArgumentParser()
for name in ('repo', 'repository', 'base', 'author', 'head', 'path'):
    parser.add_argument('--' + name, required=True)
proof = vars(parser.parse_args())
repo = proof.pop('repo')
def get(commit, path):
    return subprocess.check_output(['git', '-C', repo, 'show', commit + ':' + path]).decode()
refs = [proof[key] for key in ('base', 'author', 'head')]
if len({get(ref, 'scripts/fixture-producer.py') for ref in refs}) != 1:
    sys.exit(1)
if [get(ref, proof['path']) for ref in refs] != ${JSON.stringify([baseText, authorText, finalText])}:
    sys.exit(1)
proof['version'] = 1
`;

function fixture(t, { path = paths[0], repo = repository, lostContent = false, dependencyChanged = false,
  registered = true, installed = true, final = finalText, mode,
  opaque = false, branchOnly = false, emit = 'print(json.dumps(proof))', changeResponse } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-generated-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'objects'), owner = join(root, 'owner');
  mkdirSync(source);
  mkdirSync(join(owner, 'modules/worker-pool/lib/python'), { recursive: true });
  const git = (...argv) => execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', ...argv], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture Builder', GIT_COMMITTER_NAME: 'Fixture Builder',
      GIT_AUTHOR_EMAIL: 'builder@example.invalid', GIT_COMMITTER_EMAIL: 'builder@example.invalid' },
  }).trimEnd();
  const write = (target, file, text) => {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), text);
  };
  const commit = (message, executablePath) => {
    git('add', '--all');
    if (executablePath) git('add', '--chmod=+x', '--', executablePath);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write(source, path, baseText);
  write(source, 'scripts/fixture-producer.py', '# owner input\n');
  if (lostContent) write(source, 'z-source.txt', 'base\n');
  const base = commit('Common base');
  write(source, path, authorText);
  if (lostContent) write(source, 'z-source.txt', 'author\n');
  const author = commit('Author adds an entry');
  write(source, path, opaque ? `${final}\0` : final);
  if (dependencyChanged) write(source, 'scripts/fixture-producer.py', '# edited input\n');
  if (lostContent) write(source, 'z-source.txt', 'base\n');
  if (branchOnly) write(source, verifier, `${script}\nprint(json.dumps(proof))\n`);
  const head = commit('Remediation moves the entry\n\nWorker-Class: hammer', mode ? path : undefined);
  if (installed) write(owner, verifier, `${script}\n${emit}\n`);
  if (registered) write(root, 'domains/code-pr.json', JSON.stringify({ remediationCloneReferences: { [repository]: source } }));
  const get = localPrimaryHistory({ source, base, head, changeResponse });
  return { args: { rootDir: root, repo, prNumber: 1, headSha: head, get, env: { AGENT_OS_DEPLOY_CHECKOUT: owner },
    localRepository: source }, path, source, owner, base, author, head, git };
}

test('local history preserves embedded NULs in a formatted commit payload', async t => {
  const f = fixture(t);
  const message = 'synthetic\0commit\0body';
  const execGit = execFileSync;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git' && args.includes('--format=%P%x00%B') && args.at(-1) === f.head) {
      return Buffer.from(`${f.author}\0${message}\n`);
    }
    return execGit(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const history = await f.args.get.commitHistory(`repos/${repository}/compare/${f.base}...${f.head}`);
  assert.equal(history.commits.at(-1).commit.message, message);
  assert.deepEqual(history.commits.at(-1).parents, [{ sha: f.author }]);
});

test('local history reuses SHA-256 tree reads and rebuilds hook responses', async t => {
  const source = mkdtempSync(join(tmpdir(), 'history-sha256-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--object-format=sha256');
  writeFileSync(join(source, 'entry.txt'), 'fixture\n');
  git('add', 'entry.txt');
  const tree = git('write-tree');
  let reads = 0, responses = 0;
  const execGit = execFileSync;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git' && args.includes('ls-tree')) reads++;
    return execGit(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const get = localPrimaryHistory({ source, changeResponse(_route, data) {
    if (++responses === 1) data.tree[0].path = 'mutated.txt';
    return data;
  } });
  const route = `repos/${repository}/git/trees/${tree}`;
  assert.equal((await get(route)).tree[0].path, 'mutated.txt');
  assert.equal((await get(route)).tree[0].path, 'entry.txt');
  assert.equal(responses, 2);
  assert.equal(reads, 1);
});

test('local history keeps cached bytes private across hook and caller mutations', async t => {
  let blobHooks = 0;
  const f = fixture(t, { changeResponse(route, data) {
    if (route.includes('/git/blobs/')) {
      blobHooks++;
      assert.equal(typeof data.content, 'string');
      assert.equal(Object.values(data).some(Buffer.isBuffer), false);
      // Decoding creates separate bytes; an in-place hook mutation cannot
      // change the private Git buffer used for subsequent responses.
      Buffer.from(data.content, 'base64').fill(0);
    }
    return data;
  } });
  const blob = f.git('rev-parse', `${f.base}:${f.path}`);
  const route = `repos/${repository}/git/blobs/${blob}`;
  const response = await f.args.get(route);
  const bytes = Buffer.from(response.content, 'base64');
  bytes.fill(0);
  assert.throws(() => { response.content = bytes.toString('base64'); }, TypeError);
  // A second offline repository alias bypasses the reader's API-response
  // cache while both routes still share the same pinned Git buffer.
  const again = await f.args.get(`repos/fixture/alias/git/blobs/${blob}`);
  assert.equal(blobHooks, 2);
  assert.equal(Buffer.from(again.content, 'base64').toString(), baseText);
});

const evaluate = evidence => checkPrimaryChange(evidence, evidence.headSha);

async function collect(f, { execute = true, timeoutMs, signal, beforeSpawn = () => {} } = {}) {
  const calls = [];
  const evidence = await fetchPrimaryChange({ ...f.args, signal }, {
    fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true }),
    proveLegacyGeneratedPreservationImpl: (args, history, refusal) => proveLegacyGeneratedPreservation(args, history, refusal, {
      runGeneratorImpl: async spec => {
        calls.push(spec);
        if (!execute) throw new Error('fixture disabled executor');
        return runDerivedGenerator({ ...spec, timeoutMs }, { spawnImpl(file, args, options) {
          // The real executor builds the sandbox, bounds output and owns the
          // process group. Swap the OS wrapper only for portable offline tests.
          assert.equal(options.env.GIT_ALLOW_PROTOCOL, '');
          assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
          if (process.platform === 'darwin') {
            assert.equal(file, '/usr/bin/sandbox-exec');
            assert.match(args[1], /\(deny file-write\*/);
            for (const path of spec.readOnly) assert.ok(args[1].includes(`(subpath ${JSON.stringify(path)})`));
          } else {
            assert.equal(file, 'bwrap');
            assert.ok(args.includes('--unshare-all'));
            for (const path of spec.readOnly) assert.deepEqual(args.slice(args.indexOf(path) - 1, args.indexOf(path) + 2), ['--ro-bind-try', path, path]);
          }
          assert.deepEqual(args.slice(-spec.command.length), spec.command);
          beforeSpawn();
          return spawn(spec.command[0], spec.command.slice(1), options);
        } });
      },
    }),
  });
  return { evidence, calls, answer: evaluate(evidence) };
}

test('LAC-2101 binds all three reviewed paths to collected bytes and exact producer evidence', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const path of paths) {
    const f = fixture(t, { path });
    const without = await collect(f, { execute: false });
    assert.equal(without.answer.reason, 'primary-change-reverted');
    const { evidence, calls, answer } = await collect(f);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const tuple = { version: 1, repository, base: f.base, author: f.author, head: f.head, path };
    assert.deepEqual(answer.legacyGeneratedPreservation, [tuple]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].command, ['python3', '-I', join(f.owner, verifier), '--repo', f.source,
      '--repository', repository, '--base', f.base, '--author', f.author, '--head', f.head, '--path', path]);
    assert.deepEqual(calls[0].readOnly, [join(f.source, '.git'), join(f.owner, 'scripts'),
      join(f.owner, 'modules/worker-pool/lib/python')]);
    for (const [key, value] of Object.entries({ version: 2, repository: repository.toUpperCase(),
      base: f.author, author: f.head, head: f.base, path: `${path}.other` })) {
      const stale = structuredClone(evidence);
      stale.legacyGeneratedProofs[0].tuple[key] = value;
      assert.equal(evaluate(stale).reason, 'primary-change-reverted', key);
    }
    const wrongBlob = structuredClone(evidence);
    wrongBlob.finalFiles.find(file => file.filename === path).sha = 'a'.repeat(40);
    assert.equal(evaluate(wrongBlob).reason, 'primary-change-reverted');
  }
});

test('LAC-2101 preserves unrelated author content even after accepting a whole-blob proof', async t => {
  t.mock.method(console, 'warn', () => {});
  const { evidence, calls, answer } = await collect(fixture(t, { lostContent: true }));
  assert.equal(calls.length, 1);
  assert.equal(evidence.legacyGeneratedProofs.length, 1);
  assert.equal(answer.path, 'z-source.txt');
  assert.equal(answer.reason, 'primary-change-reverted');
});

test('LAC-2101 declines unsupported evidence before running a producer', async t => {
  const cases = {
    'wrong repository': { repo: 'another/agent-os' },
    'noncanonical repository': { repo: repository.toUpperCase() },
    'wrong path': { path: 'docs/other.json' },
    'missing local registration': { registered: false },
    'missing deployed verifier with a branch lookalike': { installed: false, branchOnly: true },
    'executable artifact': { mode: true },
    'opaque artifact': { opaque: true },
    'base restored with no modified final entry': { final: baseText },
  };
  for (const [name, options] of Object.entries(cases)) await t.test(name, async t => {
    t.mock.method(console, 'warn', () => {});
    const { calls, answer } = await collect(fixture(t, options));
    assert.equal(answer.ok, false);
    assert.equal(calls.length, 0);
  });
});

test('LAC-2101 requires a complete modified-file diff and a readable immutable object store', async t => {
  t.mock.method(console, 'warn', () => {});
  const runGeneratorImpl = t.mock.fn(() => { throw new Error('invalid evidence reached the executor'); });
  const failExecutor = { runGeneratorImpl };
  const f = fixture(t);
  const initial = await collect(f, { execute: false });
  const { evidence, answer } = initial;
  for (const status of ['removed', 'renamed']) {
    const structural = structuredClone(evidence);
    structural.finalFiles.find(file => file.filename === f.path).status = status;
    assert.equal(await proveLegacyGeneratedPreservation(f.args, structural, answer, failExecutor), null);
  }
  const truncated = structuredClone(evidence);
  const file = truncated.finalFiles.find(file => file.filename === f.path);
  file.patch = file.patch.split('\n').filter(line => !line.startsWith('+')).join('\n');
  assert.equal(evaluate(truncated).reason, 'primary-change-unknown');
  const unrelated = f.git('commit-tree', `${f.author}^{tree}`, '-p', f.base, '-m', 'Independent author history');
  assert.equal(await proveLegacyGeneratedPreservation(f.args, { ...evidence, primaryHead: unrelated }, answer, failExecutor), null);
  const unavailable = { ...f.args, get: Object.assign(() => assert.fail('unexpected route'),
    { regularDataFile: () => { throw new Error('read unavailable'); } }) };
  assert.equal(await proveLegacyGeneratedPreservation(unavailable, evidence, answer, failExecutor), null);
  const emptyStore = join(f.owner, 'empty-store');
  execFileSync('git', ['init', '--bare', '-q', emptyStore], { timeout: 5000 });
  writeFileSync(join(f.args.rootDir, 'domains/code-pr.json'),
    JSON.stringify({ remediationCloneReferences: { [repository]: emptyStore } }));
  assert.equal(await proveLegacyGeneratedPreservation(f.args, evidence, answer, failExecutor), null);
  assert.equal(runGeneratorImpl.mock.callCount(), 0);
});

test('LAC-2101 rejects partial and same-length corrupted data from the history reader', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const kind of ['truncated', 'corrupt']) {
    const f = fixture(t, { changeResponse(route, data) {
      if (!route.endsWith(`/git/blobs/${blob}`)) return data;
      const bytes = Buffer.from(data.content, 'base64');
      const content = kind === 'truncated' ? bytes.subarray(1) : Buffer.from(bytes.toString().replace('charlie', 'charliE'));
      return { ...data, content: content.toString('base64') };
    } });
    const blob = f.git('rev-parse', `${f.base}:${f.path}`);
    const { calls, answer } = await collect(f);
    assert.equal(answer.ok, false);
    assert.equal(calls.length, 0);
  }
});

test('LAC-2101 rejects producer errors and any output outside the exact version-1 tuple', async t => {
  const cases = {
    'changed producer input': { dependencyChanged: true },
    'changed authored bytes': { final: finalText.replace('"bravo"', '"other"') },
    'old producer': { emit: "proof['version'] = 0\nprint(json.dumps(proof))" },
    'wrong path': { emit: "proof['path'] += '.other'\nprint(json.dumps(proof))" },
    'wrong repository': { emit: "proof['repository'] = 'another/agent-os'\nprint(json.dumps(proof))" },
    'wrong anchor': { emit: "proof['head'] = proof['base']\nprint(json.dumps(proof))" },
    'extra field': { emit: "proof['ok'] = True\nprint(json.dumps(proof))" },
    'duplicate key': { emit: "print('{\"version\":0,' + json.dumps(proof)[1:])" },
    'malformed output': { emit: "print('not JSON')" },
    'oversized output': { emit: "print('x' * 8192)" },
    'valid tuple and nonzero exit': { emit: 'print(json.dumps(proof))\nsys.exit(1)' },
  };
  for (const [name, options] of Object.entries(cases)) await t.test(name, async t => {
    t.mock.method(console, 'warn', () => {});
    const { evidence, calls, answer } = await collect(fixture(t, options));
    assert.equal(calls.length, 1, JSON.stringify(answer));
    assert.equal(answer.reason, 'primary-change-reverted');
    assert.equal(evidence.legacyGeneratedProofs, undefined);
  });
});

test('LAC-2101 declines a verifier timeout and propagates collector cancellation', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(t, { emit: 'import time\ntime.sleep(30)\nprint(json.dumps(proof))' });
  const timed = await collect(f, { timeoutMs: 80 });
  assert.equal(timed.calls.length, 1);
  assert.equal(timed.answer.reason, 'primary-change-reverted');
  const abort = new AbortController();
  const canceled = await collect(f, { signal: abort.signal, beforeSpawn: () => abort.abort() });
  assert.equal(canceled.calls.length, 1);
  assert.equal(canceled.answer.reason, 'history-read-failed');
});
