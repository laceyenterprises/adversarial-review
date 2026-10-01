import test from 'node:test';
import assert from 'node:assert/strict';
import { listPipelineOpenPrs } from '../src/pipeline-health-github.mjs';
import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const env = { GHA_ADAPTER_BIN: '/fixture/github-adapter', GH_TOKEN: 'ambient-marker', GH_CODEX_REVIEWER_TOKEN: 'unrelated-marker',
  OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID: '123', OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID: '456' };
test('Python collector retry contracts run offline', () => {
  execFileSync('python3', [new URL('./github-read-retry.test.py', import.meta.url).pathname], {
    timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
});
test('listing binds broker identity and strips ambient tokens with bounded execution', () => {
  const rows = listPipelineOpenPrs('org/repo', { env, execFileSyncImpl: (bin, args, opts) => {
    assert.equal(args[args.indexOf('--adapter-bin') + 1], env.GHA_ADAPTER_BIN);
    assert.equal(args[args.indexOf('--role') + 1], 'merge-agent');
    assert.equal(opts.env.GH_TOKEN, undefined);
    assert.equal(opts.env.GITHUB_TOKEN, undefined);
    assert.equal(opts.env.GH_CODEX_REVIEWER_TOKEN, undefined);
    assert.equal(opts.timeout, 20000);
    return JSON.stringify([]);
  } });
  assert.deepEqual(rows, []);
});
test('missing identity, adapter failures and truncated/malformed listings cannot become zero conflicts', () => {
  assert.throws(() => listPipelineOpenPrs('org/repo', { env: { GHA_ADAPTER_BIN: '/fixture' } }), /identity-unconfigured/);
  for (const output of ['', '{}', JSON.stringify(Array(100).fill({})),
    JSON.stringify([{ number: 1, isDraft: false, mergeable: 'UNKNOWN' }])]) {
    assert.throws(() => listPipelineOpenPrs('org/repo', { env, execFileSyncImpl: () => output }), /inconclusive/);
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'alr07-gh-'));
  try {
    for (const failing of [false, true]) {
      const snapshot = collectReviewPipelineHealth({ rootDir, env,
        config: { conflictingPrChecksEnabled: true, conflictingPrRepos: ['org/repo'] },
        execFileSyncImpl: () => {
          if (failing) { const e = new Error('secret-marker'); e.stderr = 'secret-marker'; throw e; }
          return '[]';
        },
      });
      assert.equal(snapshot.conflictingOpenPrs.collected, !failing);
      assert.equal(snapshot.findings.some((f) => f.code === 'review:conflicting_open_prs_unreadable'), failing);
      assert.ok(!JSON.stringify(snapshot).includes('secret-marker'));
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('registered auth bridge runs offline against fake adapter and gh without credential output', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'alr07-bridge-'));
  try {
    const moduleDir = join(root, 'adapter', 'src', 'agent_os_github_adapter');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(root, 'adapter', 'bin'), { recursive: true });
    writeFileSync(join(moduleDir, '__init__.py'), '');
    writeFileSync(join(moduleDir, 'auth.py'), `
class AuthPolicy:
    @staticmethod
    def from_env(**kwargs):
        assert kwargs['mode'] == 'broker'
        assert kwargs['allow_ambient'] is False
        assert kwargs['selector'] == 'merge-agent'
        return kwargs
class AuthResolver:
    def __init__(self, policy): pass
    def resolve(self):
        return type('Auth', (), {'token': 'fixture-resolved-token'})()
`);
    writeFileSync(join(root, 'gh'), `#!/usr/bin/env python3
import os, sys
assert os.environ['GH_TOKEN'] == 'fixture-resolved-token'
assert 'GITHUB_TOKEN' not in os.environ
if sys.argv[2] == 'list' and 'commits' in sys.argv[sys.argv.index('--json') + 1].split(','):
    print('GraphQL: nested commit authors exceed the 500000-node limit', file=sys.stderr)
    sys.exit(1)
if os.environ.get('FIXTURE_GH_TRANSIENT'):
    import pathlib
    counter = pathlib.Path(__file__).with_name('attempts')
    attempts = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(attempts + 1))
    if attempts < 2:
        print('TLS handshake timeout secret-marker', file=sys.stderr)
        sys.exit(1)
if '999' in sys.argv:
    import pathlib, time
    pathlib.Path(__file__).with_name('child.pid').write_text(str(os.getpid()))
    time.sleep(60)
if sys.argv[2] == 'checks':
    print('[{"name":"CI","state":"FAILURE","bucket":"fail"}]')
    sys.exit(1)
if sys.argv[2] == 'view':
    print('{"state":"OPEN"}')
    sys.exit(0)
print('[]')
`, { mode: 0o700 });
    const script = new URL('../src/adapters/health/github-read.py', import.meta.url).pathname;
    const { readFileSync } = await import('node:fs');
    for (const kind of ['list', 'checks', 'state']) {
      rmSync(join(root, 'attempts'), { force: true });
      const output = execFileSync('python3', [script, '--adapter-bin', join(root, 'adapter', 'bin', 'github-adapter'),
        '--kind', kind, '--number', '1', '--repo', 'org/repo', '--role', 'merge-agent',
        '--provider', 'github-app-merge-agent', '--app-id', '123', '--installation-id', '456'],
      { encoding: 'utf8', timeout: 20_000, env: { PATH: `${root}:${process.env.PATH}`, GH_TOKEN: 'ambient',
        GITHUB_TOKEN: 'ambient', FIXTURE_GH_TRANSIENT: '1' } });
      assert.ok(!output.includes('token'));
      assert.ok(!output.includes('secret-marker'));
      if (kind === 'state') assert.equal(JSON.parse(output).state, 'OPEN');
      else assert.ok(Array.isArray(JSON.parse(output)));
      assert.equal(readFileSync(join(root, 'attempts'), 'utf8'), '3');
    }
    // Only this fixture's child is probed: an outer timeout must not escape gh.
    assert.throws(() => execFileSync('python3', [script,
      '--adapter-bin', join(root, 'adapter', 'bin', 'github-adapter'),
      '--kind', 'checks', '--number', '999', '--repo', 'org/repo', '--role', 'merge-agent',
      '--provider', 'github-app-merge-agent', '--app-id', '123', '--installation-id', '456'],
    { timeout: 3000, env: { PATH: `${root}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }));
    const childPid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
