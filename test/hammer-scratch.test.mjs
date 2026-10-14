import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  amaCloserDispatchFilePath, composeCloserPrompt, createHammerScratchDir,
  maybeDispatchAmaCloser, reconcileAmaCloserDispatches,
} from '../src/ama/dispatch-closer.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const head = 'b'.repeat(40);
const logger = { log() {}, info() {}, warn() {}, error() {} };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-scratch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function dispatchArgs(root) {
  const gate = 'fixture/gate';
  const user = userInfo().username;
  return {
    reviewState: { verdict: 'comment-only', headSha: head, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'synthetic-builder' },
    prMetadata: { prNumber: 42, headSha: head, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], author: 'synthetic-builder', branchProtection: { requiredContexts: [gate] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: gate, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'synthetic-integration', conclusion: 'FAILURE' }] },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: true } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: gate } },
    dispatchContext: { rootDir: root, repo: 'fixture/repo', prUrl: 'https://github.com/fixture/repo/pull/42',
      reviewedSha: head, riskClass: 'low', requiredGateContext: gate, reviewedBy: 'synthetic-reviewer',
      reviewer: 'codex', parentSession: 'synthetic-session', hqPath: 'synthetic-hq', hqRoot: join(root, 'hq'),
      hqOwnerUser: user, currentUser: user, dispatchedAt: '2026-10-01T00:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'synthetic-branch' }) },
    readTemplateImpl: () => 'PR <<PR_NUMBER>> scratch=<<RUN_DIR>>',
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger,
  };
}

for (const status of ['succeeded', 'failed', 'canceled', 'reaped']) {
  test(`HAMTMP-01: dispatch renders one private directory and ${status} run cleanup removes it`, async t => {
    const root = fixture(t);
    const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root),
      execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'synthetic-lrq', dispatchId: 'synthetic-dispatch' }) }) });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const path = amaCloserDispatchFilePath(root, { repo: 'fixture/repo', prNumber: 42, headSha: head });
    const record = JSON.parse(readFileSync(path));
    assert.equal(statSync(record.scratchDir).mode & 0o777, 0o700);
    assert.equal(statSync(record.scratchDir).uid, userInfo().uid);
    assert.equal(readFileSync(result.promptPath, 'utf8'), `PR 42 scratch=${record.scratchDir}`);
    writeFileSync(join(record.scratchDir, 'publication.sh'), 'synthetic evidence');
    const options = { logger, readLaunchRequestStatusImpl: () => ({ ok: true, row: { status } }) };
    await reconcileAmaCloserDispatches(root, { ...options, dryRun: true });
    assert.equal(existsSync(record.scratchDir), true);
    await reconcileAmaCloserDispatches(root, options);
    assert.equal(existsSync(record.scratchDir), false);
    // Reconciliation and next-run cleanup are idempotent.
    await reconcileAmaCloserDispatches(root, options);
  });
}

test('HAMTMP-01: a dispatch failure removes its unlaunched scratch directory', async t => {
  const root = fixture(t);
  let scratchDir;
  const args = dispatchArgs(root);
  const result = await maybeDispatchAmaCloser({ ...args, execFileImpl: async (_cmd, argv) => {
    const prompt = readFileSync(argv[argv.indexOf('--prompt') + 1], 'utf8');
    scratchDir = prompt.split('scratch=')[1];
    assert.equal(existsSync(scratchDir), true);
    throw new Error('synthetic permanent dispatch refusal');
  } });
  assert.equal(result.dispatched, false);
  assert.ok(scratchDir);
  assert.equal(existsSync(scratchDir), false);
});

test('HAMTMP-01: same-PR renders are fresh and every rendered helper uses private scratch', t => {
  const root = fixture(t);
  const directories = [createHammerScratchDir(root), createHammerScratchDir(root)];
  assert.notEqual(directories[0], directories[1]);
  for (const scratchDir of directories) {
    assert.equal(statSync(scratchDir).mode & 0o777, 0o700);
    const values = Object.fromEntries([...readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8')
      .matchAll(/<<([A-Z_]+)>>/g)].map(m => [`HAM_${m[1]}`, 'synthetic']));
    Object.assign(values, { HAM_ROOT_DIR: repoRoot, HAM_RUN_DIR: scratchDir, HAM_PR_NUMBER: '42' });
    const prompt = composeCloserPrompt({ templateBody: readFileSync(join(repoRoot, 'templates/hammer-prompt.md'), 'utf8'),
      rootDir: repoRoot, scratchDir, prNumber: 42 });
    assert.doesNotMatch(prompt, /\/tmp\/ham-/);
    assert.ok(prompt.includes(`export HAM_RUN_DIR='${scratchDir}'`));
    assert.ok(prompt.includes('source "$HAM_RUN_DIR/publish-commits.sh"'));
    for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
      const rendered = spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-procedure.mjs'), phase, '--render'], {
        env: { ...process.env, ...values }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.doesNotMatch(rendered.stdout, /\/tmp\/ham-|<<RUN_DIR>>/);
      assert.ok(rendered.stdout.includes(scratchDir));
    }
  }
  assert.equal(readdirSync(root).length, 2);
});
