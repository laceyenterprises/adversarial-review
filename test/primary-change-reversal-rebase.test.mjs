import { collect, review } from './helpers/hamclose-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrimaryChange, fetchPrimaryChange, fetchPrimaryChangeContext,
  primaryChangeExactReviewEvidence } from '../src/ama/primary-change.mjs';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';

const sha = (c) => c.repeat(40);
const oldBase = sha('0'), base = sha('b'), reviewedHead = sha('1'), author = sha('2'), head = sha('c');
test('HAMREVERSAL-01: API-published reversal uses verification from the re-read commit', async () => {
  const { transport } = await collect();
  for (const verified of [true, false]) {
    const reads = [];
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
      get: async path => {
        reads.push(path);
        const response = await transport(path);
        if (path.endsWith(`/commits/${head}`)) return { ...response, committer: { login: 'web-flow' },
          commit: { ...response.commit, verification: { verified, reason: 'valid' } } };
        // The compare response deliberately retains the old identity shape;
        // only the individual commit read supplies API verification.
        return response;
      } }, { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.ok(reads.includes(`repos/fixture/repo/commits/${head}`));
    const result = checkPrimaryChange(evidence, head);
    if (verified) {
      assert.equal(evidence.reversalAuthorizations.length, 1);
      assert.equal(evidence.reversalAuthorizations[0].commit.commit.verification.verified, true);
      assert.equal(result.ok, true);
    } else {
      assert.equal(evidence.reversalAuthorizations, undefined);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance');
      assert.equal(result.reason, 'primary-change-reverted');
    }
  }
});

test('HAM reversal hydrates exact-commit verification from the bounded history reader', async () => {
  const { transport } = await collect();
  for (const scenario of ['valid', 'invalid', 'invalid-reason', 'foreign-author', 'wrong-sha', 'unreadable']) {
    const verificationReads = [];
    const get = async path => {
      const response = await transport(path);
      if (!path.endsWith(`/commits/${head}`)) return response;
      // createHistoryReader intentionally leaves verification out of commitFields.
      const { verification: _verification, ...commit } = response.commit;
      return { ...response, ...(scenario === 'foreign-author' ? { author: { login: 'foreign-builder' } } : {}),
        committer: { login: 'web-flow' }, commit };
    };
    get.commitVerification = async path => {
      verificationReads.push(path);
      if (scenario === 'unreadable') throw new Error('verification unavailable');
      return { sha: scenario === 'wrong-sha' ? sha('d') : head,
        verification: { verified: scenario !== 'invalid', reason: scenario === 'invalid-reason' ? 'unsigned' : 'valid' } };
    };
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get },
      { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    const result = checkPrimaryChange(evidence, head);
    assert.deepEqual(verificationReads, [`repos/fixture/repo/commits/${head}`], scenario);
    assert.equal(result.ok, scenario === 'valid', scenario);
    if (scenario === 'valid') {
      assert.equal(evidence.reversalAuthorizations[0].commit.commit.verification.verified, true);
    } else {
      assert.equal(result.reason, 'primary-change-reverted', scenario);
      assert.equal(evidence.reversalAuthorizations, undefined, scenario);
    }
  }
});

test('historical reversal snapshots hydrate their own web-flow verification', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  const { transport } = await collect({ originalRecorded: true, reviews: [review(), later] });
  for (const originalVerified of [true, false]) {
    const get = async path => {
      const response = await transport(path);
      if (!path.endsWith(`/commits/${sha('d')}`)) return response;
      const { verification: _verification, ...commit } = response.commit;
      return { ...response, committer: { login: 'web-flow' }, commit };
    };
    get.commitVerification = async path => {
      assert.equal(path, `repos/fixture/repo/commits/${sha('d')}`);
      return { sha: sha('d'), verification: { verified: originalVerified, reason: 'valid' } };
    };
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get },
      { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.equal(checkPrimaryChange(evidence, head).ok, originalVerified);
  }
});

test('an authorized HAM reversal stays authorized after the branch is rebased onto a newer base', async () => {
  const { evidence, result } = await collect();
  assert.equal(evidence.reversalAuthorizations.length, 1);
  assert.equal(evidence.reversalAuthorizations[0].rebased, true);
  assert.deepEqual(result, { ok: true, applicable: true, testRegionsChanged: [] });
});

test('a conflict-owner rebase then a hammer rebase keep the authorization, past a later review', async () => {
  // Two base moves (5 then 3 lines) and the post-reversal re-review on the
  // conflict-owner head with zero blocking findings, submitted after the HAM commit.
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED', submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' });
  const { result } = await collect({ shift: 8, reviews: [review(), later], originalRecorded: true });
  assert.equal(result.ok, true);
});

test('a trailer naming a review that is not on this pull request is rejected and named', async () => {
  for (const cites of [['PRR_other_pr finding=1 kind=blocking'], ['PRR_cited finding=2 kind=blocking']]) {
    const { result } = await collect({ cites });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.missingEvidence.evidence, 'reversal-authorization');
    assert.equal(result.missingEvidence.path, 'src/a.mjs');
  }
  const { evidence, result } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['review-not-on-this-pull-request']);
  assert.match(result.missingEvidence.summary, /PRR_other_pr finding=1 kind=blocking .*review-not-on-this-pull-request/);
});

test('a rebased reversal whose protected patch differs from the reviewed one is rejected', async () => {
  // The conflict resolution rewrote the author line the finding was about.
  assert.equal((await collect({ rebasedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  assert.equal((await collect({ reviewedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  // The finding must still cover the matched region in the reviewed head.
  const narrow = review({ body: review().body.replace('`10-11`', '`11`') });
  assert.equal((await collect({ reviews: [narrow] })).result.reason, 'primary-change-reverted');
});

test('identical segments must be unique in both primary and reviewed diffs', async () => {
  for (const options of [{ duplicatePrimary: true }, { duplicateReviewed: true }]) {
    const { evidence, result } = await collect(options);
    if (options.duplicatePrimary) {
      // Both repeated primary regions were touched by the hammer, while only
      // one reviewed region has a finding. Touching both cannot extend it.
      const files = evidence.reversalAuthorizations[0].commit.files;
      files[0] = { ...files[0], additions: 2, deletions: 4,
        patch: `${files[0].patch}\n${files[0].patch.replace('15,2 +15', '45,2 +45')}` };
    }
    const checked = checkPrimaryChange(evidence, head);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(checked.reason, 'primary-change-reverted');
    assert.match(checked.missingEvidence.summary, /patch differs or is ambiguous/);
  }
});

test('evaluator diagnostics explain nonexistent findings, patch mismatches and line coverage failures', async () => {
  for (const [options, reason] of [
    [{ cites: ['PRR_cited finding=2 kind=blocking'] }, 'finding-not-found'],
    [{ rebasedAdded: '+start_unsafe(retry=True)' }, 'rebased protected region patch differs or is ambiguous'],
    [{ reviews: [review({ body: review().body.replace('`10-11`', '`11`') })] }, 'finding-does-not-cover-region'],
  ]) {
    const { result } = await collect(options);
    assert.equal(result.missingEvidence.accepted, 0);
    assert.deepEqual(result.missingEvidence.rejected.map((entry) => entry.reason), [reason]);
    assert.ok(result.missingEvidence.summary.includes(reason));
  }
});

test('a historical snapshot must bind the same reversal patch, provenance and original coverage', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  for (const options of [{ originalRecorded: false }, { originalAdded: '-other_change()' },
    { originalLogin: 'foreign-builder' }, { originalParent: sha('9') }, { snapshotCapped: true }, { originalLine: 45 }]) {
    const { result } = await collect({ originalRecorded: true, reviews: [review(), later], ...options });
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(options));
  }
  const { result } = await collect({ originalRecorded: true, reviews: [review(), later],
    authoredAt: '2026-10-11T17:10:00Z' });
  assert.equal(result.ok, true);
});

test('an unauthorized rebased reversal still stops the hammer and names the missing authorization', async () => {
  const { evidence, result } = await collect({ cites: [] });
  assert.equal(evidence.reversalAuthorizations, undefined);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 0);
  assert.match(result.missingEvidence.summary, /no verified Reversal-Authorized-By covers the reverted src\/a\.mjs region \(0 verified\)/);
});

test('a superseded citation needs an immutable original reversal, even with a preserved author date', async () => {
  const superseding = review({ node_id: 'PRR_newer', commit_id: sha('9'), submitted_at: '2026-10-11T17:15:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const cases = [{ reviews: [review(), superseding] },
    { reviews: [review(), superseding], authoredAt: '2026-10-11T17:10:00Z' }];
  for (const options of cases) {
    const { evidence, result } = await collect(options);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(options));
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['original-reversal-not-proven-before-supersession']);
  }
  // Worker-controlled dates have no role in a still-current authorization.
  for (const authoredAt of ['not a date', '2026-10-11T16:00:00Z']) {
    assert.equal((await collect({ authoredAt })).result.ok, true);
  }
  // Another family stacking on the same reviewed head does not supersede it.
  const stacked = review({ node_id: 'PRR_gemini', user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: '2026-10-11T17:10:00Z' });
  assert.equal((await collect({ reviews: [review(), stacked] })).result.ok, true);
});

test('only a review head that diverged from the HAM parent may use the rebase path', async () => {
  // "behind": the cited head descends from the HAM parent, which no rebase produces.
  for (const reviewToParent of ['behind', 'unknown']) {
    const { evidence, result } = await collect({ reviewToParent });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason),
      [reviewToParent === 'behind' ? 'review-not-current' : 'unverifiable']);
  }
});

test('a HAM head failing self-certification only on the reversal authorization requests the exact-head review', async () => {
  const { result: primary } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  const checks = { workerClass: true, head: true, parent: true, commitIdentity: true, nonEmptyCommit: true, primaryChange: false };
  const trace = { primaryChange: primary, hamTerminalRemediation: { active: true, checks } };
  const missingEvidence = primaryChangeExactReviewEvidence(trace);
  assert.equal(missingEvidence, primary.missingEvidence);
  for (const other of [{ ...checks, parent: false }, { ...checks, primaryChange: true }]) {
    assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: true, checks: other } }), null);
  }
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: false, checks } }), null);
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, primaryChange: { ...primary,
    missingEvidence: { ...primary.missingEvidence, evidence: 'rename-preservation' } } }), null);

  const refusal = { dispatched: false, skipMergeAgent: true, reason: 'primary-change-repair-required', needsOperator: true,
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'primary-change-reverted'] };
  const requests = [];
  const logs = [];
  const recover = (result, extra = {}) => recoverStrandedCloserHead({ result, closerAuthored: true, rootDir: '/fixture',
    repo: 'fixture/repo', prNumber: 8088, headSha: head, logger: { log: (line) => logs.push(line), warn() {} },
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    requestBoundedReviewImpl: async (options) => { requests.push(options.headSha); return { triggered: true }; }, ...extra });
  const recovered = await recover({ ...refusal, missingEvidence, exactHeadReview: true });
  assert.equal(recovered.reason, 'closer-head-exact-review-requested');
  assert.equal(recovered.needsOperator, false);
  assert.equal(recovered.missingEvidence.evidence, 'reversal-authorization');
  assert.deepEqual(requests, [head]);
  assert.match(logs[0], /missing-evidence=no verified Reversal-Authorized-By covers the reverted src\/a\.mjs region/);
  // Without that proof, or with any other co-occurring refusal, the operator hold stays.
  for (const result of [refusal, { ...refusal, missingEvidence, exactHeadReview: true, reasons: [...refusal.reasons, 'ci-not-green'] },
    { ...refusal, missingEvidence, exactHeadReview: true, reasons: ['primary-change-reverted'] },
    { ...refusal, reason: 'primary-change-needs-operator', missingEvidence, exactHeadReview: true }]) {
    assert.equal(await recover(result), null);
  }
  // A live owner still wins.
  assert.equal(await recover({ ...refusal, missingEvidence, exactHeadReview: true },
    { probeOwnershipImpl: async () => ({ owned: true, uncertain: false }) }), null);
  assert.equal(requests.length, 1);
});

// The original reversal itself was already
// rebased when its immutable superseding review was posted.
test('HAMCLOSE-02 an original rebased App reversal survives a diverged superseding snapshot', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const options = { reviews: [review(), later], originalRecorded: true,
    originalParent: author, originalLine: 15, snapshotStatus: 'diverged' };
  assert.equal((await collect(options)).result.ok, true);
  for (const forged of [{ cites: [] }, { cites: ['PRR_missing finding=1'] },
    { cites: ['PRR_cited finding=99'] }, { hammerLogin: 'builder' },
    { reviews: [review({ user: { login: 'builder' } }), later] },
    { rebasedAdded: '+builder_intervened()' }]) {
    assert.equal((await collect({ ...options, ...forged })).result.ok, false, JSON.stringify(forged));
  }
});

for (const opaque of [
  { filename: 'asset.png', status: 'modified', additions: 0, deletions: 0, sha: sha('8') },
  { filename: 'renamed.mjs', previous_filename: 'old.mjs', status: 'renamed', additions: 0, deletions: 0 },
]) test(`opaque ${opaque.filename} rebase proof declines only its original snapshot`, async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const { transport } = await collect({ reviews: [review(), later], originalRecorded: true,
    originalParent: author, originalLine: 15, snapshotStatus: 'diverged' });
  const original = await transport(`repos/fixture/repo/commits/${sha('d')}`);
  const opaqueOriginal = { ...original, sha: sha('9'), parents: [{ sha: sha('e') }] };
  const parent = await transport(`repos/fixture/repo/compare/${base}...${author}`);
  for (const validFallback of [false, true]) {
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
      get: async path => {
        if (path.endsWith(`${reviewedHead}...${sha('f')}`)) return { status: 'diverged',
          commits: validFallback ? [opaqueOriginal, original] : [opaqueOriginal], total_commits: validFallback ? 2 : 1 };
        if (path.endsWith(`/commits/${opaqueOriginal.sha}`)) return opaqueOriginal;
        if (path.endsWith(`${reviewedHead}...${sha('e')}`)) return { status: 'diverged' };
        if (path.endsWith(`${base}...${sha('e')}`)) return { ...parent, files: [...parent.files, opaque] };
        return transport(path);
      } }, { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.equal(evidence.hasHammerCommits, true, 'opaque evidence must not become a history read failure');
    assert.equal(evidence.readFailed, undefined);
    if (validFallback) {
      assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, original.sha);
      assert.equal(checkPrimaryChange(evidence, head).ok, true);
    } else {
      assert.equal(evidence.reversalAuthorizations, undefined);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'original-reversal-not-proven-before-supersession');
      assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
    }
  }
});

test('unsigned unlinked author with copied hammer trailers and hammer committer is refused', async () => {
  const { evidence, result } = await collect({ nullAuthor: true });
  assert.equal(result.ok, false);
  assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance');
});

test('a rebased builder with unlinked author and hammer committer remains a builder', async () => {
  const { evidence, result } = await collect({ nullAuthor: true, builderOnly: true });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(result.ok, true);
});

test('rebase proof retains context and extra hunks', async () => {
  for (const options of [{ parentContext: '\n context_elsewhere', reviewedContext: '\n original_context' }, { parentExtraHunk: true }]) {
    assert.equal((await collect(options)).result.ok, false);
  }
});

test('unrelated mainline files in a diverged compare do not change authorization', async () => {
  assert.deepEqual((await collect({ unrelated: true })).result, (await collect({ unrelated: false })).result);
});

test('synthetic transport throws on an unrecorded path', async () => {
  const { transport } = await collect();
  await assert.rejects(transport('repos/fixture/repo/unrecorded'), /unexpected/);
});

test('unlinked rebased reversal requires an exact SHA in the authenticated App comment', async () => {
  assert.equal((await collect({ nullAuthor: true, attestationAuthor: 'the-hammer-lacey[bot]' })).result.ok, true);
  for (const options of [{ attestationAuthor: 'builder' },
    { attestationAuthor: 'the-hammer-lacey[bot]', attestationHead: '9'.repeat(40) }]) {
    assert.equal((await collect({ nullAuthor: true, ...options })).result.ok, false);
  }
});


test('operator attribution uses the effective non-blocking policy', async () => {
  const nonBlocking = review({ body: review().body.replace('## Blocking issues', '## Non-blocking issues')
    .replace('## Non-blocking issues\n- None.\n', '') });
  const { transport } = await collect({ reviews: [nonBlocking], cites: ['PRR_cited finding=1 kind=non-blocking'] });
  for (const strictNonBlockingRemediation of [true, false]) {
    let diagnosticReads = 0;
    const evidence = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get: transport }, {
      strictNonBlockingRemediation,
      fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
      createDiagnosticReaderImpl: () => async path => { diagnosticReads++; return transport(path); },
    });
    const result = checkPrimaryChange(evidence, head, { strictNonBlockingRemediation });
    assert.equal(result.ok, strictNonBlockingRemediation);
    assert.equal(diagnosticReads > 0, !strictNonBlockingRemediation);
    assert.equal(Boolean(evidence.revertedRegionDiagnostics), !strictNonBlockingRemediation);
  }
});

test('refused-region sweep cannot add accepted or rejected authorization evidence', async () => {
  const { evidence } = await collect({ duplicatePrimary: true });
  const authorization = evidence.reversalAuthorizations[0];
  authorization.rebased = false;
  authorization.reviewedFiles = evidence.primaryFiles;
  authorization.parentFiles = evidence.primaryFiles;
  authorization.review.body = review().body.replace('`10-11`', '`45-46`');
  authorization.commit.files[0].patch = authorization.commit.files[0].patch.replace('15,2 +15', '45,2 +45');
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 0);
  assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['finding-does-not-cover-region']);
  assert.deepEqual(result.missingEvidence.regions, [{ start: 15, end: 16 }]);
});
