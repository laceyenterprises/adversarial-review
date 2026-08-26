import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitTrailers } from '../src/ama/ham-provenance.mjs';
import { normalizeVerifiedCloserCommit } from '../src/head-closer-commit-suppression.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';

// HSC-01 regression fixtures — captured VERBATIM from laceyenterprises/agent-os#5908,
// the PR that sat unmerged for hours on `pending (stale-review-head)` while its head
// was the hammer's own validated terminal remediation. Every link below was proven
// broken against that live state; each assertion here fails on the pre-fix code.
const CURRENT_HEAD = 'b9f3ad5b2ed104f8acc9bb099b02f4e8fa2e9eb5';
const REVIEWED_HEAD = '717196836308418409061ea6b8071886bc963721';
// Four commits landed between the reviewed head and the hammer's remediation, so the
// remediation commit's parent is NOT the reviewed head.
const ACTUAL_PARENT = '395f73c7e300dda6735873991a9574f7cba584fd';

// `git commit -m <subject> -m <trailer> -m <trailer> ...` (templates/hammer-prompt.md)
// renders EVERY `-m` as its own paragraph, so the trailers are blank-line separated.
const LIVE_COMMIT_MESSAGE = [
  'HAM remediate final adversarial findings',
  '',
  'Worker-Class: hammer',
  '',
  'Worker-Ticket: HAM',
  '',
  `Reviewed-Head: ${REVIEWED_HEAD}`,
  '',
  'Closed-By: hammer (adversarial-pipe-mode)',
  '',
  'Remediated-Findings: 4 addressed (2 blocking, 2 non-blocking)',
  '',
].join('\n');

const CHANGED_FILES = [
  'modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py',
  'modules/sentinel/sentinel-walkthrough.md',
  'modules/sentinel/test/test_hammer_stranded_pr_probe.py',
  'modules/sentinel/test/test_pipeline_stability_observer.py',
];

// The hammer AGENT writes this prose, and it drifted from the template bullet:
// `- Title (blocking): detail` instead of `- **Title** (blocking) — detail`.
const LIVE_AUDIT_BODY = [
  '<!-- hq:ham-terminal-remediation:audit -->',
  '',
  '## Hammer remediation audit',
  '',
  'Landed terminal remediation for the reviewed findings.',
  '',
  'Findings addressed:',
  '- Missing state wiring for persistence (blocking): modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py and modules/sentinel/test/test_pipeline_stability_observer.py pass ProbeContext.state into run_hammer_stranded_pr_probe and test the wrapper.',
  '- Known candidate repo overwritten by colliding slug (blocking): modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py and modules/sentinel/test/test_hammer_stranded_pr_probe.py trust persisted known-candidate repo before lossy slug/cap inference.',
  '- First-cycle state loss on clean starts (non-blocking): modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py and modules/sentinel/test/test_pipeline_stability_observer.py copy the mutated pipeline state into the emitted card.',
  '- Loss of strand shape fidelity on cap file expiry (non-blocking): modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py, modules/sentinel/test/test_hammer_stranded_pr_probe.py, and modules/sentinel/sentinel-walkthrough.md persist and document strandShape, lifetimeAttemptCount, and lastDispatchedHeadSha.',
  '',
  'Validation:',
  '- GitHub required checks: green on b9f3ad5b2ed104f8acc9bb099b02f4e8fa2e9eb5.',
  '- Doc-currency: updated modules/sentinel/sentinel-walkthrough.md; changed files covered: modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py, modules/sentinel/sentinel-walkthrough.md, modules/sentinel/test/test_hammer_stranded_pr_probe.py, modules/sentinel/test/test_pipeline_stability_observer.py; data-model docs not applicable.',
  '',
  '<sub>',
  `HAM-Terminal-Remediation-Head: ${CURRENT_HEAD}`,
  'Remediated-Findings: 4 addressed (2 blocking, 2 non-blocking)',
  'Closed-By: hammer (adversarial-pipe-mode)',
  '</sub>',
].join('\n');

function liveVerifiedCommit() {
  return normalizeVerifiedCloserCommit({
    sha: CURRENT_HEAD,
    parents: [{ sha: ACTUAL_PARENT }],
    commit: { message: LIVE_COMMIT_MESSAGE },
    // GraphQL/`gh api` render the App committer with the `[bot]` suffix.
    committer: { login: 'the-hammer-lacey[bot]' },
    author: { login: null },
    files: CHANGED_FILES.map((filename) => ({ filename })),
  });
}

function liveAuditComment() {
  return {
    body: LIVE_AUDIT_BODY,
    // `gh pr view --json comments` (GraphQL) renders the App login WITHOUT `[bot]`.
    author: 'the-hammer-lacey',
    createdAt: '2026-08-26T03:53:03Z',
    id: '3348800000',
  };
}

function liveReviewState() {
  return {
    headSha: REVIEWED_HEAD,
    verdict: 'request_changes',
    blockingFindingState: 'known',
    blockingFindingCount: 2,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 2,
    nonBlockingFindingIdentities: [
      'First-cycle state loss on clean starts',
      'Loss of strand shape fidelity on cap file expiry',
    ],
  };
}

function evaluate({ verifiedCommit, verifiedAuditComment, reviewState }) {
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: reviewState.headSha,
    verifiedCommit,
    verifiedAuditComment,
  });
  const verdict = isEligibleForAmaClosure(
    reviewState,
    {
      prNumber: 5908,
      headSha: CURRENT_HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
    },
    { enabled: true, workerClass: 'hammer' },
    {
      env: {},
      hamTerminalRemediation: evidence,
      hamTerminalRemediationGroundTruth: {
        commit: verifiedCommit,
        auditComment: verifiedAuditComment,
      },
    },
  );
  return { evidence, verdict, ham: verdict.trace.hamTerminalRemediation };
}

test('HSC-01: blank-line-separated commit trailers all parse (git renders each -m as its own paragraph)', () => {
  assert.deepEqual(parseCommitTrailers(LIVE_COMMIT_MESSAGE), {
    'worker-class': 'hammer',
    'worker-ticket': 'HAM',
    'reviewed-head': REVIEWED_HEAD,
    'closed-by': 'hammer (adversarial-pipe-mode)',
    'remediated-findings': '4 addressed (2 blocking, 2 non-blocking)',
  });
});

test('HSC-01: trailer scan still stops at prose and never consumes the subject line', () => {
  assert.deepEqual(
    parseCommitTrailers('Subject line\n\nSome prose paragraph.\n\nClosed-By: hammer (adversarial-pipe-mode)\n'),
    { 'closed-by': 'hammer (adversarial-pipe-mode)' },
    'a non-trailer line must terminate the backward scan',
  );
  assert.deepEqual(
    parseCommitTrailers('Fix: something in the subject\n'),
    {},
    'a subject that merely looks like `Word: text` is not a trailer',
  );
  assert.deepEqual(parseCommitTrailers(''), {});
});

test('HSC-01: the Reviewed-Head trailer covers a remediation whose parent is not the reviewed head', () => {
  const { ham } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.equal(
    ham.actualParent,
    ACTUAL_PARENT,
    'fixture must exercise the rebase/interleaved-commit shape, not the direct-parent shape',
  );
  assert.notEqual(ham.actualParent, REVIEWED_HEAD);
  assert.equal(ham.reviewedHeadTrailer, REVIEWED_HEAD);
  assert.equal(ham.checks.parent, true, 'the rebase-coverage branch must be satisfiable');
});

test('HSC-01: the hammer audit bullet parses without ** emphasis and with a `:` separator', () => {
  const { evidence } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.deepEqual(
    evidence.auditComment.findings.map((finding) => [finding.title, finding.blocking]),
    [
      ['Missing state wiring for persistence', true],
      ['Known candidate repo overwritten by colliding slug', true],
      ['First-cycle state loss on clean starts', false],
      ['Loss of strand shape fidelity on cap file expiry', false],
    ],
  );
});

test('HSC-01: the templated audit bullet form still parses (no regression on the documented format)', () => {
  const templated = liveAuditComment();
  templated.body = [
    '<!-- hq:ham-terminal-remediation:audit -->',
    '',
    '**Findings addressed**',
    '- **Missing state wiring for persistence** (blocking) — modules/sentinel/lib/python/sentinel/pipeline_stability_observer.py threading fix.',
    '- **First-cycle state loss on clean starts** (non-blocking) — modules/sentinel/test/test_pipeline_stability_observer.py coverage.',
    '',
    'Doc-currency: not applicable.',
  ].join('\n');
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: REVIEWED_HEAD,
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: templated,
  });
  assert.deepEqual(
    evidence.auditComment.findings.map((finding) => [finding.title, finding.blocking]),
    [
      ['Missing state wiring for persistence', true],
      ['First-cycle state loss on clean starts', false],
    ],
  );
});

test('HSC-01: the hammer audit comment author is recognised in its GraphQL (bare-slug) form', () => {
  const { ham } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.equal(ham.checks.auditCommentAuthor, true);
});

test('HSC-01: the hammer head self-certifies end to end and stale-review-head no longer blocks', () => {
  const { ham, verdict } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.equal(ham.ok, true, `expected self-certification; checks=${JSON.stringify(ham.checks)}`);
  assert.equal(ham.safetyCoreOk, true);
  assert.deepEqual(ham.advisoryShortfall, [], 'no advisory bookkeeping should be missing');
  assert.equal(ham.nonBlockingCoverage.ok, true, 'every standing non-blocking finding is covered by identity');
  assert.ok(
    ham.waived.includes('blocking-findings-present'),
    `expected the blocking gate to be waived by validated remediation; waived=${JSON.stringify(ham.waived)}`,
  );
  assert.equal(verdict.trace.headMatch.hamTerminalRemediation, true);
  assert.ok(
    !verdict.reasons.includes('stale-review-head'),
    `stale-review-head must not stand; reasons=${JSON.stringify(verdict.reasons)}`,
  );
});

// --- Safety invariants: none of the above may certify an unremediated head. ---

test('HSC-01 safety: an external push over the hammer head never self-certifies', () => {
  const commit = liveVerifiedCommit();
  // Same trailers (a message is forgeable) but a non-closer committer identity.
  commit.committer = 'some-human';
  commit.author = 'some-human';
  const { ham } = evaluate({
    verifiedCommit: commit,
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.equal(ham.checks.commitIdentity, false);
  assert.equal(ham.ok, false);
});

test('HSC-01 safety: a Reviewed-Head trailer naming a different review never self-certifies', () => {
  const commit = normalizeVerifiedCloserCommit({
    sha: CURRENT_HEAD,
    parents: [{ sha: ACTUAL_PARENT }],
    commit: {
      message: LIVE_COMMIT_MESSAGE.replace(
        REVIEWED_HEAD,
        '0000000000000000000000000000000000000000',
      ),
    },
    committer: { login: 'the-hammer-lacey[bot]' },
    files: CHANGED_FILES.map((filename) => ({ filename })),
  });
  const { ham } = evaluate({
    verifiedCommit: commit,
    verifiedAuditComment: liveAuditComment(),
    reviewState: liveReviewState(),
  });
  assert.equal(ham.checks.parent, false, 'the trailer must bind to the CURRENT posted review');
  assert.equal(ham.ok, false);
});

test('HSC-01 safety: a claim that lies about its parent never self-certifies', () => {
  const verifiedCommit = liveVerifiedCommit();
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({
    reviewedHead: REVIEWED_HEAD,
    verifiedCommit,
    verifiedAuditComment: liveAuditComment(),
  });
  evidence.commit.parentSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const verdict = isEligibleForAmaClosure(
    liveReviewState(),
    {
      prNumber: 5908,
      headSha: CURRENT_HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
    },
    { enabled: true, workerClass: 'hammer' },
    {
      env: {},
      hamTerminalRemediation: evidence,
      hamTerminalRemediationGroundTruth: {
        commit: verifiedCommit,
        auditComment: liveAuditComment(),
      },
    },
  );
  assert.equal(verdict.trace.hamTerminalRemediation.checks.parent, false);
  assert.equal(verdict.trace.hamTerminalRemediation.ok, false);
});

// The non-blocking lane only arms on a SETTLED-SUCCESS verdict with zero blocking
// findings — the comment-only shape the hammer also closes. Exercise it directly.
function settledCommentOnlyReviewState(identities) {
  return {
    headSha: REVIEWED_HEAD,
    verdict: 'comment-only',
    remediationPending: false,
    blockingFindingState: 'known',
    blockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: identities.length,
    nonBlockingFindingIdentities: identities,
  };
}

test('HSC-01: a settled comment-only head waives non-blocking findings the hammer actually addressed', () => {
  const { ham, verdict } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: settledCommentOnlyReviewState([
      'First-cycle state loss on clean starts',
      'Loss of strand shape fidelity on cap file expiry',
    ]),
  });
  assert.equal(ham.nonBlockingCoverage.ok, true);
  assert.ok(
    ham.waived.includes('non-blocking-findings-present'),
    `expected the covered non-blocking findings to be waived; waived=${JSON.stringify(ham.waived)}`,
  );
  assert.ok(!verdict.reasons.includes('non-blocking-findings-present'));
});

test('HSC-01 safety: an uncovered standing non-blocking finding still blocks the non-blocking waiver', () => {
  const { ham, verdict } = evaluate({
    verifiedCommit: liveVerifiedCommit(),
    verifiedAuditComment: liveAuditComment(),
    reviewState: settledCommentOnlyReviewState([
      'First-cycle state loss on clean starts',
      'Loss of strand shape fidelity on cap file expiry',
      'A finding the hammer never addressed',
    ]),
  });
  assert.equal(ham.ok, true, 'the safety core is still satisfied');
  assert.equal(ham.nonBlockingCoverage.ok, false);
  assert.ok(
    verdict.reasons.includes('non-blocking-findings-present'),
    `uncovered non-blocking findings must still stand; reasons=${JSON.stringify(verdict.reasons)}`,
  );
});
