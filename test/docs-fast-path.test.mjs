import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocsOnlyFiles, readDocsFastPath } from '../src/docs-only.mjs';

test('DOCSFASTPATH-01 classify every old and new path, cache revisions, reclassify moved heads', async () => {
  assert.equal(fastMergeFileMatchesCategory({ filename: 'AGENTS.md' }, 'docs'), false);
  assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md' }, { filename: 'docs/images/flow.svg' }]), true);
  for (const filename of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'prompts/review.md',
    'personas/reader.md', 'identities/reader.md', 'projects/example/prompts/review.md',
    'src/main.mjs', 'config.yaml', 'docs/config.yaml', 'docs/../src/code.md', 'docs/AGENTS.md',
    'docs/prompts/review.md', 'docs/Prompts/review.md', 'docs/PROMPTS/review.md',
    'docs/nested/Personas/writer.md', 'docs/nested/IDENTITIES/reader.md']) {
    assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md' }, { filename }]), false, filename);
    assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md', previous_filename: filename }]), false, filename);
  }
  for (const files of [null, [], [{}], [{ filename: 'docs/guide.md', status: 'renamed' }], Array(300).fill({ filename: 'docs/guide.md' })]) {
    assert.equal(isDocsOnlyFiles(files), false);
  }
  let headSha = 'a'.repeat(40), calls = 0;
  const read = () => readDocsFastPath({ repoPath: 'example/manual', prNumber: 1,
    subject: { headSha, baseSha: 'b'.repeat(40), baseRefName: 'main' }, execGhWithRetryImpl: async ({ args }) => {
      calls++;
      return { stdout: JSON.stringify(args[1].includes('/compare/')
        ? { files: [{ filename: headSha.startsWith('a') ? 'docs/guide.md' : 'src/main.mjs' }] }
        : { state: 'open', labels: [], head: { sha: headSha }, base: { sha: 'b'.repeat(40), ref: 'main' } }) };
    } });
  assert.equal((await read()).headSha, headSha);
  await read();
  assert.equal(calls, 1);
  headSha = 'c'.repeat(40);
  assert.equal(await read(), null);
  assert.equal(calls, 2);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeRunDocsFastPath } from '../src/docs-fast-path.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { emitDocsFastPathAttestation } from '../src/reviewed-attestation.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { inspectMergeLease } from '../src/ama/merge-lease.mjs';
import { docsReviewRequested } from '../src/docs-only.mjs';
import { fastMergeDecisionFromLabels, fastMergeFileMatchesCategory } from '../src/adapters/subject/github-pr/fast-merge.mjs';

const head = 'd'.repeat(40), base = 'e'.repeat(40);
const evidence = { headSha: head, baseSha: base, baseBranch: 'main' };
const quiet = { log() {}, warn() {} };

test('DOCSFASTPATH-01 merge uses the daemon lease, green exact head and recorded attestation without review or closer', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'docs-fast-path-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let merged = 0, attested = 0, published = 0, rollupReads = 0;
  let scenario = 'green';
  const repoPath = 'example/docs-service';
  let prNumber = 2;
  const cfg = { enabled: true, strictMode: true, autonomousMergeExecutionEnabled: true,
    branchProtection: { required: true } };
  const subject = { headSha: head, labels: [], state: 'open' };
  const runDaemonImpl = args => runDaemonCleanMergeAttempt({ ...args,
    env: { HQ_ROOT: rootDir }, logger: quiet,
    fetchRollupImpl: async () => { rollupReads++; return {
      headSha: scenario === 'moved' && rollupReads > 1 ? 'f'.repeat(40) : head,
      title: 'Document the service', body: '', state: 'OPEN', labels: [],
      mergeable: scenario === 'conflict' ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: 'CLEAN',
      checks: [{ name: 'ci', status: 'COMPLETED', conclusion: scenario === 'red' ? 'FAILURE' : 'SUCCESS' },
        { context: 'agent-os/adversarial-gate', state: 'SUCCESS' }],
    }; },
    fetchPrimaryChangeImpl: async ({ headSha }) => ({ headSha, hasHammerCommits: false,
      ciCost: { headSha, ok: true } }),
    emitDocsFastPathAttestationImpl: async () => {
      assert.equal(inspectMergeLease({ rootDir, repo: repoPath, base: 'main' }).lease.holderHead, head);
      attested++;
      if (scenario === 'attestation-outage') throw new Error('synthetic record outage');
    },
    readDocsFastPathImpl: async args => scenario === 'late-review'
      ? readDocsFastPath({ ...args, execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({
        state: 'open', labels: ['request-review'], head: { sha: head }, base: { sha: base, ref: 'main' },
      }) }) }) : evidence,
    guardStackedBaseImpl: async () => null,
    execGhWithRetryImpl: async ({ args: command }) => {
      assert.deepEqual(command.slice(0, 2), ['pr', 'merge']);
      assert.equal(command[command.indexOf('--match-head-commit') + 1], head);
      assert.ok(attested > 0);
      merged++;
      return { stdout: '', stderr: '' };
    },
  });
  const run = () => maybeRunDocsFastPath({ rootDir, repoPath, prNumber, cfg, subject, logger: quiet,
    readDocsFastPathImpl: async () => evidence,
    publishStatusImpl: async () => { published++; },
    fetchProtectionImpl: async () => ({ requiredContexts: ['ci', 'agent-os/adversarial-gate'] }), runDaemonImpl });
  for (scenario of ['red', 'conflict', 'moved', 'attestation-outage', 'late-review']) {
    rollupReads = 0; prNumber++;
    assert.equal(await run(), scenario !== 'late-review', scenario);
    assert.equal(merged, 0, scenario);
    assert.equal(inspectMergeLease({ rootDir, repo: repoPath, base: 'main' }).lease, null, scenario);
  }
  scenario = 'green'; rollupReads = 0; prNumber++;
  assert.equal(await run(), true);
  assert.equal(merged, 1);
  assert.ok(published > 0);
  assert.equal(readAmaAuditEntry(rootDir, repoPath, prNumber, head).closureAuthority, 'docs-fast-path');
  // Exercise the actual Node sign/record boundary; the companion suite runs
  // the production Python interpreter and real Postgres constraint/store.
  let signed, recorded, signCalls = 0;
  const execFileImpl = (_command, command, options) => {
    if (command[1] === 'sign') {
      signCalls++;
      assert.equal(options.env.HCP_SUBJECT, 'ama-daemon');
      assert.equal(command.includes('--verdict'), false);
      assert.ok(command.every(arg => typeof arg === 'string'));
      const value = name => command[command.indexOf(name) + 1];
      signed = { schema_version: 1, repo: repoPath, pr_number: prNumber, head_sha: head,
        parent_head_sha: null, kind: value('--kind'), producer_identity: 'ama-daemon',
        verdict: null, findings_count: null, payload: JSON.parse(value('--payload-json')), ts: value('--ts'),
        signature: { algorithm: 'hcp-hmac-sha256:v1', subject: 'ama-daemon', digest: 'sha256:' + 'x'.repeat(43) } };
      return Promise.resolve({ stdout: JSON.stringify(signed) });
    }
    let resolve;
    const task = new Promise(done => { resolve = done; });
    task.child = { stdin: { end(input) {
      recorded = JSON.parse(input);
      resolve({ stdout: JSON.stringify({ attestation_id: 'example-attestation', repo: repoPath,
        pr_number: prNumber, head_sha: head, kind: 'docs-fast-path' }) });
    } } };
    return task;
  };
  await emitDocsFastPathAttestation({ repo: repoPath, prNumber, headSha: head, execFileImpl, env: {},
    readChainImpl: async () => [] });
  assert.equal(recorded.kind, 'docs-fast-path');
  assert.equal(recorded.head_sha, head);
  assert.deepEqual(recorded.payload, { policy: 'DOCSFASTPATH-01' });
  await emitDocsFastPathAttestation({ repo: repoPath, prNumber, headSha: head, execFileImpl, env: {},
    readChainImpl: async () => [{ ...signed, attestation_id: 'example-attestation', recorded_at: signed.ts }] });
  assert.equal(signCalls, 1, 'restart reuses and re-verifies the already recorded head');
  assert.equal('attestation_id' in recorded, false);
  assert.equal('recorded_at' in recorded, false);
  cfg.autonomousMergeExecutionEnabled = false;
  assert.equal(await run(), true);
  assert.equal(merged, 1);
});

test('DOCSFASTPATH-01 request-review and operator requests select the full path, including a late request', async () => {
  let calls = 0;
  const args = { subject: { headSha: head, labels: [] }, repoPath: 'example/requests', prNumber: 3,
    cfg: { enabled: true }, readDocsFastPathImpl: async () => evidence,
    publishStatusImpl: async () => {}, fetchProtectionImpl: async () => ({}), logger: quiet,
    runDaemonImpl: async () => { calls++; return { disposition: 'deferred' }; } };
  let configReads = 0;
  assert.equal(await maybeRunDocsFastPath({ ...args, readDocsFastPathImpl: async () => null,
    loadCfg: () => { configReads++; return args.cfg; } }), false);
  assert.equal(configReads, 0, 'ordinary heads add no configuration read');
  assert.equal(await maybeRunDocsFastPath(args), true);
  for (const overrides of [
    { subject: { ...args.subject, labels: ['request-review'] } },
    { subject: { ...args.subject, labels: ['retrigger-review'] } },
    { subject: { ...args.subject, requested_reviewers: [{ login: 'example-reviewer' }] } },
    { reviewRow: { rereview_reason: 'retrigger-review: operator requested review' } },
  ]) assert.equal(await maybeRunDocsFastPath({ ...args, ...overrides }), false);
  assert.equal(calls, 1);
  assert.equal(docsReviewRequested({ labels: [], requested_teams: [{ slug: 'example-team' }] }), true);
  // The former label-only docs waiver must not route instructions around review.
  assert.equal(fastMergeDecisionFromLabels(['fast-merge:docs']).hasFastMergeLabel, false);
  const eligibility = isEligibleForAmaClosure({}, { labels: ['fast-merge:docs'] },
    { enabled: true, eligibility: { fastMergeLabels: ['fast-merge:docs'] } });
  assert.equal(eligibility.reasons.includes('fast-merge-state-unsupported'), false);
});
