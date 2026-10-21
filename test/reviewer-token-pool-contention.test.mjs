import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

test('ITP-12 duplicate active spawns retain the original global account slot: 100 replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-pool-active-replay-'));
  const receipt = { identity: 'codex-reviewer', tokenAccountId: 'openai-primary', provider: 'codex',
    brokerProvider: 'codex', pooled: true, hold: false,
    lease: { account_id: 'openai-primary', lease_id: 'lease-1', generation: 1 } };
  const originalLog = console.log;
  let releases = 0;
  try {
    console.log = () => {};
    writeReviewerRunRecord(root, { sessionUuid: 'session', state: 'heartbeating', pgid: 9001,
      subjectContext: { reviewerAccountReceipt: receipt } });
    for (let replay = 0; replay < 100; replay += 1) {
      await spawnReviewer({ rootDir: root, repo: 'sample/project', prNumber: 7,
        reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
        selectReviewerTokenAccountImpl: async () => receipt,
        updateReviewerTokenLeaseImpl: async (_, operation) => { if (operation === 'release') releases += 1; },
        quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
        beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
        readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
        reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'cli-direct' }),
          spawnReviewer: async () => ({ ok: false, failureClass: 'daemon-bounce', error: 'original run remains active' }) },
      });
    }
  } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
  console.log(`ITP-12 duplicate-active replay: ${releases}/100 unsafe releases, ${100 - releases}/100 retained`);
  assert.equal(releases, 0, 'an adapter duplicate response is not process drain');
});
