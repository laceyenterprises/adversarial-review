import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDisabledRepositories, isMergeDisabledForRepository, applyRepositoryMergeOff,
  MERGE_DISABLED_FOR_REPOSITORY as REASON } from '../src/merge-disabled-repositories.mjs';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';
import { createGithubAdapterMergeSurface } from '../src/finalization/execution-surfaces.mjs';
import { processFastMergePR, pollFastMergeQueue } from '../src/fast-merge-processing.mjs';
import { writeAutonomousMergeDisabledAudit } from '../src/ama-closure-orchestration.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';

const listed = ['Example-Org/Example-Repo'];
const forms = ['example-org/example-repo', 'EXAMPLE-ORG/EXAMPLE-REPO',
  'HOST/Example-Org/Example-Repo', 'https://github.com/Example-Org/Example-Repo',
  'HTTPS://GITHUB.COM/EXAMPLE-ORG/EXAMPLE-REPO.GIT'];

test('repository merge-off normalization validates complete names and rejects folded duplicates', () => {
  assert.deepEqual(normalizeDisabledRepositories(listed), ['example-org/example-repo']);
  for (const value of [null, 'example-org/example-repo', {}, ['missing-slash'],
    ['host/owner/name'], [''], [42], [null], [' owner/name'], ['owner/name\n'],
    ['Owner/Name', 'owner/name']]) {
    assert.throws(() => normalizeDisabledRepositories(value), TypeError);
  }
});

test('repository merge-off matches each supported repo form and leaves other inputs unchanged', () => {
  const cfg = { enabled: true, autonomousMergeExecutionEnabled: true, disabledRepositories: listed };
  for (const repo of forms) {
    assert.equal(isMergeDisabledForRepository(listed, repo), true, repo);
    assert.equal(isMergeDisabledForRepository(cfg, repo), true, repo);
    assert.deepEqual(applyRepositoryMergeOff(cfg, repo), { ...cfg,
      autonomousMergeExecutionEnabled: false, mergeDisabledForRepository: true });
  }
  for (const repo of ['home-org/other-repo', '', null, 'owner', 'host/extra/owner/name',
    'https://example.com/example-org/example-repo', 'https:/example-org/example-repo',
    'example-org/example-repo\n', 'example-org/example-repo#1']) {
    assert.equal(isMergeDisabledForRepository(listed, repo), false);
    assert.equal(applyRepositoryMergeOff(cfg, repo), cfg);
  }
  assert.equal(isMergeDisabledForRepository([], forms[0]), false);
  assert.equal(isMergeDisabledForRepository({}, forms[0]), false);
  const disabled = { ...cfg, enabled: false };
  assert.equal(applyRepositoryMergeOff(disabled, forms[0]).enabled, false);
});

test('loader exposes config-only disabled repositories with defaults and fail-loud validation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-disabled-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  for (const loader of [loadConfig, loadConfigRuntime]) {
    writeFileSync(topPath, 'version: 1\n');
    assert.deepEqual(loader({ topPath, env: {} }).getMergeAuthorityConfig().disabledRepositories, []);
    for (const value of [listed, [], 'owner/name', null, {}, ['no-slash'], ['host/owner/name'],
      [''], [42], ['Owner/Name', 'owner/name']]) {
      writeFileSync(topPath, JSON.stringify({ version: 1, roles: { adversarial: {
        merge_authority: { disabled_repositories: value } } } }));
      if (value === listed || (Array.isArray(value) && !value.length)) {
        const cfg = loader({ topPath, env: {} });
        assert.deepEqual(cfg.getMergeAuthorityConfig().disabledRepositories,
          value.map(name => name.toLowerCase()));
        assert.deepEqual(cfg.get('roles.adversarial.merge_authority.disabled_repositories'),
          value.map(name => name.toLowerCase()));
      } else assert.throws(() => loader({ topPath, env: {} }), /disabled_repositories/);
    }
  }
});

test('fast-merge repository refusal makes no GitHub read or write and writes one audit', async () => {
  for (const repo of forms) {
    const audits = [];
    const result = await processFastMergePR({ db: { prepare: () => ({ run() {} }) },
      repo, prNumber: 17, authorizedHeadSha: 'synthetic-head',
      disabledRepositories: listed, ghClient: async () => assert.fail('GitHub call'),
      auditWriter: entry => audits.push(entry) });
    assert.deepEqual(result, { status: 'blocked', reason: REASON });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].refusal_reason, REASON);
    assert.equal(audits[0].action, 'blocked');
  }
});

test('fast-merge poll loads the merge-off list once per pass and passes it to each PR', async () => {
  let loads = 0;
  const audits = [];
  const rows = [17, 18].map(pr_number => ({ repo: forms[0], pr_number,
    fast_merge_authorized_head_sha: 'synthetic-head' }));
  const db = { prepare: () => ({ all: () => rows, run() {} }) };
  const summary = await pollFastMergeQueue({ db, loadConfigImpl: () => {
    loads++;
    return { getMergeAuthorityConfig: () => ({ disabledRepositories: listed }) };
  }, ghClient: async () => assert.fail('GitHub call'), auditWriter: entry => audits.push(entry) });
  assert.equal(loads, 1);
  assert.equal(summary.blocked, 2);
  assert.equal(audits.length, 2);
});

test('queue merge surface refuses listed repositories before any adapter invocation', async () => {
  let calls = 0;
  const surface = createGithubAdapterMergeSurface({ disabledRepositories: listed,
    execFileImpl: async () => { calls++; assert.fail('adapter call'); } });
  for (const repo of forms.slice(0, 3)) {
    const result = await surface.merge({ subjectExternalId: `${repo}#17`, revisionRef: 'synthetic-head' });
    assert.deepEqual(result, { ok: false, reason: REASON });
  }
  assert.equal(calls, 0);
});

test('closure policy observation selects the repository R02 hold and preserves unlisted observations', () => {
  const original = { enabled: true, autonomousMergeExecutionEnabled: true, disabledRepositories: listed };
  const candidate = { headSha: 'synthetic-head', prState: 'OPEN', isDraft: false };
  const observe = cfg => closureOwnerShadowEvidence({}, { candidate, cfg,
    autonomousMergeExecutionEnabled: cfg.autonomousMergeExecutionEnabled }).observations;
  const observation = observe(applyRepositoryMergeOff(original, forms[0]));
  assert.equal(observation.policy.mergeDisabledForRepository, true);
  const decision = nextAction(deriveNextActionSnapshot({ subjectKey: `${forms[0]}#17`,
    head: candidate.headSha, observedAt: '2030-01-01T00:00:00.000Z', observations: observation }));
  assert.equal(decision.row, 'R02-hold');
  assert.equal(decision.action, 'operator-hold');
  assert.equal(decision.reason, REASON);
  assert.deepEqual(observe(applyRepositoryMergeOff(original, 'home-org/other-repo')), observe(original));
  assert.equal(Object.hasOwn(observe(original).policy, 'mergeDisabledForRepository'), false);
});

test('unlisted queue surface issues byte-identical adapter arguments and results', async () => {
  const run = async disabledRepositories => {
    const calls = [];
    const surface = createGithubAdapterMergeSurface({ disabledRepositories, recordReceipt: false,
      env: { GHA_ADAPTER_BIN: 'synthetic-adapter' },
      execFileImpl: async (bin, args) => { calls.push({ bin, args }); return { stdout: '{"merged":true}' }; } });
    const result = await surface.merge({ subjectExternalId: 'home-org/other-repo#17', revisionRef: 'synthetic-head' });
    assert.equal(result.ok, true);
    return JSON.stringify({ result, calls });
  };
  assert.equal(await run(listed), await run([]));
});

test('unlisted fast-merge issues byte-identical reads and keeps pending CI behavior', async () => {
  const run = async disabledRepositories => {
    const calls = [];
    const result = await processFastMergePR({ repo: 'home-org/other-repo', prNumber: 17,
      disabledRepositories, authorizedHeadSha: 'synthetic-head',
      ghClient: async (bin, args) => {
        calls.push({ bin, args });
        if (args.includes('view')) return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'synthetic-head',
          labels: [{ name: 'fast-merge:test-fixtures' }] }) };
        if (args.includes('checks')) return { stdout: JSON.stringify([{ name: 'unit', state: 'PENDING', bucket: 'pending' }]) };
        assert.fail(`unexpected command: ${args.join(' ')}`);
      }, auditWriter: () => assert.fail('pending checks need no audit') });
    assert.equal(result.status, 'skipped_still_pending');
    return JSON.stringify({ result, calls });
  };
  assert.equal(await run(listed), await run([]));
});

test('disabled audit preserves the host-wide bytes and records the repository reason', t => {
  const hqRoot = mkdtempSync(join(tmpdir(), 'merge-off-audit-'));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const writes = [];
  const args = { hqRoot, repoPath: 'example-org/example-repo', prNumber: 17,
    headSha: 'synthetic-head', path: 'daemon-merge', now: '2030-01-01T00:00:00.000Z',
    writeAuditImpl: entry => writes.push(entry) };
  assert.deepEqual(writeAutonomousMergeDisabledAudit(args), {
    written: true, reason: 'autonomous-merge-execution-disabled',
  });
  const before = JSON.stringify(writes[0]);
  writeAutonomousMergeDisabledAudit({ ...args, reason: 'autonomous-merge-execution-disabled' });
  assert.equal(JSON.stringify(writes[1]), before);
  assert.deepEqual(writeAutonomousMergeDisabledAudit({ ...args, reason: REASON }), { written: true, reason: REASON });
  assert.equal(writes[2].attempt.outcome, 'failed-without-merge');
  assert.equal(writes[2].attempt.reason, REASON);
  assert.equal(writes[2].attempt.attemptPhase, 'autonomous-merge-disabled');
  assert.equal(writes.length, 3);
});

test('fast-merge config read failure fails closed before any GitHub call', async () => {
  await assert.rejects(pollFastMergeQueue({ db: { prepare: () => ({ all: () => [] }) },
    loadConfigImpl: () => { throw new Error('synthetic config unavailable'); },
    ghClient: async () => assert.fail('GitHub call') }), /synthetic config unavailable/);
});
