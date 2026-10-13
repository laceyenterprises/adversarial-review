import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/hammer-head-context.mjs', import.meta.url));
const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');

function fixture(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-head-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const callsFile = join(root, 'calls.json');
  writeFileSync(callsFile, '[]');
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const scenario = ${JSON.stringify(scenario)};
const callsFile = ${JSON.stringify(callsFile)};
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
const attempt = calls.filter(call => JSON.stringify(call) === JSON.stringify(args)).length + 1;
calls.push(args);
writeFileSync(callsFile, JSON.stringify(calls));
const fail = message => { process.stderr.write(message); process.exit(1); };
if (scenario === 'recover' && attempt === 1) fail('TLS handshake timeout');
if (scenario === 'exhaust') fail('HTTP 503 Service Unavailable');
if (scenario === 'permanent') fail('HTTP 403 Forbidden');
if (scenario === 'malformed') { process.stdout.write('{'); process.exit(0); }
if (args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
    nodes: [{ __typename: 'HeadRefForcePushedEvent', actor: { __typename: scenario === 'rebase-user' ? 'User' : 'Bot', login: 'lacey-codex-agent[bot]' },
      beforeCommit: { oid: 'reviewed' }, afterCommit: { oid: 'head' } }], pageInfo: { hasNextPage: false, endCursor: null }
  } } } } }));
} else if (args[1] === 'repos/fixture/repo/issues/1/comments?per_page=100&page=1') {
  process.stdout.write(JSON.stringify([{ user: { login: 'the-hammer-lacey[bot]' },
    body: 'HAM-Base-Head: reviewed\\nHAM-Validated-Head: earlier' }]));
} else if (args[0] === 'pr') {
  if (args.join(' ') !== 'pr view https://github.com/fixture/repo/pull/1 --json baseRefName --jq .baseRefName') fail('unexpected PR call');
  process.stdout.write('release\\n');
} else if (args[1] === 'repos/fixture/repo/commits/release') {
  process.stdout.write(JSON.stringify({ sha: 'base' }));
} else if (['repos/fixture/repo/compare/base...head', 'repos/fixture/repo/compare/reviewed...head'].includes(args[1])) {
  process.stdout.write(JSON.stringify({ status: scenario.startsWith('rebase') ? 'diverged' : 'ahead', total_commits: 1, commits: [{ sha: 'head',
    author: { login: 'lacey-codex-agent[bot]' }, committer: { login: 'web-flow' },
    commit: { verification: { verified: scenario !== 'spoof', reason: 'valid' } } }] }));
} else fail('unexpected API call');
`, { mode: 0o755 });
  return {
    run: (baseArgs = ['--pr', 'https://github.com/fixture/repo/pull/1'], env = {}) => exec(process.execPath,
      [cli, 'fixture/repo', 'reviewed', 'head', ...baseArgs], {
        env: { ...process.env, HAM_BASE_HEAD: '', HAM_PR_NUMBER: '', HAM_ROOT_DIR: root, PATH: `${root}:${process.env.PATH}`, ...env }, timeout: 15000,
      }),
    root,
    calls: () => JSON.parse(readFileSync(callsFile, 'utf8')),
  };
}

test('head context retries transient PR-base and every ancestry read without live GitHub', async t => {
  const f = fixture(t, 'recover');
  const { stdout } = await f.run();
  assert.equal(JSON.parse(stdout).verified, true);
  assert.equal(f.calls().length, 8);
});

test('head context retains the explicit-base interface', async t => {
  const f = fixture(t, 'success');
  assert.equal(JSON.parse((await f.run(['release'])).stdout).verified, true);
  assert.equal(f.calls().length, 3);
  assert.ok(f.calls().every(args => args[0] === 'api'));
});

for (const [scenario, count] of [['exhaust', 3], ['permanent', 1], ['malformed', 1]]) {
  test(`head context fails closed for ${scenario} with a bounded subprocess count`, async t => {
    const f = fixture(t, scenario);
    await assert.rejects(f.run(['release']), error => error.code === 1 && !error.stdout);
    assert.equal(f.calls().length, count);
  });
}

test('head context distinguishes spoofed fleet ancestry from read failures', async t => {
  const f = fixture(t, 'spoof');
  await assert.rejects(f.run(), error => error.code === 65 && !error.stdout);
  assert.equal(f.calls().length, 4);
});


test('HAMCLOSE-01 reviewed starting base bypasses irrelevant signature and ancestry reads', async t => {
  const f = fixture(t, 'spoof');
  const result = JSON.parse((await f.run(undefined, { HAM_BASE_HEAD: 'reviewed', HAM_PR_NUMBER: '1' })).stdout);
  assert.equal(result.proof, 'reviewed-starting-base');
  assert.equal(f.calls().length, 0);
});

test('HAMCLOSE-01 earlier App-attested starting base requires only authenticated comments', async t => {
  const f = fixture(t, 'spoof');
  const result = JSON.parse((await f.run(undefined, { HAM_BASE_HEAD: 'earlier', HAM_PR_NUMBER: '1' })).stdout);
  assert.equal(result.proof, 'hammer-app-attestation-chain');
  assert.equal(f.calls().length, 1);
  assert.match(f.calls()[0][1], /issues\/1\/comments/);
});

test('head context derives the comment PR number from its explicit URL without HAM_PR_NUMBER', async t => {
  const f = fixture(t, 'spoof');
  const result = JSON.parse((await f.run(undefined, { HAM_BASE_HEAD: 'earlier', HAM_PR_NUMBER: '' })).stdout);
  assert.equal(result.proof, 'hammer-app-attestation-chain');
  assert.equal(f.calls().length, 1);
  assert.match(f.calls()[0][1], /issues\/1\/comments/);
});

test('head context refuses a missing comment PR number before making an API request', async t => {
  const f = fixture(t, 'success');
  await assert.rejects(f.run(['release'], { HAM_BASE_HEAD: 'earlier', HAM_PR_NUMBER: '' }), /hammer PR number is missing/);
  assert.equal(f.calls().length, 0);
});

test('HAMCLOSE-05 completed daemon round exits successfully instead of handing off', async t => {
  const f = fixture(t, 'spoof');
  const dir = join(f.root, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const roundFile = join(dir, 'fixture__repo-pr-1-round.json');
  writeFileSync(roundFile, JSON.stringify({ repo: 'fixture/repo', prNumber: 1,
    status: 'completed', remediationPlan: { rounds: [{ state: 'completed',
      startHeadSha: 'reviewed', resultingHeadSha: 'head' }] } }));
  writeFileSync(join(dir, 'fixture__repo-pr-1-broken.json'), '{');
  mkdirSync(join(dir, 'fixture__repo-pr-1-unreadable.json'));
  const { stdout } = await f.run(undefined, { HAM_BASE_HEAD: 'head', HAM_ROOT_DIR: f.root });
  assert.equal(JSON.parse(stdout).proof, 'completed-remediation-round-chain');
  for (const overrides of [{ repo: 'fixture/other' }, { prNumber: 2 }, { status: 'in_progress' }]) {
    writeFileSync(roundFile, JSON.stringify({ repo: 'fixture/repo', prNumber: 1,
      status: 'completed', remediationPlan: { rounds: [{ state: 'completed',
        startHeadSha: 'reviewed', resultingHeadSha: 'head' }] }, ...overrides }));
    await assert.rejects(f.run(undefined, { HAM_BASE_HEAD: 'head', HAM_ROOT_DIR: f.root }), error => error.code === 65);
  }
  writeFileSync(roundFile, '{');
  await assert.rejects(f.run(undefined, { HAM_BASE_HEAD: 'head', HAM_ROOT_DIR: f.root }), error => error.code === 65);
});

test('dispatched prompt exports the daemon root used by completed-round verification', async t => {
  const f = fixture(t, 'spoof');
  const dir = join(f.root, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture__repo-pr-1-round.json'), JSON.stringify({ repo: 'fixture/repo', prNumber: 1,
    status: 'completed', remediationPlan: { rounds: [{ state: 'completed',
      startHeadSha: 'reviewed', resultingHeadSha: 'head' }] } }));
  const prompt = composeCloserPrompt({ rootDir: f.root, hqRoot: join(f.root, 'hq'), hqOwnerUser: 'fixture',
    templateBody: template });
  const exportLine = prompt.split('\n').find(line => line.startsWith('export HAM_ROOT_DIR='));
  assert.ok(exportLine);
  const { stdout } = await exec('bash', ['-c', `${exportLine}\nexec "$HAM_TEST_NODE" "$HAM_TEST_CLI" fixture/repo reviewed head --pr https://github.com/fixture/repo/pull/1`], {
    env: { ...process.env, HAM_ROOT_DIR: '', HAM_BASE_HEAD: 'head', HAM_PR_NUMBER: '',
      HAM_TEST_NODE: process.execPath, HAM_TEST_CLI: cli, PATH: `${f.root}:${process.env.PATH}` }, timeout: 15000,
  });
  assert.equal(JSON.parse(stdout).proof, 'completed-remediation-round-chain');
});

for (const scenario of ['rebase-bot', 'rebase-user']) {
  test(`HAMCLOSE-06 helper: ${scenario}`, async t => {
    const f = fixture(t, scenario);
    const dir = join(f.root, 'data', 'follow-up-jobs', 'completed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fixture__repo-pr-1-round.json'), JSON.stringify({ repo: 'fixture/repo', prNumber: 1,
      status: 'completed', remediationPlan: { rounds: [{ state: 'completed', startHeadSha: 'reviewed', resultingHeadSha: 'head' }] } }));
    const run = () => f.run(undefined, { HAM_BASE_HEAD: 'head' });
    if (scenario === 'rebase-bot') assert.deepEqual(JSON.parse((await run()).stdout).linkKinds, ['fleet-force-push']);
    else await assert.rejects(run(), error => error.code === 65 && error.stderr === 'hammer starting base or responsibility range could not be proven\n');
  });
}
