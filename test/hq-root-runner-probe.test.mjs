// A real test-file process, also selected by the runner integration test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { resolveHqRoot } from '../src/hq-root.mjs';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';

test('runner gives the shared HQ resolver a root inside the temporary directory', () => {
  const root = resolveHqRoot();
  const beneathTemp = relative(tmpdir(), root);
  assert.ok(beneathTemp && beneathTemp !== '..' && !beneathTemp.startsWith(`..${sep}`) && !isAbsolute(beneathTemp),
    'the default HQ root must be inside the runner temporary directory');
  assert.equal(process.env.HQ_ROOT, process.env.AGENT_OS_HQ_ROOT);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.HQ_ROOT)'], {
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, root);
  if (process.env.HQ_ROOT_FIXTURE_REPORT) {
    writeFileSync(join(process.env.HQ_ROOT_FIXTURE_REPORT, `${process.pid}.json`), JSON.stringify({ root, home: homedir() }));
  }
});

test('runner quota probe cannot see an inherited exhausted Gemini status', async () => {
  let spawned = false;
  const result = await spawnReviewer({
    repo: 'fixture-owner/demo',
    prNumber: 1,
    reviewerModel: 'gemini',
    reviewerHeadSha: 'fixture-head',
    reviewerSessionUuid: 'fixture-session',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 1,
    maxRemediationRounds: 2,
    // Read the real quota decision using only the runner-provided roots.
    quotaCheckEnv: {
      HQ_ROOT: process.env.HQ_ROOT,
      AGENT_OS_HQ_ROOT: process.env.AGENT_OS_HQ_ROOT,
      AGENT_OS_REVIEWER_QUOTA_CHECK_ENABLED: 'true',
    },
    agyReviewerIdentityPool: { plan: () => ({ multi: false }) },
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        spawned = true;
        return { ok: true, reviewBody: 'fixture review', reviewBodyDelivery: 'adapter' };
      },
    },
    beginReviewerPassImpl() {},
    completeReviewerPassImpl() {},
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    ledgerLookupSleepImpl: async () => {},
  });
  assert.equal(spawned, true, 'the inherited exhausted status must not block the fixture reviewer');
  assert.equal(result.ok, true);
  // Exercise a write through the shared root as well as a quota read.
  writeFileSync(join(resolveHqRoot(), 'fixture-state.json'), '{}');
  if (process.env.HQ_ROOT_FIXTURE_FAIL === '1') assert.fail('synthetic fixture failure');
});
