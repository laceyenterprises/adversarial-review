import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { transferReviewerFallbackSession } from '../src/reviewer-fallback-session.mjs';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';
import { postGitHubReviewWithCapture } from '../src/reviewer.mjs';
import { buildReviewedAttestationPayload } from '../src/reviewed-attestation.mjs';
import { dispatchReviewerModel } from '../src/reviewer-harness.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';

const arm = { role: 'reviewer', harness: 'codex', worker_class: 'codex-reviewer', model: 'gpt-6-luna', effort: 'low', account: 'fixture-account' };
const receipt = { identity: 'codex-reviewer', tokenAccountId: arm.account, provider: 'codex', brokerProvider: 'codex',
  hold: false, pooled: true, lease: { account_id: arm.account, lease_id: 'fixture-lease', request_id: 'fixture-session', generation: 1 } };
const body = '## Summary\nSynthetic review.\n\n## Blocking issues\n- None.\n\n## Verdict\nComment only';

async function run(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'osg-reviewer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contexts = [], posts = [], attestations = [], selections = [], releases = [], sessions = [];
  const args = {
    rootDir: root, repo: 'sample/project', prNumber: 7, reviewerModel: 'codex', builderTag: 'claude-code',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', reviewerSessionUuid: 'fixture-session', reviewerHeadSha: 'a'.repeat(40),
    reviewAttemptNumber: 1, reviewDbAttemptNumber: 1, passKind: 'first-pass', maxRemediationRounds: 2,
    quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
    selectReviewerTokenAccountImpl: async value => { selections.push(value); return receipt; },
    updateReviewerTokenLeaseImpl: async (_, operation) => releases.push(operation),
    beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
    readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
    fetchPullRequestHeadAndStateImpl: async () => ({ state: 'open', headRefOid: 'a'.repeat(40) }),
    reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'cli-direct' }), async spawnReviewer(req) {
      contexts.push(req.subjectContext);
      sessions.push(req.sessionUuid);
      return { ok: true, reviewBody: body, reviewBodyDelivery: 'caller-post' };
    } },
    postGitHubReviewWithCaptureImpl: async value => {
      posts.push(value);
      await postGitHubReviewWithCapture({ ...value,
        // A captured fixture body exercises the normal verdict/attestation path
        // without GitHub, credentials, a signer, or the session ledger.
        findCapturedReviewerBodyImpl: () => ({ bodyMd: body, metadata: { reviewerAttribution: value.reviewerAttribution } }),
        emitReviewedAttestationImpl: async payload => {
          attestations.push(buildReviewedAttestationPayload({ ...payload, findingsCount: 0, ts: '2026-01-01T00:00:00Z' }));
        },
      });
    },
    ...extra,
  };
  const result = await spawnReviewer(args);
  assert.equal(result.ok, true);
  return { contexts, posts, attestations, selections, releases, sessions, result };
}

test('assigned reviewer produces the same verdict, family subject, account attribution and attestation as default', async t => {
  const baseline = await run(t);
  const assigned = await run(t, { reviewerArm: arm });
  assert.deepEqual(assigned.contexts[0].reviewerArm, arm);
  assert.equal(assigned.selections[0].model, arm.model);
  assert.deepEqual(assigned.attestations, baseline.attestations);
  assert.equal(assigned.attestations[0].verdict, 'comment-only');
  assert.equal(assigned.posts[0].reviewBody, baseline.posts[0].reviewBody);
  assert.deepEqual(assigned.releases, ['release']);
  let pins;
  await dispatchReviewerModel('codex', 'synthetic diff', '', { reviewerArm: arm,
    reviewWithCodexImpl: async (_diff, _context, options) => { pins = options; return { reviewText: body }; } });
  assert.equal(pins.modelPin, arm.model);
  assert.equal(pins.reasoningPin, arm.effort);
});

test('changed or unavailable ITP account returns to the ordinary model before spawning', async t => {
  for (const state of ['changed', 'held', 'error']) {
    let calls = 0;
    const releases = [];
    const assigned = await run(t, { reviewerArm: arm,
      selectReviewerTokenAccountImpl: async value => {
        calls++;
        if (!value.model) return receipt;
        if (state === 'error') throw Error('synthetic diagnostic');
        return state === 'held' ? { hold: true } : { ...receipt, tokenAccountId: 'other-account' };
      }, updateReviewerTokenLeaseImpl: async (_, operation) => releases.push(operation),
    });
    assert.equal(calls, 2);
    assert.equal(assigned.contexts[0].reviewerArm, undefined);
    assert.equal(releases.length, state === 'changed' ? 2 : 1);
  }
});

test('off carries no additional execution options into the normal runtime', async t => {
  const baseline = await run(t);
  assert.equal(Object.hasOwn(baseline.contexts[0], 'reviewerArm'), false);
});

test('CLI runtime serializes the arm into the reviewer process arguments', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'osg-reviewer-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let processArgs;
  const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir,
    preflightImpl: async () => ({ codexCli: '/fixture/codex' }),
    prepareCorporateCodexReviewerAuthImpl: () => null,
    spawnCapturedImpl: async (_command, args) => { processArgs = JSON.parse(args[1]); return { stdout: '', stderr: '' }; },
  });
  await adapter.spawnReviewer({ model: 'codex', subjectContext: { repo: 'sample/project', prNumber: 7,
    reviewerModel: 'codex', reviewerArm: arm }, timeoutMs: 100, sessionUuid: 'fixture-cli' });
  assert.deepEqual(processArgs.reviewerArm, arm);
});

for (const state of ['changed', 'held', 'error', 'unsupported-runtime']) {
  test(`cross-family arm fallback retains the claimed session after ${state}`, async t => {
    const db = new Database(':memory:');
    ensureReviewStateSchema(db);
    t.after(() => db.close());
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewer, review_status,
      reviewer_session_uuid, reviewer_head_sha, reviewed_at) VALUES ('sample/project', 7, 'claude',
      'reviewing', 'fixture-session', ?, '2026-10-22T00:00:00Z')`).run('a'.repeat(40));
    const fallbackCalls = [], requests = [];
    const fallback = await run(t, {
      reviewerModel: 'claude', builderTag: 'gemini', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      reviewerArm: { ...arm, harness: 'claude', worker_class: 'claude-reviewer' },
      reviewerArmDefaultRoute: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', codexBrokerProvider: 'codex-corp' },
      onGeminiQuotaFallback: () => assert.fail('arm fallback must not invoke Gemini quota handling'),
      onReviewerArmFallback: value => {
        fallbackCalls.push(value);
        transferReviewerFallbackSession(db, { ...value, repo: 'sample/project', prNumber: 7,
          previousSessionUuid: 'fixture-session' });
      },
      selectReviewerTokenAccountImpl: async value => {
        requests.push(value);
        if (!value.model) return null; // Legacy, non-enrolled default account.
        if (state === 'error') throw Error('synthetic account outage');
        return state === 'held' ? { hold: true } : { ...receipt, tokenAccountId: 'other-account' };
      },
      ...(state === 'unsupported-runtime' ? {
        reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'fixture-stub' }), async spawnReviewer(req) {
          assert.equal(req.model, 'codex');
          assert.equal(req.sessionUuid, 'fixture-session');
          return { ok: true, reviewBody: body, reviewBodyDelivery: 'caller-post' };
        } },
      } : {}),
    });
    assert.equal(fallbackCalls.length, 1);
    const row = db.prepare('SELECT * FROM reviewed_prs').get();
    assert.equal(row.reviewer_session_uuid, 'fixture-session');
    assert.equal(row.reviewer, 'codex');
    assert.equal(row.codex_broker_provider, 'codex-corp');
    assert.equal(row.review_status, 'reviewing');
    assert.equal(fallback.result.effectiveReviewerModel, row.reviewer);
    assert.equal(requests.at(-1).requestId, row.reviewer_session_uuid);
    if (state !== 'unsupported-runtime') {
      assert.deepEqual(fallback.sessions, [row.reviewer_session_uuid]);
      assert.equal(fallback.contexts[0].reviewerArm, undefined);
    }
    assert.throws(() => transferReviewerFallbackSession(db, { repo: 'sample/project', prNumber: 7,
      previousSessionUuid: 'stale-session', reviewerSessionUuid: 'replacement', reviewerModel: 'claude' }), /lost session claim/);
    assert.equal(db.prepare('SELECT reviewer_session_uuid FROM reviewed_prs').get().reviewer_session_uuid, 'fixture-session');
  });
}

test('arm fallback forwards a generated session UUID when the caller omits one', async t => {
  let transferredSession;
  const fallback = await run(t, {
    reviewerSessionUuid: undefined, reviewerModel: 'claude', builderTag: 'gemini',
    reviewerArm: { ...arm, harness: 'claude', worker_class: 'claude-reviewer' },
    reviewerArmDefaultRoute: { reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    selectReviewerTokenAccountImpl: async value => value.model ? { hold: true } : null,
    onReviewerArmFallback: value => { transferredSession = value.reviewerSessionUuid; },
  });
  assert.ok(transferredSession);
  assert.deepEqual(fallback.sessions, [transferredSession]);
});
