import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';
import { createGithubOwnerTokenSelector } from '../src/github-owner-token.mjs';
import { OWNER_AUTH_HOLD, selectRemediationReadRoute, selectRemediationPushRoute } from '../src/remediation-owner-auth.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { fetchReviewerTokenFromBroker } from '../src/reviewer-broker-refresh.mjs';
import { requeueClaimedFollowUpJobBeforeSpawn } from '../src/remediation-claimed-requeue.mjs';
import { getFollowUpJobDir } from '../src/follow-up-jobs.mjs';

const execAsync = promisify(execFile);
const ALT = 'alternate-org/project';
const HOME = 'home-org/project';
const SHA = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const log = { info() {}, warn() {}, log() {} };

test('declared follow-up reader preserves legacy source-token revocation', async () => {
  const minted = [];
  const tokens = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org',
    mint: async ({ role, owner }) => {
      minted.push({ role, owner });
      return { token: 'alternate-read-token' };
    } });
  const route = await selectRemediationReadRoute({ repo: ALT, reviewerModel: 'claude', env: {}, tokens });
  assert.equal(route.ghEnv.GH_TOKEN, 'alternate-read-token');
  assert.deepEqual(minted, [{ role: 'claude-reviewer', owner: 'alternate-org' }]);
  const legacy = { target: `repos/${ALT}`, role: 'claude-reviewer', env: {} };
  await assert.rejects(tokens.select(legacy), { code: 'github-owner-token-unavailable' });
  assert.throws(() => tokens.sync(legacy), { code: 'github-owner-token-unavailable' });
  assert.equal(await tokens.select({ ...legacy, token: 'current-source-token' }), 'alternate-read-token');
});

function fixture(t, { refuse = false, ownerPin = '22' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediation-owner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, GH_TOKEN: 'home-default', GITHUB_TOKEN: 'home-default',
    CLAUDE_WORKER_GH_TOKEN: 'home-claude', ADVERSARIAL_REMEDIATION_PUSH_TOKEN: 'home-push',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'home-helper',
    HQ_REPO_ROOT: rootDir, OAUTH_BROKER_URL: 'http://broker.invalid' };
  const requests = [];
  const tokens = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org', mint: async ({ role, owner }) => {
    requests.push({ role, owner });
    if (refuse) throw new Error('broker refused fixture owner');
    return { token: 'alternate-reviewer' };
  } });
  const helper = join(rootDir, 'modules/worker-pool/lib/hq-gh.sh');
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, `
_hq_token_broker_auth_enabled() { return 0; }
_hq_token_broker_env_prefix() { printf TEST; }
_hq_prepare_token_broker_env() {
  case "$1" in
    CODEX_WORKER_GH_TOKEN) TEST_PROVIDER=github-app-codex-agent ;;
    MERGE_AGENT_GH_TOKEN) TEST_PROVIDER=github-app-merge-agent ;;
    *) return 1 ;;
  esac
  TEST_OWNER="\${HQ_GITHUB_TARGET_OWNER}"
  TEST_OWNER_EXPECTED_INSTALLATION_ID='${ownerPin}'
  TEST_EXPECTED_APP_ID=11
  OAUTH_BROKER_SHARED_SECRET_FILE=/nonexistent-fixture-bearer
}
`);
  return { rootDir, env, requests, tokens };
}

function header(env, repo) {
  const index = Object.keys(env).findLast(key => /^GIT_CONFIG_KEY_\d+$/.test(key)
    && env[key] === `http.https://github.com/${repo}.git.extraHeader`).split('_').at(-1);
  return Buffer.from(env[`GIT_CONFIG_VALUE_${index}`].split(' ').at(-1), 'base64').toString();
}

function assertIsolated(env, repo, token) {
  assert.equal(header(env, repo), `x-access-token:${token}`);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.HQ_WORKER_PUSH_CREDENTIAL_PREFLIGHT, '0');
  assert.doesNotMatch(JSON.stringify(env), /home-default|home-push|home-helper|home-claude/);
}

function metadata(repo) {
  return JSON.stringify({ base: { ref: 'main' }, head: { ref: 'topic', repo: { full_name: repo } } });
}

for (const repo of [HOME, ALT]) {
  test(`workspace clone and fetch use the ${repo} read route`, async t => {
    const { rootDir, env, requests, tokens } = fixture(t);
    const seen = [];
    const execFileImpl = async (command, args, options) => {
      if (command === 'gh') {
        assert.equal(options.env.GH_TOKEN, repo === ALT ? 'alternate-reviewer' : 'home-default');
        return { stdout: metadata(repo) };
      }
      if (args[0] === 'clone') {
        seen.push({ command: 'clone', args, env: options.env });
        mkdirSync(join(args.at(-1), '.git'), { recursive: true });
      }
      if (args.includes('fetch')) seen.push({ command: 'fetch', args, env: options.env });
      return { stdout: '' };
    };
    await prepareWorkspaceForJob({ rootDir, job: { repo, prNumber: 4, jobId: 'fixture-pr', reviewerModel: 'claude' },
      execFileImpl, env, log, selectReadRoute: options => selectRemediationReadRoute({ ...options, tokens }) });
    assert.deepEqual(seen.map(({ command }) => command), ['clone', 'fetch']);
    if (repo === HOME) {
      for (const entry of seen) assert.equal(entry.env.GH_TOKEN, 'home-push');
      assert.ok(seen[1].args.includes('origin'));
      assert.deepEqual(requests, []);
    } else {
      for (const entry of seen) {
        assertIsolated(entry.env, repo, 'alternate-reviewer');
        assert.ok(entry.args.includes(`https://github.com/${repo}.git`));
      }
      assert.deepEqual(requests, [{ role: 'claude-reviewer', owner: 'alternate-org' }]);
    }
  });
}

for (const refusal of ['missing-reader', 'broker-refused', 'github-refused', 'fetch-refused']) {
  test(`workspace route ${refusal} holds without retrying via the home route`, async t => {
    const { rootDir, env, tokens, requests } = fixture(t, { refuse: refusal === 'broker-refused' });
    let clones = 0, fetches = 0;
    const execFileImpl = async (command, args, options) => {
      if (command === 'gh') return { stdout: metadata(ALT) };
      if (args[0] === 'clone') {
        assertIsolated(options.env, ALT, 'alternate-reviewer');
        clones += 1;
        if (refusal === 'github-refused') throw new Error('remote: Repository not found.');
        mkdirSync(join(args.at(-1), '.git'), { recursive: true });
      } else if (args.includes('fetch')) {
        assertIsolated(options.env, ALT, 'alternate-reviewer');
        fetches += 1;
        throw new Error('fatal: Authentication failed');
      }
      return { stdout: '' };
    };
    await assert.rejects(prepareWorkspaceForJob({ rootDir, job: { repo: ALT, prNumber: 4, jobId: 'fixture-pr',
      reviewerModel: refusal === 'missing-reader' ? null : 'claude' },
    execFileImpl, env, log, selectReadRoute: options => selectRemediationReadRoute({ ...options, tokens }) }),
    { code: OWNER_AUTH_HOLD, owner: 'alternate-org', capability: /^contents:read/ });
    assert.equal(clones, ['github-refused', 'fetch-refused'].includes(refusal) ? 1 : 0);
    assert.equal(fetches, refusal === 'fetch-refused' ? 1 : 0);
    assert.equal(requests.length, refusal === 'missing-reader' ? 0 : 1);
  });
}

test('Git resolves the authorization header only for the exact GitHub repository', async t => {
  const { rootDir, env, tokens } = fixture(t);
  const route = await selectRemediationReadRoute({ repo: ALT, reviewerModel: 'claude', env, tokens });
  const lookup = url => execAsync('git', ['config', '--get-urlmatch', 'http.extraHeader', url],
    { cwd: rootDir, env: route.gitEnv });
  const { stdout } = await lookup(`${route.url}/info/refs`);
  assert.equal(Buffer.from(stdout.trim().split(' ').at(-1), 'base64').toString(), 'x-access-token:alternate-reviewer');
  for (const url of [`https://github.com/${HOME}.git`, 'https://other.invalid/alternate-org/project.git']) {
    assert.equal((await lookup(url)).stdout.trim(), '');
  }
});

// Each refusal names the failed check; the live broker shape (a permissions
// digest with no permissions map) holds as missing permission evidence.
const PUSH_HOLD_REASONS = {
  'missing-pin': 'owner route config incomplete or mismatched',
  refused: 'mint refused (HTTP 403)',
  'wrong-owner': 'owner mismatch',
  unrouted: 'unrouted (no owner echo)',
  'home-installation': 'installation mismatch',
  'no-permission-map': 'broker reported no token permissions',
  'read-only': 'missing contents:write',
  'no-workflows': 'missing workflows:write',
};

for (const mode of ['ordinary', 'workflow', ...Object.keys(PUSH_HOLD_REASONS)]) {
  test(`publication preserves the exact ${mode} capability and lease`, async t => {
    const { rootDir, env, tokens } = fixture(t, { ownerPin: mode === 'missing-pin' ? '' : '22' });
    const workflow = ['workflow', 'no-workflows'].includes(mode);
    const provider = workflow ? 'github-app-merge-agent' : 'github-app-codex-agent';
    const pushes = [], brokerRequests = [];
    const mint = options => fetchReviewerTokenFromBroker({ ...options,
      readFileImpl: () => 'fake-bearer', fetchImpl: async url => {
        brokerRequests.push(url);
        if (mode === 'refused') return { ok: false, status: 403 };
        const owner = mode === 'unrouted' ? undefined : mode === 'wrong-owner' ? 'home-org' : 'alternate-org';
        const permissions = mode === 'no-permission-map' ? undefined
          : { contents: mode === 'read-only' ? 'read' : 'write', ...(mode === 'workflow' && { workflows: 'write' }) };
        return { ok: true, json: async () => ({ provider, access_token: 'alternate-publisher',
          metadata: { owner, app_id: 11, installation_id: mode === 'home-installation' ? 33 : 22,
            permissions_digest: '0123456789abcdef', permissions } }) };
      },
    });
    const execFileImpl = async (command, args, options) => {
      if (command === 'bash') return execAsync(command, args, options);
      if (command === 'gh') return { stdout: metadata(ALT) };
      if (args.includes('fetch')) {
        assertIsolated(options.env, ALT, 'alternate-reviewer');
        assert.ok(args.includes(`https://github.com/${ALT}.git`));
      }
      if (args.includes('push')) pushes.push({ args, env: options.env });
      if (args.includes('rev-parse')) return { stdout: args.some(arg => arg.startsWith('refs/remotes')) ? BASE : CANDIDATE };
      if (args.includes('merge-base')) return { stdout: BASE };
      if (args.includes('diff')) return { stdout: workflow ? '.github/workflows/fixture.yml\0' : 'src/fixture.js\0' };
      return { stdout: '' };
    };
    const publish = publishRemediation({ workspaceDir: rootDir, repo: ALT, prNumber: 4, branch: 'topic', baseBranch: 'main',
      previousHead: SHA, env, execFileImpl, pushCommand: 'fixture-git-safe', workerClass: 'codex', reviewerModel: 'claude',
      ownerTokens: tokens, selectPushRoute: options => selectRemediationPushRoute({ ...options, mint }) });
    if (['ordinary', 'workflow'].includes(mode)) {
      assert.equal((await publish).headSha, CANDIDATE);
      assert.equal(pushes.length, 1);
      assertIsolated(pushes[0].env, ALT, 'alternate-publisher');
      assert.deepEqual(pushes[0].args.slice(-3), [`--force-with-lease=refs/heads/topic:${SHA}`,
        `https://github.com/${ALT}.git`, `${CANDIDATE}:refs/heads/topic`]);
    } else {
      const error = await publish.then(() => assert.fail('publication must hold'), caught => caught);
      assert.equal(error.code, OWNER_AUTH_HOLD);
      assert.equal(error.owner, 'alternate-org');
      assert.equal(error.capability, `contents:write${workflow ? ' + workflows:write' : ''} (codex)`);
      assert.equal(error.reason, `owner publication route: ${PUSH_HOLD_REASONS[mode]}`);
      assert.doesNotMatch(JSON.stringify({ message: error.message, reason: error.reason }), /alternate-publisher|fake-bearer/);
      assert.equal(pushes.length, 0);
    }
    assert.deepEqual(brokerRequests, mode === 'missing-pin' ? [] :
      [`http://broker.invalid/token?provider=${provider}&owner=alternate-org`]);
  });
}

// REMEDIATIONOWNERROUTE-01 Phase 0: the remediation-publication mint is owner
// routed and pinned to the owner's installation, never the home installation.
test('second-owner publication mint carries the owner and its installation pin', async t => {
  const { env, tokens } = fixture(t);
  const mints = [], urls = [];
  const mint = options => {
    mints.push({ role: options.role, owner: options.owner,
      provider: options.env.OAUTH_BROKER_REMEDIATION_PUBLICATION_PROVIDER,
      expectedAppId: options.env.OAUTH_BROKER_REMEDIATION_PUBLICATION_EXPECTED_APP_ID,
      expectedInstallations: options.env.OAUTH_BROKER_REMEDIATION_PUBLICATION_EXPECTED_INSTALLATIONS });
    return fetchReviewerTokenFromBroker({ ...options, readFileImpl: () => 'fake-bearer', fetchImpl: async url => {
      urls.push(url);
      return { ok: true, json: async () => ({ provider: 'github-app-codex-agent', access_token: 'alternate-publisher',
        metadata: { owner: 'alternate-org', app_id: 11, installation_id: 22, permissions: { contents: 'write' } } }) };
    } });
  };
  const execFileImpl = (command, args, options) => execAsync(command, args, options);
  const route = await selectRemediationPushRoute({ repo: ALT, workerClass: 'codex', env, execFileImpl, tokens, mint });
  assert.equal(route.provider, 'github-app-codex-agent');
  assertIsolated(route.gitEnv, ALT, 'alternate-publisher');
  assert.deepEqual(mints, [{ role: 'remediation-publication', owner: 'alternate-org', provider: 'github-app-codex-agent',
    expectedAppId: '11', expectedInstallations: 'alternate-org:22' }]);
  assert.deepEqual(urls, ['http://broker.invalid/token?provider=github-app-codex-agent&owner=alternate-org']);
  assert.equal(await selectRemediationPushRoute({ repo: HOME, workerClass: 'codex', env, execFileImpl, tokens,
    mint: () => assert.fail('home-owner publication must not mint an owner route') }), null);
});

test('pre-spawn owner hold keeps pending custody without spending a round', t => {
  const { rootDir } = fixture(t);
  const heldAt = '2026-01-01T00:00:00.000Z';
  const inProgress = getFollowUpJobDir(rootDir, 'inProgress');
  mkdirSync(inProgress, { recursive: true });
  mkdirSync(getFollowUpJobDir(rootDir, 'pending'), { recursive: true });
  const jobPath = join(inProgress, 'fixture.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'fixture', status: 'in_progress', remediationPlan: {
    currentRound: 2, rounds: [{ round: 1, state: 'completed' }, { round: 2, state: 'claimed' }],
  } }));
  const hold = { code: OWNER_AUTH_HOLD, owner: 'alternate-org', capability: 'contents:write (codex)', recordedAt: heldAt };
  const result = requeueClaimedFollowUpJobBeforeSpawn({ rootDir, jobPath, requeuedAt: heldAt, ownerAuthHold: hold });
  const saved = JSON.parse(readFileSync(result.jobPath, 'utf8'));
  assert.equal(saved.status, 'pending');
  assert.equal(saved.remediationPlan.currentRound, 1);
  assert.equal(saved.remediationPlan.retryAfter, '2026-01-01T00:05:00.000Z');
  assert.deepEqual(saved.ownerAuthHold, hold);
});
