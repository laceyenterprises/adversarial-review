import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverCancelledChecks, confirmNoCi, inspectCiBootstrap,
  verifyManagedCiRecord, readGreenManagedCi } from '../src/ci-recovery.mjs';
import { guardRereviewCiBeforeReviewer } from '../src/reviewer-ci-admission.mjs';
import { pickMergeAgentDispatchDetail } from '../src/merge-agent-dispatch-decision.mjs';
import { buildMergeAgentPrompt } from '../src/merge-agent-prompt.mjs';

const repo = 'acme/searchlight';
const headSha = '2f1c6edc'.padEnd(40, '0');
const quiet = { log() {}, warn() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ciunknown-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}
function noCiApi(calls, overrides = {}) {
  return async (command, args) => {
    calls.push([command, args]);
    if (command === 'hq') return { stdout: '{}' };
    const path = args.at(-1);
    const result = path.includes('/actions/workflows') ? { total_count: 0, workflows: [] }
      : path.endsWith('/rules/branches/main') ? []
      : path.endsWith('/branches/main') ? { name: 'main', protected: false } : undefined;
    if (result === undefined) throw new Error(`unexpected API: ${path}`);
    return { stdout: JSON.stringify(overrides[path] ?? result) };
  };
}
function signedCi() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const record = { schemaVersion: 1, headSha, verdict: 'green', repo,
    mode: 'self-hosted-container', manifestHash: 'sha256:fixture', createdAt: '2026-10-04T00:00:00Z' };
  const payload = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  record.signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('hex');
  return { record, key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) };
}

test('#7723 replay: one rerun, original cancelled attempt stays pending, second cancellation pages once', async t => {
  const rootDir = fixture(t);
  const calls = [];
  let attempt = 1;
  const check = { name: 'repo-guards', state: 'CANCELLED',
    detailsUrl: 'https://github.com/acme/agent-os/actions/runs/37237629227/job/1' };
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'pr') return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: headSha }) };
    return { stdout: JSON.stringify({ head_sha: headSha, conclusion: 'cancelled', run_attempt: attempt }) };
  };
  const guard = () => guardRereviewCiBeforeReviewer({ rootDir, repo: 'acme/agent-os', prNumber: 7723,
    passKind: 'rereview', reviewerHeadSha: headSha, execFileImpl, log: quiet,
    inspectCiImpl: async () => ({ state: 'failed', headSha, failedChecks: [check], pendingChecks: [] }),
    latestJobFinder: () => { throw new Error('cancellation must not enter remediation'); } });
  assert.equal((await guard()).reason, 'ci-settlement-pending');
  assert.equal((await guard()).ciGate.state, 'pending');
  assert.equal(calls.filter(([cmd, args]) => cmd === 'gh' && args.includes('POST')).length, 1);
  assert.equal(calls.filter(([cmd]) => cmd === 'hq').length, 0);
  attempt = 2;
  await guard();
  await guard();
  assert.equal(calls.filter(([cmd]) => cmd === 'hq').length, 1);
  assert.equal(calls.filter(([cmd, args]) => cmd === 'gh' && args.includes('POST')).length, 1);
});

test('failures, pending/missing checks, foreign runs and moved heads never rerun', async t => {
  const rootDir = fixture(t);
  const cancelled = { name: 'ci', state: 'CANCELLED', detailsUrl: `https://github.com/${repo}/actions/runs/1` };
  for (const state of ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED']) {
    assert.equal(await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha,
      failedChecks: [{ ...cancelled, state }], execFileImpl: () => { throw new Error('no API allowed'); } }), false);
  }
  assert.equal(await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha,
    failedChecks: [cancelled], pendingChecks: [{ name: 'missing' }], execFileImpl: () => { throw new Error('no API allowed'); } }), false);
  const calls = [];
  assert.equal(await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha,
    failedChecks: [cancelled], execFileImpl: async (...args) => {
      calls.push(args);
      if (args[1][0] === 'pr') return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: headSha }) };
      return { stdout: JSON.stringify({ head_sha: 'other', conclusion: 'cancelled', run_attempt: 1 }) };
    } }), false);
  assert.equal(calls.length, 2);
});

test('rerun reservations survive concurrent ticks, deduplicate a workflow and renew on a new head', async t => {
  const rootDir = fixture(t);
  let currentHead = headSha;
  let posts = 0;
  let pages = 0;
  let attempt = 1;
  let status = 'completed';
  const check = { name: 'lint', state: 'CANCELLED', detailsUrl: `https://github.com/${repo}/actions/runs/1` };
  const execFileImpl = async (_cmd, args) => {
    if (_cmd === 'hq') { pages++; return { stdout: '{}' }; }
    if (args[0] === 'pr') return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: currentHead }) };
    if (args.includes('POST')) { posts++; status = 'queued'; return { stdout: '' }; }
    return { stdout: JSON.stringify({ head_sha: currentHead, status,
      conclusion: status === 'completed' ? 'cancelled' : null, run_attempt: attempt }) };
  };
  const recover = (prNumber = 2) => recoverCancelledChecks({ rootDir, repo, prNumber,
    headSha: currentHead, failedChecks: [check, { ...check, name: 'test' }], execFileImpl });
  await Promise.all([recover(), recover()]);
  await recover(3);
  assert.equal(posts, 1);
  status = 'completed'; attempt = 2;
  await recover(); await recover();
  assert.equal(posts, 1);
  assert.equal(pages, 1, 'one page per head even when two checks cancel together');
  currentHead = 'a'.repeat(40);
  status = 'completed'; attempt = 1;
  await recover();
  assert.equal(posts, 2);
});

test('terminal and superseded PR heads cannot request recovery', async t => {
  const rootDir = fixture(t);
  for (const snapshot of [{ state: 'MERGED', headRefOid: headSha }, { state: 'OPEN', headRefOid: 'moved' }]) {
    let calls = 0;
    assert.equal(await recoverCancelledChecks({ rootDir, repo, prNumber: 2, headSha,
      failedChecks: [{ name: 'ci', state: 'CANCELLED', detailsUrl: `https://github.com/${repo}/actions/runs/1` }],
      execFileImpl: async (_cmd, args) => {
        calls++; assert.equal(args[0], 'pr'); return { stdout: JSON.stringify(snapshot) };
      } }), false);
    assert.equal(calls, 1);
  }
});

test('no-CI proof fails closed on workflows, required rules, protection and API errors', async () => {
  assert.equal(await confirmNoCi({ repo, baseBranch: 'main', execFileImpl: noCiApi([]) }), true);
  for (const overrides of [
    { [`repos/${repo}/actions/workflows?per_page=1`]: { total_count: 1, workflows: [{}] } },
    { [`repos/${repo}/rules/branches/main`]: [{ type: 'required_status_checks' }] },
    { [`repos/${repo}/branches/main`]: { name: 'main', protected: true } },
    { [`repos/${repo}/rules/branches/main`]: {} },
  ]) assert.equal(await confirmNoCi({ repo, baseBranch: 'main', execFileImpl: noCiApi([], overrides) }), false);
  assert.equal(await confirmNoCi({ repo, baseBranch: 'main', execFileImpl: async () => { throw new Error('403'); } }), false);
});

test('signed CI is bound to repo/head and tampering or missing keys fails closed', t => {
  const rootDir = fixture(t);
  const { record, key } = signedCi();
  assert.equal(verifyManagedCiRecord(record, key, { repo, headSha }), true);
  assert.equal(verifyManagedCiRecord({ ...record, verdict: 'red' }, key, { repo, headSha }), false);
  assert.equal(verifyManagedCiRecord(record, key, { repo: 'acme/other', headSha }), false);
  assert.equal(verifyManagedCiRecord(record, key, { repo, headSha: 'other' }), false);
  const dir = join(rootDir, 'workers', 'builder', 'logs', 'ci-attestations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${headSha}.json`), JSON.stringify(record));
  const publicKeyPath = join(rootDir, 'ci-key');
  writeFileSync(publicKeyPath, key);
  assert.equal(readGreenManagedCi({ repo, headSha, env: { HQ_ROOT: rootDir,
    AGENT_OS_CI_ATTESTATION_PUBLIC_KEY_PATH: publicKeyPath } }), true);
  assert.equal(readGreenManagedCi({ repo, headSha, env: { HQ_ROOT: rootDir } }), false);
  const localRecord = { ...record, signature: undefined, mode: 'github', manifestHash: `sha256:${'a'.repeat(64)}` };
  writeFileSync(join(dir, `${headSha}.json`), JSON.stringify(localRecord));
  assert.equal(readGreenManagedCi({ repo, headSha, env: { HQ_ROOT: rootDir, AGENT_OS_CI_HOSTING_MODE: 'github' } }), true);
  assert.equal(readGreenManagedCi({ repo, headSha, env: { HQ_ROOT: rootDir,
    AGENT_OS_CI_HOSTING_MODE: 'self-hosted-container' } }), false);
});

test('searchlight#2 replay: signed green evidence selects bootstrap merge; absent evidence pages once', async t => {
  const rootDir = fixture(t);
  const calls = [];
  const args = { rootDir, repo, prNumber: 2, headSha, baseBranch: 'main', rollup: [],
    ownContext: 'agent-os/adversarial-gate', execFileImpl: noCiApi(calls) };
  for (const rollup of [null, [{ name: 'external-ci', conclusion: 'SUCCESS' }],
    [{ __typename: 'StatusContext', context: args.ownContext, state: 'PENDING' }],
    [{ __typename: 'CheckRun', name: args.ownContext, conclusion: 'SUCCESS' }]]) {
    const result = await inspectCiBootstrap({ ...args, rollup, readAttestationImpl: () => true });
    assert.equal(result.mode, null);
  }
  assert.equal(calls.length, 0, 'unknown, external, and pending own-gate checks never enter bootstrap');
  const bootstrap = await inspectCiBootstrap({ ...args, readAttestationImpl: () => true });
  const job = { repo, prNumber: 2, headSha, baseBranch: 'main', branch: 'ci',
    ciBootstrap: bootstrap, checksConclusion: null, mergeable: 'MERGEABLE', prState: 'open',
    lastVerdict: 'Approved', blockingFindingCount: 0, blockingFindingState: 'known',
    nonBlockingFindingCount: 0, nonBlockingFindingState: 'known',
    remediationCurrentRound: 1, remediationMaxRounds: 3, labels: [] };
  assert.equal(pickMergeAgentDispatchDetail(job).decision, 'dispatch');
  const prompt = buildMergeAgentPrompt(job);
  assert.match(prompt, /ciMode: no-ci-bootstrap/);
  assert.match(prompt, /--match-head-commit/);
  assert.match(prompt, /ci-bootstrap.mjs/);
  assert.equal(pickMergeAgentDispatchDetail({ ...job, ciBootstrap: null }).decision, 'skip-checks-unknown');
  assert.equal(pickMergeAgentDispatchDetail({ ...job, nonBlockingFindingCount: 1 }).decision, 'skip-checks-unknown');
  assert.equal(pickMergeAgentDispatchDetail({ ...job, headSha: 'moved' }).decision, 'skip-checks-unknown');
  assert.equal(pickMergeAgentDispatchDetail({ ...job, lastVerdict: null,
    hamTerminalRemediationValidated: true }).decision, 'dispatch');
  await inspectCiBootstrap({ ...args, readAttestationImpl: () => false });
  await inspectCiBootstrap({ ...args, readAttestationImpl: () => false });
  assert.equal(calls.filter(([cmd]) => cmd === 'hq').length, 1);
  assert.match(calls.find(([cmd]) => cmd === 'hq')[1].join(' '), /repo has no CI/);
});
