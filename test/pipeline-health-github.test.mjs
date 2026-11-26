import test from 'node:test';
import assert from 'node:assert/strict';
import { listPipelineOpenPrs, readPipelineGithub } from '../src/pipeline-health-github.mjs';
import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const env = { GHA_ADAPTER_BIN: '/fixture/github-adapter', GH_TOKEN: 'ambient-marker', GH_CODEX_REVIEWER_TOKEN: 'unrelated-marker' };

test('a rundix terminal health read resolves by repo and role without process pins', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-ghx-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = join(dir, 'adapter');
  const gh = join(dir, 'gh');
  writeFileSync(adapter, `#!/bin/sh
    [ "$*" = 'token --role merge-agent --repo rundix/fixture' ] || exit 1
    [ -z "\${GH_TOKEN:-}" ] || exit 2
    printf '%s\n' '{"ok":true,"access_token":"fixture-rundix-token"}'
  `, { mode: 0o700 });
  writeFileSync(gh, `#!/bin/sh
    [ "$GH_TOKEN" = 'fixture-rundix-token' ] || exit 3
    [ "\${7}" = 'rundix/fixture' ] || exit 4
    printf '%s\n' '{"state":"MERGED"}'
  `, { mode: 0o700 });
  const result = readPipelineGithub('state', 'rundix/fixture', 17, {
    env: { ...env, PATH: `${dir}:${process.env.PATH}`, HQ_PYTHON3: 'python3', GHA_ADAPTER_BIN: adapter,
      HAM_NODE_BIN: process.execPath, GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'limits.sqlite') },
  });
  assert.deepEqual(result, { state: 'MERGED' });
});

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
test('adapter failures and truncated/malformed listings cannot become zero conflicts', () => {
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

test('bridge listings without commits preserve conflict diagnostics and use updatedAt for age', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'alr07-gh-conflicts-'));
  const now = '2026-05-25T18:00:00.000Z';
  try {
    for (const detailedProbesEnabled of [false, true]) {
      for (const updatedAt of ['2026-05-25T15:00:00.000Z', '2026-05-25T17:59:00.000Z', null, 'invalid']) {
        const snapshot = collectReviewPipelineHealth({
          rootDir, env, now: () => new Date(now),
          config: {
            hostChecksEnabled: true,
            conflictingPrChecksEnabled: detailedProbesEnabled,
            conflictingPrRepos: ['org/repo'],
            conflictingPrRepo: 'org/repo',
            conflictingPrRepoRoot: '/fixture/repo',
            conflictingPrMinSharedPathCount: 1,
            conflictingPrUnownedMaxAgeMs: 30 * 60 * 1000,
          },
          execFileSyncImpl: (bin, args) => {
            if (args.includes('--kind')) {
              assert.equal(args[args.indexOf('--kind') + 1], 'list');
              return JSON.stringify([{ number: 1, headRefOid: 'fixture-head', mergeable: 'CONFLICTING', isDraft: false, updatedAt }]);
            }
            if (bin === 'git' && args[0] === 'merge-tree') return 'fixture-tree\nsrc/shared.mjs\n\n';
            return '';
          },
        });
        assert.equal(snapshot.conflictingOpenPrs.collected, true);
        assert.equal(snapshot.conflictingOpenPrs.count, 1);
        assert.deepEqual(snapshot.conflictingOpenPrs.errors, []);
        assert.equal(snapshot.conflictingOpenPrs.prs[0].ageAnchorTimestamp, updatedAt);
        const codes = snapshot.findings.map(({ code }) => code);
        assert.ok(!codes.includes('review:conflicting_open_prs_unreadable'));
        assert.equal(codes.includes('review:conflicting_open_prs'), detailedProbesEnabled);
        assert.equal(codes.includes('review:conflicting_pr_unowned'), updatedAt === '2026-05-25T15:00:00.000Z');
      }
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('registered auth bridge runs offline against fake adapter and gh without credential output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alr07-bridge-'));
  try {
    const adapter = join(root, 'github-adapter');
    writeFileSync(adapter, `#!/bin/sh
[ "$*" = 'token --role merge-agent --repo rundix/repo' ] || exit 1
[ -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ] || exit 2
printf '%s\n' '{"ok":true,"access_token":"fixture-resolved-token"}'
`, { mode: 0o700 });
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
      const output = execFileSync('python3', [script, '--adapter-bin', adapter,
        '--kind', kind, '--number', '1', '--repo', 'rundix/repo', '--role', 'merge-agent'],
      { encoding: 'utf8', timeout: 20_000, env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'rate-limit-state.json'), PATH: `${root}:${process.env.PATH}`, GH_TOKEN: 'ambient',
        GITHUB_TOKEN: 'ambient', FIXTURE_GH_TRANSIENT: '1' } });
      assert.ok(!output.includes('token'));
      assert.ok(!output.includes('secret-marker'));
      if (kind === 'state') assert.equal(JSON.parse(output).state, 'OPEN');
      else assert.ok(Array.isArray(JSON.parse(output)));
      assert.equal(readFileSync(join(root, 'attempts'), 'utf8'), '3');
    }
    // Only this fixture's child is probed: an outer timeout must not escape gh.
    assert.throws(() => execFileSync('python3', [script,
      '--adapter-bin', adapter,
      '--kind', 'checks', '--number', '999', '--repo', 'rundix/repo', '--role', 'merge-agent'],
    { timeout: 3000, env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'rate-limit-state.json'), PATH: `${root}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }));
    const childPid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
