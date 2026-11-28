import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';
import { createGithubOwnerTokenSelector } from '../src/github-owner-token.mjs';
import { OWNER_AUTH_HOLD, ROLE_TOKEN_VARS, selectRemediationReadRoute, selectRemediationPushRoute } from '../src/remediation-owner-auth.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { requeueClaimedFollowUpJobBeforeSpawn } from '../src/remediation-claimed-requeue.mjs';
import { getFollowUpJobDir, readFollowUpJob } from '../src/follow-up-jobs.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { captureReviewerBodyAfterPost } from '../src/review-body-capture.mjs';
import { openReviewStateDb } from '../src/review-state.mjs';

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
    mint: async ({ role, repo }) => {
      minted.push({ role, repo });
      return { token: 'alternate-read-token' };
    } });
  const route = await selectRemediationReadRoute({ repo: ALT, reviewerModel: 'claude', env: {}, tokens });
  assert.equal(route.ghEnv.GH_TOKEN, 'alternate-read-token');
  assert.deepEqual(minted, [{ role: 'claude-reviewer', repo: ALT }]);
  const legacy = { target: `repos/${ALT}`, role: 'claude-reviewer', env: {} };
  await assert.rejects(tokens.select(legacy), { code: 'github-owner-token-unavailable' });
  assert.throws(() => tokens.sync(legacy), { code: 'github-owner-token-unavailable' });
  assert.equal(await tokens.select({ ...legacy, token: 'current-source-token' }), 'alternate-read-token');
});

function fixture(t, { refuse = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediation-owner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, GH_TOKEN: 'home-default', GITHUB_TOKEN: 'home-default',
    CLAUDE_WORKER_GH_TOKEN: 'home-claude', ADVERSARIAL_REMEDIATION_PUSH_TOKEN: 'home-push',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'home-helper',
    HQ_REPO_ROOT: rootDir, OAUTH_BROKER_URL: 'http://broker.invalid' };
  const requests = [];
  const tokens = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org', mint: async ({ role, repo }) => {
    requests.push({ role, repo });
    if (refuse) throw new Error('broker refused fixture owner');
    return { token: 'alternate-reviewer' };
  } });
  return { rootDir, env, requests, tokens };
}

function publicationFixture(t, { legacyPins = false, brokerEnabled = true, configuredRole, configuredProvider, brokerProvider,
  brokerOwner = 'alternate-org', grantOwner,
  responseRepo, installationId = '22', permissions = { contents: 'write' }, expiresAt = '2099-01-01T00:00:00Z',
  installationSource, appId = '11', workflow = false, disableEscalation = false, refused = false } = {}) {
  const { rootDir, env, tokens } = fixture(t);
  const escalated = workflow && !disableEscalation;
  const provider = escalated ? 'github-app-merge-agent' : 'github-app-codex-agent';
  const response = { access_token: 'alternate-publisher', provider: brokerProvider ?? provider, expires_at: expiresAt,
    metadata: { installation_owner: brokerOwner, installation_id: installationId, app_id: appId, repo: responseRepo, owner: grantOwner,
      permissions_digest: '0123456789abcdef', permissions, credential_source: installationSource } };
  env.FIXTURE_BROKER_REPLY = JSON.stringify(response);
  env.FIXTURE_PROVIDER = configuredProvider ?? provider;
  env.FIXTURE_REFUSED = refused ? '1' : '0';
  env.FIXTURE_MINT_RECEIPT = join(rootDir, 'mint.json');
  env.HQ_GITHUB_TARGET_REPO = HOME;
  env.HQ_GITHUB_TARGET_OWNER = 'home-org';
  if (disableEscalation) env.ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT = 'false';
  const lib = join(rootDir, 'modules/worker-pool/lib');
  const dispatch = join(lib, 'python/cwp_dispatch');
  const adapter = join(rootDir, 'modules/github-adapter/src/agent_os_github_adapter');
  mkdirSync(dispatch, { recursive: true });
  mkdirSync(adapter, { recursive: true });
  writeFileSync(join(lib, 'hq-gh.sh'), `
HQ_GH_LIB_DIR="\${BASH_SOURCE[0]%/*}"
hq_gh_require_local_publication() { [[ -z "\${AGENT_OS_FEDERATION_ORDER_ID:-}" ]]; }
hq_require_python3_runtime() { command -v python3; }
_hq_token_broker_auth_enabled() { [[ '${brokerEnabled}' == true && "$HQ_GITHUB_TARGET_REPO" == '${ALT}' && "$HQ_GITHUB_TARGET_OWNER" == alternate-org ]]; }
_hq_token_broker_env_prefix() { printf TEST; }
_hq_token_broker_cfg_slug() {
  ${configuredRole ? `printf '%s' '${configuredRole}'; return` : ''}
  case "$1" in
    CODEX_WORKER_GH_TOKEN) printf codex ;;
    CLAUDE_WORKER_GH_TOKEN) printf claude ;;
    GEMINI_WORKER_GH_TOKEN) printf gemini ;;
    GROK_WORKER_GH_TOKEN) printf grok-agent ;;
    MERGE_AGENT_GH_TOKEN) printf merge-agent ;;
    *) return 1 ;;
  esac
}
_hq_prepare_token_broker_env() {
  TEST_PROVIDER=${provider}
  export OAUTH_BROKER_SHARED_SECRET_FILE=/nonexistent-fixture-bearer
  ${legacyPins ? 'TEST_OWNER=home-org; TEST_EXPECTED_APP_ID=99; TEST_OWNER_EXPECTED_INSTALLATION_ID=88' : ''}
}
`);
  writeFileSync(join(dispatch, 'broker_fetch_gate.py'), `
from contextlib import contextmanager

class BrokerFetchGateTimeout(Exception):
    pass

@contextmanager
def broker_fetch_gate(*, label):
    assert label == 'github-app:${escalated ? 'merge-agent' : 'codex'}'
    yield
`);
  writeFileSync(join(adapter, 'auth.py'), `
import json
import os
from pathlib import Path
from types import SimpleNamespace

class AuthResolutionError(Exception):
    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code

class UrlLibBrokerClient:
    def fetch_token(self, *, provider, repo, owner):
        assert not os.getenv('GH_TOKEN') and not os.getenv('ADVERSARIAL_REMEDIATION_PUSH_TOKEN')
        assert os.environ['OAUTH_BROKER_SHARED_SECRET_FILE'] == '/nonexistent-fixture-bearer'
        Path(os.environ['FIXTURE_MINT_RECEIPT']).write_text(json.dumps([provider, repo, owner]))
        if os.environ['FIXTURE_REFUSED'] == '1':
            raise AuthResolutionError('broker returned HTTP 403')
        return json.loads(os.environ['FIXTURE_BROKER_REPLY'])

def role_identity(role):
    provider = os.environ['FIXTURE_PROVIDER']
    assert role == '${escalated ? 'merge-agent' : 'codex'}'
    return SimpleNamespace(provider=provider)

def github_token_for_repo(repo, role, *, broker_client, use_cache):
    assert use_cache is False
    provider = role_identity(role).provider
    owner = repo.split('/')[0]
    body = broker_client.fetch_token(provider=provider, repo=repo, owner=owner)
    meta = body['metadata']
    installation_owner = meta.get('installation_owner')
    if not isinstance(installation_owner, str) or installation_owner.strip().lower() != owner:
        raise AuthResolutionError('wrong owner', code='github-installation-owner-mismatch')
    if meta.get('app_id') != '11':
        raise AuthResolutionError('wrong App', code='github-app-id-mismatch')
    # The production resolver validates provider equality and omits grant metadata.
    if body['provider'] != provider:
        raise AuthResolutionError('broker provider mismatch')
    return SimpleNamespace(token=body['access_token'], metadata={
        'provider': body['provider'], 'repo': repo, 'installation_owner': installation_owner.strip().lower(), 'app_id': meta['app_id'],
        'installation_id': meta['installation_id'], 'expires_at': body['expires_at'],
    })
`);
  const mintReceipt = () => existsSync(env.FIXTURE_MINT_RECEIPT)
    ? JSON.parse(readFileSync(env.FIXTURE_MINT_RECEIPT, 'utf8')) : null;
  return { rootDir, env, tokens, mintReceipt, provider };
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

test('a recovered Claude pass with the deployed model reaches the owner workspace reader', async t => {
  const { rootDir, env, requests, tokens } = fixture(t);
  const queued = queueFollowUpForRecoveredPostedReview({
    rootDir,
    row: {
      repo: ALT, pr_number: 19, head_sha: SHA,
      reviewer_model: 'claude-opus-5-5', reviewer_class: 'claude',
      metadata_json: JSON.stringify({ reviewerModel: 'claude', branch: 'topic', builderTag: '[codex]' }),
      body_md: '## Blocking issues\n- Fix the failure.\n\n## Verdict\nRequest changes\n',
    },
    reviewPostedAt: '2026-11-21T00:00:00Z',
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(queued.queued, true);
  const job = readFollowUpJob(queued.jobPath);
  assert.equal(job.reviewerModel, 'claude-opus-5-5');
  const seen = [];
  await prepareWorkspaceForJob({
    rootDir, job, env, log,
    selectReadRoute: options => selectRemediationReadRoute({ ...options, tokens }),
    execFileImpl: async (command, args, options) => {
      if (command === 'gh') return { stdout: metadata(ALT) };
      if (args[0] === 'clone') mkdirSync(join(args.at(-1), '.git'), { recursive: true });
      if (args[0] === 'clone' || args.includes('fetch')) {
        assertIsolated(options.env, ALT, 'alternate-reviewer');
        seen.push(args[0] === 'clone' ? 'clone' : 'fetch');
      }
      return { stdout: '' };
    },
  });
  assert.deepEqual(seen, ['clone', 'fetch']);
  assert.equal(job.reviewerRole, 'claude-reviewer');
  assert.deepEqual(requests, [{ role: 'claude-reviewer', repo: ALT }]);
});

for (const [family, model] of [
  ['claude', 'claude-opus-5-5'], ['codex', 'fixture-codex-model'],
  ['gemini', 'fixture-gemini-model'], ['grok', 'fixture-grok-model'],
]) {
  test(`the ${family} posted artifact binds its declared App role through recovered job creation`, async t => {
    const { rootDir, env, requests, tokens } = fixture(t);
    const key = { repo: ALT, prNumber: 19, attemptNumber: 1, passKind: 'first-pass' };
    beginReviewerPass(rootDir, { ...key, reviewerClass: family, headSha: SHA });
    await captureReviewerBodyAfterPost(rootDir, {
      ...key, reviewerModel: family, reviewerHeadSha: SHA,
      botTokenEnv: `GH_${family.toUpperCase()}_REVIEWER_TOKEN`,
      reviewBody: '## Blocking issues\n- Fix the failure.\n\n## Verdict\nRequest changes\n',
      verdict: 'request-changes', execution: { model },
      requireGitHubArtifact: true, knownGitHubArtifact: { id: 123, commitId: SHA }, log,
    });
    const db = openReviewStateDb(rootDir);
    let row;
    try {
      row = db.prepare('SELECT * FROM reviewer_passes WHERE repo = ? AND pr_number = ?').get(ALT, key.prNumber);
    } finally {
      db.close();
    }
    const queued = queueFollowUpForRecoveredPostedReview({ rootDir, row,
      reviewPostedAt: '2026-11-21T00:00:00Z', resolveHandoffConfigImpl: () => ({ enabled: false }) });
    assert.equal(queued.queued, true);
    const job = readFollowUpJob(queued.jobPath);
    const route = await selectRemediationReadRoute({ ...job, env, tokens });
    assert.equal(job.reviewerModel, model);
    assert.equal(job.reviewerRole, `${family}-reviewer`);
    assertIsolated(route.gitEnv, ALT, 'alternate-reviewer');
    assert.deepEqual(requests, [{ role: `${family}-reviewer`, repo: ALT }]);
  });
}

test('legacy job evidence is exact and an absent identity holds', async t => {
  const { env, tokens, requests } = fixture(t);
  for (const [reviewerModel, role] of [
    ['claude-opus-5-5', 'claude-reviewer'], ['claude', 'claude-reviewer'], ['claude-code', 'claude-reviewer'],
    ['codex', 'codex-reviewer'], ['gemini', 'gemini-reviewer'], ['grok', 'grok-reviewer'],
  ]) {
    const route = await selectRemediationReadRoute({ repo: ALT, reviewerModel, env, tokens });
    assert.equal(route.capability, `contents:read (${role})`);
  }
  assert.deepEqual(requests.map(({ role }) => role), ['claude-reviewer', 'codex-reviewer', 'gemini-reviewer', 'grok-reviewer']);
});

test('unknown and contradictory job identities hold before token selection', async t => {
  const { env, tokens, requests } = fixture(t);
  for (const identity of [
    {},
    { reviewerModel: 'claude-opus-5-5-unknown' },
    { reviewerModel: 'gpt-unknown' },
    { reviewerRole: 'unknown-reviewer', reviewerModel: 'claude' },
    { reviewerRole: null, reviewerModel: 'claude-opus-5-5' },
    { reviewerRole: 'codex-reviewer', reviewerModel: 'claude-opus-5-5' },
    { reviewerRole: 'claude-reviewer', reviewerModel: 'codex' },
    { reviewerRole: '' },
  ]) {
    await assert.rejects(selectRemediationReadRoute({ repo: ALT, ...identity, env, tokens }),
      { code: OWNER_AUTH_HOLD, reason: 'no declared reader role' });
  }
  assert.deepEqual(requests, []);
});

test('recovery holds when legacy pass evidence is unknown or contradictory', async t => {
  const { rootDir, env, tokens, requests } = fixture(t);
  for (const [prNumber, reviewerModel, reviewerClass, routedModel] of [
    [20, 'claude-unregistered', 'claude', undefined],
    [21, 'claude-opus-5-5', 'grok', undefined],
    [22, 'claude-opus-5-5', 'claude', 'gemini'],
  ]) {
    const queued = queueFollowUpForRecoveredPostedReview({
      rootDir,
      row: {
        repo: ALT, pr_number: prNumber, head_sha: SHA,
        reviewer_model: reviewerModel, reviewer_class: reviewerClass,
        metadata_json: JSON.stringify({ reviewerModel: routedModel }),
        body_md: '## Blocking issues\n- Fix the failure.\n\n## Verdict\nRequest changes\n',
      },
      reviewPostedAt: '2026-11-21T00:00:00Z', resolveHandoffConfigImpl: () => ({ enabled: false }),
    });
    assert.equal(queued.queued, true);
    const job = readFollowUpJob(queued.jobPath);
    await assert.rejects(selectRemediationReadRoute({ ...job, env, tokens }),
      { code: OWNER_AUTH_HOLD, reason: 'no declared reader role' });
  }
  assert.deepEqual(requests, []);
});

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
      assert.deepEqual(requests, [{ role: 'claude-reviewer', repo: ALT }]);
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

for (const [mode, scenario] of Object.entries({
  'current-resolver': {},
  'mixed-case': { repo: 'Alternate-Org/Project', responseRepo: 'Alternate-Org/PROJECT',
    brokerOwner: 'Alternate-Org', grantOwner: 'ALTERNATE-ORG' },
  'legacy-exported-pins': { legacyPins: true },
  workflow: { workflow: true, permissions: { contents: 'write', workflows: 'write' } },
  'workflow-capable-harness-with-escalation-disabled': {
    workflow: true, disableEscalation: true, permissions: { contents: 'write', workflows: 'write' },
  },
  refused: { refused: true, hold: 'mint refused (HTTP 403)' },
  'wrong-owner': { brokerOwner: 'home-org', hold: 'installation owner mismatch' },
  'missing-owner': { brokerOwner: null, hold: 'installation owner mismatch' },
  'wrong-grant-owner': { grantOwner: 'home-org', hold: 'installation owner mismatch' },
  'invalid-grant-owner': { grantOwner: 42, hold: 'installation owner mismatch' },
  'wrong-provider': { brokerProvider: 'github-app-claude-agent', hold: 'provider mismatch' },
  'wrong-configured-provider': { configuredProvider: 'github-app-claude-agent', hold: 'provider mismatch', noMint: true },
  'wrong-configured-role': { configuredRole: 'merge-agent', hold: 'owner route config incomplete or mismatched', noMint: true },
  'wrong-app': { appId: '99', hold: 'App id mismatch' },
  'wrong-repository': { responseRepo: 'alternate-org/other-project', hold: 'repository mismatch' },
  'invalid-grant-repository': { responseRepo: null, hold: 'repository mismatch' },
  'broker-disabled': { brokerEnabled: false, hold: 'owner route config incomplete or mismatched', noMint: true },
  'missing-installation': { installationId: '', hold: 'installation identity missing' },
  'pat-fallback': { installationSource: 'github_pat_fallback', hold: 'broker returned a non-installation credential' },
  'no-permission-map': { permissions: null, hold: 'broker reported no token permissions' },
  'read-only': { permissions: { contents: 'read' }, hold: 'missing contents:write' },
  'no-workflows': { workflow: true, hold: 'missing workflows:write' },
  'harness-missing-workflows': { workflow: true, disableEscalation: true, hold: 'missing workflows:write' },
  expired: { expiresAt: '2000-01-01T00:00:00Z', hold: 'minted token missing or expired' },
  'missing-expiry': { expiresAt: null, hold: 'minted token missing or expired' },
  'push-401-twice': { pushRefusal: 'HTTP/2 401 Unauthorized', refresh: 'different' },
  'push-401-recovered': { pushRefusal: 'HTTP 401 Unauthorized', refresh: 'different', recovers: true },
  'push-401-same-token': { pushRefusal: 'HTTP 401 Unauthorized', refresh: 'same' },
  'push-403': { pushRefusal: 'The requested URL returned error: 403' },
  'push-protected-branch': { pushRefusal: 'remote: error: GH006: Protected branch update failed', trailingNoise: true },
  'destination-authority-refused': { readRefused: true },
})) {
  test(`publication preserves the exact ${mode} capability and lease`, async t => {
    const { rootDir, env, tokens, mintReceipt, provider } = publicationFixture(t, scenario);
    const repo = scenario.repo ?? ALT;
    const pushes = [];
    let mints = 0;
    let reads = 0;
    const execFileImpl = async (command, args, options) => {
      if (command === 'bash') {
        mints++;
        const result = await execAsync(command, args, options);
        if (mints === 1 || scenario.refresh !== 'different') return result;
        const minted = JSON.parse(result.stdout);
        return { stdout: JSON.stringify({ ...minted, token: 'fresh-alternate-publisher' }) };
      }
      if (command === 'gh') return { stdout: metadata(repo) };
      if (args.includes('fetch')) {
        assertIsolated(options.env, repo, 'alternate-reviewer');
        assert.ok(args.includes(`https://github.com/${repo}.git`));
      }
      if (args.includes('push')) {
        pushes.push({ args, env: options.env });
        if (scenario.pushRefusal && (!scenario.recovers || pushes.length === 1)) {
          const stderr = scenario.trailingNoise ? `${scenario.pushRefusal}\n${'x'.repeat(2200)}` : scenario.pushRefusal;
          throw Object.assign(new Error('fixture push refused'), { code: 128, stderr });
        }
      }
      if (args.includes('ls-remote')) {
        assertIsolated(options.env, repo, 'alternate-reviewer');
        assert.deepEqual(args.slice(-3), ['--refs', `https://github.com/${repo}.git`, 'refs/heads/topic']);
        reads += 1;
        if (mode === 'current-resolver' && reads === 1) throw new Error('TLS handshake timed out');
        if (scenario.readRefused) throw new Error('HTTP 403 after connection reset');
        return { stdout: `${CANDIDATE}\trefs/heads/topic\n` };
      }
      if (args.includes('rev-parse')) return { stdout: args.some(arg => arg.startsWith('refs/remotes')) ? BASE : CANDIDATE };
      if (args.includes('merge-base')) return { stdout: BASE };
      if (args.includes('diff')) return { stdout: scenario.workflow ? '.github/workflows/fixture.yml\0' : 'src/fixture.js\0' };
      return { stdout: '' };
    };
    const publish = publishRemediation({ workspaceDir: rootDir, repo, prNumber: 4, branch: 'topic', baseBranch: 'main',
      previousHead: SHA, env, execFileImpl, pushCommand: 'fixture-git-safe', workerClass: 'codex',
      reviewerRole: 'claude-reviewer', reviewerModel: 'fixture-claude-model', ownerTokens: tokens });
    if (scenario.pushRefusal) {
      const retried = scenario.refresh === 'different';
      if (scenario.recovers) {
        assert.equal((await publish).headSha, CANDIDATE);
      } else {
        await assert.rejects(publish, error => {
          assert.ok([OWNER_AUTH_HOLD, 'remediation-publication-auth-rejected'].includes(error.code));
          assert.equal(error.pushDiagnostic.pushExitCode, 128);
          if (scenario.trailingNoise) {
            assert.equal(error.pushDiagnostic.stderrTail, 'x'.repeat(2048));
            assert.equal(error.pushDiagnostic.githubMessage, scenario.pushRefusal);
          } else {
            assert.equal(error.pushDiagnostic.stderrTail, scenario.pushRefusal);
          }
          assert.equal(error.pushDiagnostic.authRefusal, scenario.refresh ? 'authentication' : 'permission');
          assert.equal(error.pushDiagnostic.credentialRetried, retried || undefined);
          return true;
        });
      }
      assert.equal(mints, scenario.refresh ? 2 : 1);
      assert.equal(pushes.length, retried ? 2 : 1);
      assert.equal(reads, scenario.recovers ? 1 : 0);
      assertIsolated(pushes[0].env, repo, 'alternate-publisher');
      if (retried) {
        assertIsolated(pushes[1].env, repo, 'fresh-alternate-publisher');
        assert.deepEqual(pushes[1].args, pushes[0].args);
      }
      return;
    }
    if (scenario.hold) {
      const error = await publish.then(() => assert.fail('publication must hold'), caught => caught);
      assert.equal(error.code, OWNER_AUTH_HOLD);
      assert.equal(error.owner, 'alternate-org');
      assert.equal(error.capability, `contents:write${scenario.workflow ? ' + workflows:write' : ''} (codex)`);
      assert.equal(error.reason, `owner publication route: ${scenario.hold}`);
      assert.doesNotMatch(error.message, /alternate-publisher|nonexistent-fixture-bearer/);
      assert.equal(pushes.length, 0);
    } else {
      if (scenario.readRefused) {
        await assert.rejects(publish, error => {
          assert.equal(error.code, 'remediation-publication-unproven');
          assert.match(error.message, /access .* was refused/);
          assert.equal(error.cause?.code, OWNER_AUTH_HOLD);
          assert.equal(error.cause?.owner, 'alternate-org');
          return true;
        });
      } else {
        assert.equal((await publish).headSha, CANDIDATE);
      }
      assert.equal(pushes.length, 1);
      assert.equal(reads, mode === 'current-resolver' ? 2 : 1);
      assertIsolated(pushes[0].env, repo, 'alternate-publisher');
      assert.deepEqual(pushes[0].args.slice(-3), [`--force-with-lease=refs/heads/topic:${SHA}`,
        `https://github.com/${repo}.git`, `${CANDIDATE}:refs/heads/topic`]);
    }
    assert.deepEqual(mintReceipt(), scenario.noMint ? null : [provider, ALT, 'alternate-org']);
  });
}

test('home-owner publication does not enter the alternate-owner resolver', async t => {
  const { env, tokens } = fixture(t);
  assert.equal(await selectRemediationPushRoute({ repo: HOME, workerClass: 'codex', env, tokens,
    execFileImpl: () => assert.fail('home-owner publication must not mint an owner route') }), null);
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

test('every publication token variable matches the offline publication stub', async t => {
  // Local publication stub coverage only; this cannot detect changes in HQ.
  const { rootDir } = publicationFixture(t);
  for (const [role, variable] of Object.entries(ROLE_TOKEN_VARS)) {
    const { stdout } = await execAsync('bash', ['-c', 'source "$1"; _hq_token_broker_cfg_slug "$2"',
      'slug-parity', join(rootDir, 'modules/worker-pool/lib/hq-gh.sh'), variable]);
    assert.equal(stdout, role, `${variable} must select the declared Node role`);
  }
});
