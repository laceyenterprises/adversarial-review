import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { PUBLICATION_CHECK_TIMEOUT_MS, selectRemediationPublicationChecks } from '../src/remediation-publication-checks.mjs';

const execAsync = promisify(execFile);
const simulation = 'test/finalization-simulator.test.mjs';
const latency = 'test/watcher-closure-latency.test.mjs';

test('ARFINALCHECK-01 selects simulation inputs and migration changes, deduplicated and bounded', () => {
  for (const path of ['src/finalization/ledger-fold.mjs', 'src/finalization/eligibility.mjs',
    'src/finalization/executor.mjs', 'src/finalization/ledger-events.mjs',
    'src/load-aware-timeout.mjs', 'test/sim/baseline.json', 'test/sim/scenarios.json', simulation]) {
    assert.deepEqual(selectRemediationPublicationChecks([path]), [simulation], path);
  }
  for (const path of ['migrations/new.sql', latency, 'test/helpers/posted-review-profile.mjs']) {
    assert.deepEqual(selectRemediationPublicationChecks([path]), [latency], path);
  }
  assert.deepEqual(selectRemediationPublicationChecks([
    'src/finalization/ledger-fold.mjs', 'test/sim/baseline.json', 'migrations/new.sql', 'migrations/other.sql',
  ]), [simulation, latency]);
  assert.deepEqual(selectRemediationPublicationChecks(['docs/changes/example.md', 'src/config-loader.mjs',
    'src/follow-up-remediation.mjs', 'test/finalization-ledger-fold.test.mjs',
    'test/sim/README.md', 'src/finalization/README.md', 'migrations/README.md']), []);
});

function fixture(t, changedPaths, baseFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arfinalcheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  mkdirSync(work);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args,
    { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  };
  git('init', '--bare', join(root, 'remote.git'));
  git('init', '-b', 'main');
  git('config', 'core.hooksPath', '/dev/null');
  write('package.json', '{"name":"adversarial-review","type":"module"}');
  // Most cases use a minimal runner to keep Git-boundary regressions fast.
  // The integration cases below also exercise the production runner.
  write('test/run-tests.mjs', `import { pathToFileURL } from 'node:url';
for (const file of process.argv.slice(2)) await import(pathToFileURL(process.cwd() + '/' + file));`);
  for (const path of [simulation, latency]) {
    write(path, `import { appendFileSync } from 'node:fs';
appendFileSync('.git/fixtures-ran', ${JSON.stringify(`${path}\n`)});
if (process.env.ARFINALCHECK_FAIL === ${JSON.stringify(path)}) throw Error('synthetic fixture failure');`);
  }
  for (const [path, content] of Object.entries(baseFiles)) write(path, content);
  git('add', 'package.json', 'test', ...Object.keys(baseFiles)); git('commit', '-m', 'Base fixtures');
  git('remote', 'add', 'origin', join(root, 'remote.git')); git('push', 'origin', 'main');
  git('checkout', '-b', 'topic');
  for (const path of changedPaths) write(path, 'input\n');
  git('add', ...changedPaths); git('commit', '-m', 'Original PR inputs');
  const previousHead = git('rev-parse', 'HEAD');
  git('push', 'origin', 'topic');
  // The remediation itself changes only docs. Selection must retain PR inputs.
  write('docs/fix.md', 'remediation\n');
  git('add', 'docs/fix.md'); git('commit', '-m', 'Final remediation');
  const calls = [];
  const publish = { workspaceDir: work, baseBranch: 'main', branch: 'topic', previousHead, env, pushCommand: 'git',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return execAsync(command, args, options);
    } };
  const ran = () => existsSync(join(work, '.git/fixtures-ran'))
    ? readFileSync(join(work, '.git/fixtures-ran'), 'utf8').trim().split('\n') : [];
  return { work, write, git, publish, ran, calls };
}

// Keep the actual runner and its preloads intact. Only its selected test body
// is synthetic; source/dependency links support the production preload imports.
function realRunnerFixture(t, fail) {
  const f = fixture(t, ['migrations/additive.sql']);
  // A nested CLI must start outside the parent node:test worker context.
  delete f.publish.env.NODE_TEST_CONTEXT;
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  f.write('test/run-tests.mjs', readFileSync(join(repoRoot, 'test/run-tests.mjs'), 'utf8'));
  mkdirSync(join(f.work, 'test/adapters'));
  for (const path of ['test/helpers', 'src', 'node_modules']) {
    symlinkSync(join(repoRoot, path), join(f.work, path), 'dir');
  }
  f.write(latency, `import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
test('production runner sandbox and selected fixture', () => {
  assert.ok(process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT);
  assert.notEqual(process.cwd(), ${JSON.stringify(f.work)});
  assert.equal(existsSync('.git'), false);
  assert.ok(process.env.HOME.startsWith(process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT));
  assert.equal(process.env.TMPDIR, join(process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT, 't0'));
  ${fail ? "assert.fail('publication assertion diagnostic');" : ''}
});
`);
  f.git('add', 'test', 'src', 'node_modules');
  f.git('commit', '-m', 'Use production test runner');
  const execute = f.publish.execFileImpl;
  f.publish.execFileImpl = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (command === process.execPath) f.runnerResult = result;
    return result;
  };
  return f;
}

test('relative workspace publishes through the production runner and sandbox', async t => {
  const f = realRunnerFixture(t, false);
  f.publish.workspaceDir = relative(process.cwd(), f.work);
  const result = await publishRemediation(f.publish);
  const validation = f.calls.find(call => call.command === process.execPath);
  assert.equal(validation.args[0], join(f.work, 'test/run-tests.mjs'));
  assert.equal(validation.options.cwd, f.work);
  assert.match(String(f.runnerResult.stdout), /production runner sandbox and selected fixture/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], result.headSha);
});

test('production runner failure preserves stderr and stdout diagnostics without pushing', async t => {
  const f = realRunnerFixture(t, true);
  await assert.rejects(publishRemediation(f.publish), error => {
    assert.equal(error.code, 'remediation-publication-check-failed');
    assert.match(String(error.cause.stderr), /Test sandbox cleanup:/);
    assert.match(String(error.cause.stdout), /publication assertion diagnostic/);
    assert.match(error.message, /Test sandbox cleanup:/);
    assert.match(error.message, /publication assertion diagnostic/);
    return true;
  });
  assert.equal(f.calls.some(call => call.args.includes('push')), false);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.publish.previousHead);
});

for (const [paths, expected] of [
  [['src/finalization/ledger-fold.mjs'], [simulation]],
  [['migrations/additive.sql'], [latency]],
  [['src/finalization/ledger-fold.mjs', 'migrations/additive.sql'], [simulation, latency]],
  [['src/unrelated.mjs'], []],
]) {
  test(`publication executes selected fixtures before push: ${paths.join(', ')}`, async t => {
    const f = fixture(t, paths);
    const result = await publishRemediation(f.publish);
    assert.deepEqual(f.ran(), expected);
    const validationIndex = f.calls.findIndex(call => call.command === process.execPath);
    const pushIndex = f.calls.findIndex(call => call.args.includes('push'));
    if (expected.length) {
      assert.ok(validationIndex >= 0 && validationIndex < pushIndex);
      assert.deepEqual(f.calls[validationIndex].args.slice(1), expected);
      assert.equal(f.calls[validationIndex].options.timeout, PUBLICATION_CHECK_TIMEOUT_MS);
    } else assert.equal(validationIndex, -1);
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], result.headSha);
  });
}

for (const failed of [simulation, latency]) {
  test(`failed fixture refuses publication and preserves remote: ${failed}`, async t => {
    const f = fixture(t, ['src/finalization/ledger-fold.mjs', 'migrations/additive.sql']);
    f.publish.env.ARFINALCHECK_FAIL = failed;
    await assert.rejects(publishRemediation(f.publish), { code: 'remediation-publication-check-failed' });
    assert.ok(f.ran().includes(failed));
    assert.equal(f.calls.some(call => call.args.includes('push')), false);
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.publish.previousHead);
  });
}

test('dirty simulation inputs cannot validate a different tree than the published commit', async t => {
  const f = fixture(t, ['src/finalization/ledger-fold.mjs']);
  f.write('src/finalization/ledger-fold.mjs', 'uncommitted\n');
  await assert.rejects(publishRemediation(f.publish), { code: 'remediation-publication-dirty' });
  assert.deepEqual(f.ran(), []);
  assert.equal(f.calls.some(call => call.args.includes('push')), false);
});

test('fixture timeout refuses publication without retry or push', async t => {
  const f = fixture(t, ['migrations/additive.sql']);
  const execute = f.publish.execFileImpl;
  let attempts = 0;
  f.publish.execFileImpl = async (command, args, options) => {
    if (command === process.execPath) {
      attempts++;
      assert.equal(options.timeout, 180_000);
      assert.equal(options.killSignal, 'SIGTERM');
      throw Object.assign(new Error('synthetic timeout'), { killed: true, signal: 'SIGTERM' });
    }
    return execute(command, args, options);
  };
  await assert.rejects(publishRemediation(f.publish), {
    code: 'remediation-publication-check-failed',
    message: `Pre-publication fixtures failed: ${latency}\nsynthetic timeout`,
  });
  assert.equal(attempts, 1);
  assert.equal(f.calls.some(call => call.args.includes('push')), false);
});

test('uncommitted manifest edits cannot disable selected fixtures', async t => {
  const f = fixture(t, ['migrations/additive.sql']);
  f.write('package.json', '{"name":"another-repository","type":"module"}');
  await assert.rejects(publishRemediation(f.publish), { code: 'remediation-publication-dirty' });
  assert.deepEqual(f.ran(), []);
  assert.equal(f.calls.some(call => call.args.includes('push')), false);
});

test('other repositories retain their validation policy even with matching paths', async t => {
  const f = fixture(t, ['migrations/additive.sql']);
  f.write('package.json', '{"name":"another-repository","type":"module"}');
  f.git('add', 'package.json'); f.git('commit', '-m', 'Different repository');
  await publishRemediation(f.publish);
  assert.deepEqual(f.ran(), []);
  assert.equal(f.calls.some(call => call.command === process.execPath), false);
});

test('head movement during fixtures is refused before push', async t => {
  const f = fixture(t, ['migrations/additive.sql']);
  const execute = f.publish.execFileImpl;
  f.publish.execFileImpl = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (command === process.execPath) {
      f.write('docs/late.md', 'concurrent change\n');
      f.git('add', 'docs/late.md'); f.git('commit', '-m', 'Concurrent local head');
    }
    return result;
  };
  await assert.rejects(publishRemediation(f.publish), { code: 'remediation-publication-head-moved' });
  assert.deepEqual(f.ran(), [latency]);
  assert.equal(f.calls.some(call => call.args.includes('push')), false);
});

test('moving a simulation input outside the selected directory still runs the oracle', async t => {
  const f = fixture(t, ['src/unrelated.mjs'], { 'src/finalization/moved.mjs': 'export const value = 1;\n' });
  f.git('mv', 'src/finalization/moved.mjs', 'src/moved.mjs');
  f.git('commit', '-m', 'Move a simulation input');
  await publishRemediation(f.publish);
  assert.deepEqual(f.ran(), [simulation]);
});
