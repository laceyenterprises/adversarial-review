import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewerRefusesBuilder } from '../src/adapters/subject/github-pr/routing.mjs';
import { TAG_PREFIXES } from '../src/pr-title-tagging.mjs';
import { buildReviewedAttestationPayload, validateSignedReviewedAttestation, signReviewedAttestation, enqueuePendingReviewedAttestation, readPendingReviewedAttestations } from '../src/reviewed-attestation.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { captureReviewerBodyAfterPost } from '../src/review-body-capture.mjs';
import { reconcileReviewerSessions } from '../src/reviewer-reattach.mjs';
import { backfillReviewerPassBodies, matchReviewerPassArtifact } from '../src/backfill-review-bodies.mjs';
const attributionUrl = new URL('../src/reviewer-attribution.mjs', import.meta.url);
const attribution = await import(attributionUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === attributionUrl.href) return {};
  throw error;
});
const repo = 'fixture/repo';
const log = { log() {}, warn() {}, info() {} };
const startedAt = '2026-10-20T00:00:00.000Z';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-attribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function receipt(family, account) {
  return { identity: `${family}-reviewer`, tokenAccountId: `${family}-${account}`,
    brokerProvider: family === 'codex' ? `codex${account === 'corporate' ? '-corp' : ''}` : `claude-code${account === 'corporate' ? '-corp' : ''}`,
    reason: 'preferred-ready', evidenceGeneration: 'evidence-1',
    lease: { lease_id: 'lease-1', request_id: 'session-1', generation: 1 } };
}
function project(context) {
  assert.equal(typeof attribution.buildReviewerAttribution, 'function');
  return attribution.buildReviewerAttribution(context);
}
function readPass(root) {
  const db = openReviewStateDb(root);
  try { return db.prepare('SELECT * FROM reviewer_passes WHERE repo = ? AND pr_number = 1').get(repo); }
  finally { db.close(); }
}
const builders = { codex: ['codex', 'codex-corp', 'clio-agent', 'hammer', 'hammer-corp', 'remediator-codex', 'remediator-codex-corp'],
  claude: ['claude-code', 'claude-code-corp', 'hammer-claude', 'hammer-claude-corp', 'remediator-claude', 'remediator-claude-corp'],
  gemini: ['gemini'], pi: ['pi'], opencode: ['opencode'], hermes: ['hermes'] };
const reviewers = { codex: ['codex', 'codex-corp', 'codex-reviewer'],
  claude: ['claude', 'claude-reviewer', 'claude-reviewer-corp'], gemini: ['gemini', 'gemini-reviewer'] };
test('ITP-13 every builder family × reviewer family × token keeps family exclusions', () => {
  for (const [builderFamily, aliases] of Object.entries(builders)) for (const builder of aliases) {
    for (const [reviewerFamily, models] of Object.entries(reviewers)) for (const model of models) {
      for (const token of ['primary', 'corporate', 'holder-a', 'holder-b']) {
        assert.equal(reviewerRefusesBuilder(builder, model), builderFamily === reviewerFamily, `${builder}/${model}/${token}`);
      }
    }
  }
  assert.deepEqual(Object.values(TAG_PREFIXES), ['[codex]', '[claude-code]', '[clio-agent]', '[gemini]', '[pi]', '[opencode]', '[hermes]']);
});
for (const family of ['claude', 'codex', 'gemini']) test(`ITP-13 ${family} account changes keep subject, capture and queued exact-head attribution`, async t => {
  const root = fixture(t);
  const contexts = ['primary', 'corporate'].map(account => ({ reviewerModel: family,
    ...(family === 'gemini' ? { agyHolderLease: { identity: 'gemini-reviewer', tokenAccountId: `agy-${account}`, user: `holder-${account}`, reviewId: 'review-1', generation: 'lease-1', selectionReason: 'preferred-ready', evidenceGeneration: 'evidence-1' } }
      : { reviewerAccountReceipt: receipt(family, account) }) }));
  const projections = contexts.map(project);
  assert.equal(projections[0].reviewerSubject, `${family}-reviewer-lacey`);
  assert.equal(projections[0].reviewerSubject, projections[1].reviewerSubject);
  assert.notEqual(projections[0].tokenAccountId, projections[1].tokenAccountId);
  beginReviewerPass(root, { repo, prNumber: 1, attemptNumber: 1, reviewerClass: family, passKind: 'first-pass', startedAt, headSha: 'head-1' });
  await captureReviewerBodyAfterPost(root, { repo, prNumber: 1, attemptNumber: 1, reviewerModel: family,
    reviewerHeadSha: 'head-1', passKind: 'first-pass', reviewBody: '## Verdict\nComment only',
    reviewerAttribution: projections[1], knownGitHubArtifact: { id: 1, commit_id: 'head-1' }, requireGitHubArtifact: true, log });
  assert.deepEqual(JSON.parse(readPass(root).metadata_json).reviewerAttribution, projections[1]);
  const args = { repo, prNumber: 1, headSha: 'head-1', reviewerIdentity: `${family}-reviewer-lacey`, verdict: 'comment-only', reviewerAttribution: projections[1] };
  const payload = buildReviewedAttestationPayload(args);
  assert.deepEqual(payload.payload.reviewer_attribution, projections[1]);
  const signed = { ...payload, signature: { algorithm: 'hcp-hmac-sha256:v1', subject: args.reviewerIdentity, digest: `sha256:${'A'.repeat(43)}` } };
  validateSignedReviewedAttestation(signed, payload);
  let signingSubject;
  await signReviewedAttestation({ payload, env: { HCP_SUBJECT: 'inherited-wrong-subject' },
    execFileImpl: async (_cmd, _args, opts) => { signingSubject = opts.env.HCP_SUBJECT; return { stdout: JSON.stringify(signed) }; } });
  assert.equal(signingSubject, `${family}-reviewer-lacey`);
  assert.throws(() => validateSignedReviewedAttestation({ ...signed, head_sha: 'stale' }, payload), /head_sha mismatch/);
  assert.throws(() => validateSignedReviewedAttestation({ ...signed, signature: { ...signed.signature, subject: 'builder' } }, payload), /subject mismatch/);
  await enqueuePendingReviewedAttestation(root, args, Object.assign(new Error('HCP unavailable'), { code: 'ECONNREFUSED' }));
  assert.deepEqual((await readPendingReviewedAttestations(root))[0].payload.payload.reviewer_attribution, projections[1]);
});
test('ITP-13 historical holder recovery adds a projection without rewriting signed history', async t => {
  const root = fixture(t);
  const metadata = { reviewerSessionUuid: 'session-1', signedHistory: { payload: { reviewer_identity: 'old-holder' }, signature: 'historic-bytes' } };
  beginReviewerPass(root, { repo, prNumber: 1, attemptNumber: 1, reviewerClass: 'gemini', passKind: 'first-pass', startedAt, headSha: 'head-1', metadata });
  writeReviewerRunRecord(root, { sessionUuid: 'session-1', state: 'spawned', pgid: 99999, spawnedAt: startedAt,
    subjectContext: { repo, prNumber: 1, reviewerModel: 'gemini', agyIdentityLease: { user: 'old-holder', reviewId: 'old-review' } } });
  const path = join(root, 'data/reviewer-runs/session-1.json');
  const original = readFileSync(path, 'utf8');
  const db = openReviewStateDb(root);
  try {
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status, pr_state, reviewer_session_uuid, reviewer_pgid, reviewer_started_at, reviewer_head_sha) VALUES (?, 1, ?, 'gemini', 'reviewing', 'open', 'session-1', 99999, ?, 'head-1')`).run(repo, startedAt, startedAt);
    await reconcileReviewerSessions({ db, rootDir: root, now: new Date('2026-10-20T00:00:01Z'), log,
      probeAlive: () => true, probeSession: () => ({ alive: true, matched: true }), fetchHeadSha: async () => 'head-1', findPostedReview: async () => null });
  } finally { db.close(); }
  const recovered = JSON.parse(readPass(root).metadata_json);
  assert.equal(recovered.reviewerAttribution.identity, 'gemini-reviewer');
  assert.equal(recovered.reviewerAttribution.holderRef, 'old-holder');
  assert.equal(recovered.reviewerAttribution.tokenAccountId, null);
  assert.equal(recovered.reviewerAttribution.attemptRef, 'old-review');
  assert.deepEqual(recovered.signedHistory, metadata.signedHistory);
  assert.equal(readFileSync(path, 'utf8'), original);
});
test('ITP-13 backfill uses canonical App aliases and exact head, retaining legacy holder metadata', async t => {
  const root = fixture(t);
  const metadata = { agyIdentityLease: { user: 'old-holder', reviewId: 'old-review' }, signedHistory: { signature: 'unchanged' } };
  beginReviewerPass(root, { repo, prNumber: 1, attemptNumber: 1, reviewerClass: 'gemini', reviewerModel: 'gemini', passKind: 'first-pass', startedAt, headSha: 'head-1', metadata });
  completeReviewerPass(root, { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass', status: 'completed', endedAt: '2026-10-20T00:00:02Z' });
  const artifact = { node_id: 'review-1', commit_id: 'head-1', submitted_at: '2026-10-20T00:00:01Z', state: 'COMMENTED', body: 'historic body', user: { login: 'lacey-gemini-reviewer[bot]' } };
  const summary = await backfillReviewerPassBodies(root, { apply: true, log, execFileImpl: async (_cmd, args) => ({ stdout: args.includes(`repos/${repo}/pulls/1/reviews`) ? JSON.stringify(artifact) : '' }) });
  assert.equal(summary.populated, 1);
  const row = readPass(root);
  assert.equal(row.body_md, artifact.body);
  const result = JSON.parse(row.metadata_json);
  assert.deepEqual(result.signedHistory, metadata.signedHistory);
  assert.equal(result.reviewerAttribution.holderRef, 'old-holder');
  const match = matchReviewerPassArtifact({ ...row, body_md: null }, { comments: [], reviews: [{ nodeId: 'wrong', authorLogin: artifact.user.login, submittedAt: artifact.submitted_at, headSha: 'stale' }] });
  assert.equal(match.matched, null);
});
test('ITP-13 unknown historical accounts stay unknown and projections cannot change signer identity', () => {
  const unknown = project({ reviewerModel: 'codex' });
  assert.equal(unknown.tokenAccountId, null);
  assert.equal(unknown.brokerProvider, null);
  assert.throws(() => buildReviewedAttestationPayload({ repo, prNumber: 1, headSha: 'head', reviewerIdentity: 'builder', verdict: 'approved', reviewerAttribution: unknown }), /subject mismatch/);
});

test('ITP-13 native and Gemini same-family dispatch refuses before any account selection', async () => {
  const { spawnReviewer } = await import('../src/reviewer-spawn-settle.mjs');
  for (const [family, models] of Object.entries(reviewers)) for (const model of models) {
    for (const builder of builders[family]) for (const token of ['primary', 'corporate']) {
      let selected = 0;
      const result = await spawnReviewer({ reviewerModel: model, builderTag: builder,
        selectReviewerTokenAccountImpl: async () => { selected++; return receipt(family, token); },
        updateReviewerTokenLeaseImpl: async () => null,
        readReviewerQuotaDecisionImpl: async () => ({ available: true }),
        beginReviewerPassImpl() {}, completeReviewerPassImpl() {},
        readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
        reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'fixture-stub' }),
          spawnReviewer: async () => ({ ok: false, failureClass: 'unknown' }) } });
      assert.equal(result.routingRefusal, true, `${builder}/${model}/${token}`);
      assert.equal(selected, 0);
    }
  }
});

test('ITP-13 reusing a captured review attests its original account and stale heads refuse before posting', async t => {
  const { __test__: { postGitHubReviewWithCapture } } = await import('../src/reviewer.mjs');
  const rootDir = fixture(t);
  const original = project({ reviewerModel: 'codex', reviewerAccountReceipt: receipt('codex', 'primary') });
  const next = project({ reviewerModel: 'codex', reviewerAccountReceipt: receipt('codex', 'corporate') });
  let attested;
  const args = { rootDir, repo, prNumber: 1, attemptNumber: 1, reviewerModel: 'codex',
    reviewerHeadSha: 'head-1', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', reviewerAttribution: next,
    passKind: 'first-pass', log, reviewBody: 'new body',
    findCapturedReviewerBodyImpl: () => ({ bodyMd: '## Verdict\nComment only', metadata: { reviewerAttribution: original } }),
    execFileImpl: async () => { throw new Error('must reuse without GitHub mutation'); },
    emitReviewedAttestationImpl: async value => { attested = value; } };
  await postGitHubReviewWithCapture(args);
  assert.deepEqual(attested.reviewerAttribution, original);
  await assert.rejects(postGitHubReviewWithCapture({ ...args, currentHeadSha: 'different' }), /stale-review-head/);
  await assert.rejects(postGitHubReviewWithCapture({ ...args, botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' }), /subject mismatch/);
});

test('ITP-13 recovery rejects a legacy same-family reviewer and does not borrow another session receipt', async t => {
  const root = fixture(t);
  beginReviewerPass(root, { repo, prNumber: 1, attemptNumber: 1, reviewerClass: 'codex', passKind: 'first-pass', startedAt,
    metadata: { reviewerSessionUuid: 'other-session' } });
  writeReviewerRunRecord(root, { sessionUuid: 'session-1', state: 'spawned', pgid: 99999,
    subjectContext: { reviewerModel: 'codex-corp', builderTag: 'codex-corp', reviewerAccountReceipt: receipt('codex', 'corporate') } });
  const db = openReviewStateDb(root);
  try {
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status, pr_state, reviewer_session_uuid, reviewer_pgid, reviewer_started_at) VALUES (?, 1, ?, 'codex-corp', 'reviewing', 'open', 'session-1', 99999, ?)`).run(repo, startedAt, startedAt);
    await reconcileReviewerSessions({ db, rootDir: root, log, probeAlive: () => true,
      reviewerPoolOwnerImpl: async () => { throw new Error('offline'); },
      updateReviewerTokenLeaseImpl: async () => null,
      findPostedReview: async () => { throw new Error('family check must precede review probe'); } });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE pr_number = 1').get();
    assert.equal(row.review_status, 'failed-orphan');
    assert.match(row.failure_message, /family matches/);
    assert.equal(JSON.parse(readPass(root).metadata_json).reviewerAttribution, undefined);
  } finally { db.close(); }
});
