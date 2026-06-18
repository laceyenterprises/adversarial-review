import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobCompleted,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AMA_CHECK = join(REPO_ROOT, 'bin', 'ama-check.mjs');
const HEAD_SHA = 'abc12345abc12345abc12345abc12345abc12345';
const HAM_SHA = 'def67890def67890def67890def67890def67890';
const REBASED_SHA = 'fedcba98fedcba98fedcba98fedcba98fedcba98';
const REPO = 'acme/myrepo';
const CODEX_REVIEWER = { login: 'codex-reviewer-lacey' };
const CLAUDE_REVIEWER = { login: 'claude-reviewer-lacey' };
const AUTHORITATIVE_REVIEWER = CODEX_REVIEWER;

const SETTLED_COMMENT_BODY = [
  '## Summary',
  'Looks good.',
  '',
  '## Blocking Issues',
  '- None.',
  '',
  '## Non-blocking Issues',
  '- Consider a follow-up.',
  '',
  '## Verdict',
  'Comment only',
].join('\n');

const BLOCKING_COMMENT_BODY = [
  '## Summary',
  'Needs work.',
  '',
  '## Blocking Issues',
  '- **Auth path not threaded.** Pass the effective auth source into the profile.',
  '',
  '## Verdict',
  'Request changes',
].join('\n');

function hamTerminalEvidence({
  headSha = HAM_SHA,
  parentSha = HEAD_SHA,
  workerClass = 'hammer',
  closedBy = 'hammer (adversarial-pipe-mode)',
  remediatedFindings = '2 addressed (1 blocking, 1 non-blocking)',
  commitAuthor = 'hammer-worker',
  auditAuthor = 'hammer-worker',
  changedFiles = ['src/auth.js'],
  audit = true,
} = {}) {
  return {
    active: true,
    ticket: 'HAM-02',
    commit: {
      sha: headSha,
      parentSha,
      trailers: {
        'Worker-Class': workerClass,
        'Worker-Ticket': 'HAM-02',
        'Closed-By': closedBy,
        'Remediated-Findings': remediatedFindings,
      },
      author: commitAuthor,
      files: changedFiles,
    },
    auditComment: audit
      ? {
          body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md',
          author: auditAuthor,
          findings: [
            { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
            { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
          ],
        }
      : null,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeFixtureFiles(tmp, { protectionBody = '{}', prPatch = {}, reviews = null } = {}) {
  const paths = {
    pr: join(tmp, 'pr.json'),
    reviews: join(tmp, 'reviews.json'),
    protection: join(tmp, 'protection.json'),
    timeline: join(tmp, 'timeline.json'),
  };
  writeJson(paths.pr, {
    number: 1234,
    headRefOid: HEAD_SHA,
    state: 'OPEN',
    isDraft: false,
    mergeStateStatus: 'MERGEABLE',
    labels: ['operator-approved'],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
    ],
    author: { login: 'codex-worker-bot' },
    baseRefName: 'main',
    ...prPatch,
  });
  writeJson(paths.reviews, {
    reviews: reviews || [
      {
        state: 'COMMENTED',
        body: SETTLED_COMMENT_BODY,
        author: AUTHORITATIVE_REVIEWER,
        submittedAt: '2026-06-13T12:00:00Z',
        commit: { oid: HEAD_SHA },
      },
    ],
  });
  writeFileSync(paths.protection, protectionBody);
  writeJson(paths.timeline, [
    {
      event: 'labeled',
      label: { name: 'operator-approved' },
      commit_id: HEAD_SHA,
      actor: { login: 'paul-the-operator' },
      node_id: 'LE_operator_approved',
      created_at: '2026-06-13T12:01:00Z',
    },
  ]);
  return paths;
}

function hamCommitFixture({
  headSha = HAM_SHA,
  parentSha = HEAD_SHA,
  workerClass = 'hammer',
  closedBy = 'hammer (adversarial-pipe-mode)',
  remediatedFindings = '2 addressed (1 blocking, 1 non-blocking)',
  author = 'hammer-worker',
  changedFiles = ['src/auth.js'],
} = {}) {
  return {
    sha: headSha,
    parents: [{ sha: parentSha }],
    author: { login: author },
    committer: { login: author },
    files: changedFiles.map((filename) => ({ filename })),
    commit: {
      message: [
        'HAM-02 remediate final adversarial findings',
        '',
        `Worker-Class: ${workerClass}`,
        '',
        'Worker-Ticket: HAM-02',
        '',
        `Reviewed-Head: ${parentSha}`,
        '',
        `Closed-By: ${closedBy}`,
        '',
        `Remediated-Findings: ${remediatedFindings}`,
      ].join('\n'),
    },
  };
}

function writeConfig(tmp, { branchProtectionRequired }) {
  const configPath = join(tmp, 'config.yaml');
  writeFileSync(configPath, `\
version: 1
roles:
  adversarial:
    merge_authority:
      enabled: true
      eligibility:
        risk_classes: ["low"]
      branch_protection:
        required: ${branchProtectionRequired ? 'true' : 'false'}
        required_gate_context_source: resolveGateStatusContext
`);
  return configPath;
}

function writeCompletedLedgerJob(rootDir, { currentRound, maxRounds }) {
  createFollowUpJob({
    rootDir,
    repo: REPO,
    prNumber: 1234,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nPlaceholder.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-06-13T11:00:00.000Z',
    critical: false,
    riskClass: 'low',
    priorCompletedRounds: currentRound - 1,
    maxRemediationRounds: maxRounds,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-06-13T11:01:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-06-13T11:01:30.000Z',
    worker: {
      processId: 8123,
      state: 'spawned',
      workspaceDir: 'workspace',
      outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
      promptPath: 'workspace/.adversarial-follow-up/prompt.md',
    },
  });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: spawned.jobPath,
    finishedAt: '2026-06-13T11:02:00.000Z',
    completionPreview: 'fixture round',
    remediationWorker: {
      ...spawned.job.remediationWorker,
      state: 'completed',
    },
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'fixture',
      triggered: true,
      outcomeReason: null,
    },
  });
}

function runAmaCheck(tmp, {
  branchProtectionRequired,
  protectionBody,
  prPatch,
  reviews,
  reviewer = 'codex',
  riskClass = 'low',
  hamTerminalRemediation = null,
  rebaseAssessment = null,
}) {
  const paths = writeFixtureFiles(tmp, { protectionBody, prPatch, reviews });
  const configPath = writeConfig(tmp, { branchProtectionRequired });
  const extraArgs = [];
  if (hamTerminalRemediation) {
    paths.hamTerminalRemediation = join(tmp, 'ham-terminal-remediation.json');
    paths.hamCommit = join(tmp, 'ham-commit.json');
    writeJson(paths.hamTerminalRemediation, hamTerminalRemediation);
    writeJson(paths.hamCommit, hamCommitFixture({
      headSha: HAM_SHA,
      parentSha: HEAD_SHA,
      workerClass: hamTerminalRemediation?.commit?.trailers?.['Worker-Class'] || 'hammer',
      closedBy: hamTerminalRemediation?.commit?.trailers?.['Closed-By'] || 'hammer (adversarial-pipe-mode)',
      remediatedFindings:
        hamTerminalRemediation?.commit?.trailers?.['Remediated-Findings']
        || '2 addressed (1 blocking, 1 non-blocking)',
      author: hamTerminalRemediation?.commit?.author || 'hammer-worker',
      changedFiles: Array.isArray(hamTerminalRemediation?.commit?.files)
        ? hamTerminalRemediation.commit.files
        : ['src/auth.js'],
    }));
    const timeline = loadJson(paths.timeline);
    if (hamTerminalRemediation?.auditComment?.body) {
      timeline.push({
        event: 'commented',
        body: hamTerminalRemediation.auditComment.body,
        user: { login: hamTerminalRemediation.auditComment.author || 'hammer-worker' },
        created_at: '2026-06-13T12:30:00Z',
      });
      writeJson(paths.timeline, timeline);
    }
    extraArgs.push(
      '--ham-terminal-remediation',
      paths.hamTerminalRemediation,
      '--ham-commit',
      paths.hamCommit,
    );
  }
  if (rebaseAssessment) {
    paths.rebaseAssessment = join(tmp, 'rebase-assessment.json');
    writeJson(paths.rebaseAssessment, rebaseAssessment);
    extraArgs.push('--rebase-assessment', paths.rebaseAssessment);
  }
  return spawnSync(
    process.execPath,
    [
      AMA_CHECK,
      '--pr', paths.pr,
      '--reviews', paths.reviews,
      '--protection', paths.protection,
      '--timeline', paths.timeline,
      '--reviewed-sha', HEAD_SHA,
      '--reviewer', reviewer,
      '--risk-class', riskClass,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_OS_CONFIG_PATH: configPath,
      },
    },
  );
}

test('ama-check normalizes mergeable=MERGEABLE plus mergeStateStatus=CLEAN as mergeable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-clean-mergeable-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: {
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.mergeability.mergeableState, 'MERGEABLE');
    assert.ok(!verdict.reasons.includes('pr-not-mergeable'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check accepts content-equivalent rebase coverage without rewriting reviewed SHA', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-rebased-coverage-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: {
        headRefOid: REBASED_SHA,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
        ],
      },
      rebaseAssessment: {
        action: 'merge',
        evidence: 'content_equivalent_rebased_head',
        reviewedHead: HEAD_SHA,
        currentHead: REBASED_SHA,
        contentEquivalence: {
          equivalent: true,
          reviewedCount: 2,
          rebasedCount: 2,
          dropped: [],
          added: [],
        },
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.headMatch.reviewed, HEAD_SHA);
    assert.equal(verdict.trace.headMatch.current, REBASED_SHA);
    assert.equal(
      verdict.trace.headMatch.rebaseReviewCoverage.marker,
      'content_equivalent_rebased_head',
    );
    assert.ok(!verdict.reasons.includes('stale-review-head'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check does not let mergeStateStatus=CLEAN override mergeable=CONFLICTING', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-conflicting-clean-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: {
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'CLEAN',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.trace.mergeability.mergeableState, 'CONFLICTING');
    assert.ok(verdict.reasons.includes('pr-not-mergeable'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check validates HAM terminal remediation only with HAM head provenance and audit evidence', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-ham-terminal-'));
  try {
    const protectionBody = '{ "required_status_checks": { "contexts": ["agent-os/adversarial-gate"] } }\n';
    const reviews = [
      {
        state: 'CHANGES_REQUESTED',
        body: BLOCKING_COMMENT_BODY,
        author: AUTHORITATIVE_REVIEWER,
        submittedAt: '2026-06-13T12:00:00Z',
        commit: { oid: HEAD_SHA },
      },
    ];
    const passing = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence(),
    });
    assert.equal(passing.status, 0, passing.stderr);
    const passingVerdict = JSON.parse(passing.stdout);
    assert.equal(passingVerdict.eligible, true, JSON.stringify(passingVerdict, null, 2));
    assert.equal(
      passingVerdict.trace.hamTerminalRemediation.marker,
      'ham_terminal_remediation_validated',
    );
    assert.equal(passingVerdict.trace.hamTerminalRemediation.auditComment.author, 'hammer-worker');
    assert.deepEqual(passingVerdict.trace.hamTerminalRemediation.verifiedCommit.changedFiles, ['src/auth.js']);

    const abbreviatedClaim = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({
        headSha: HAM_SHA.slice(0, 12),
        parentSha: HEAD_SHA.slice(0, 12),
      }),
    });
    assert.equal(abbreviatedClaim.status, 0, abbreviatedClaim.stderr);
    const abbreviatedVerdict = JSON.parse(abbreviatedClaim.stdout);
    assert.equal(abbreviatedVerdict.eligible, true, JSON.stringify(abbreviatedVerdict, null, 2));

    const laterNonHam = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: '9999999999999999999999999999999999999999',
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence(),
    });
    assert.equal(laterNonHam.status, 0, laterNonHam.stderr);
    const laterVerdict = JSON.parse(laterNonHam.stdout);
    assert.equal(laterVerdict.eligible, false);
    assert.equal(laterVerdict.trace.hamTerminalRemediation.ok, false);
    assert.ok(laterVerdict.reasons.includes('stale-review-head'));

    const missingEvidence = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({ audit: false, workerClass: 'codex' }),
    });
    assert.equal(missingEvidence.status, 0, missingEvidence.stderr);
    const missingVerdict = JSON.parse(missingEvidence.stdout);
    assert.equal(missingVerdict.eligible, false);
    assert.equal(missingVerdict.trace.hamTerminalRemediation.checks.workerClass, false);
    assert.equal(missingVerdict.trace.hamTerminalRemediation.checks.auditComment, false);

    const forgedAuthor = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({ auditAuthor: 'codex-worker-bot' }),
    });
    assert.equal(forgedAuthor.status, 0, forgedAuthor.stderr);
    const forgedAuthorVerdict = JSON.parse(forgedAuthor.stdout);
    assert.equal(forgedAuthorVerdict.eligible, false);
    assert.equal(forgedAuthorVerdict.trace.hamTerminalRemediation.checks.auditCommentAuthor, false);

    const looseClosedBy = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({ closedBy: 'hammer-closer (adversarial-pipe-mode)' }),
    });
    assert.equal(looseClosedBy.status, 0, looseClosedBy.stderr);
    const looseClosedByVerdict = JSON.parse(looseClosedBy.stdout);
    assert.equal(looseClosedByVerdict.eligible, false);
    assert.equal(looseClosedByVerdict.trace.hamTerminalRemediation.checks.closedBy, false);

    const mismatchedCounts = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({
        remediatedFindings: '2 addressed (0 blocking, 2 non-blocking)',
      }),
    });
    assert.equal(mismatchedCounts.status, 0, mismatchedCounts.stderr);
    const mismatchedCountsVerdict = JSON.parse(mismatchedCounts.stdout);
    assert.equal(mismatchedCountsVerdict.eligible, false);
    assert.equal(mismatchedCountsVerdict.trace.hamTerminalRemediation.checks.remediatedFindings, false);

    const emptyDiff = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody,
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
      },
      reviews,
      hamTerminalRemediation: hamTerminalEvidence({ changedFiles: [] }),
    });
    assert.equal(emptyDiff.status, 0, emptyDiff.stderr);
    const emptyDiffVerdict = JSON.parse(emptyDiff.stdout);
    assert.equal(emptyDiffVerdict.eligible, false);
    assert.equal(emptyDiffVerdict.trace.hamTerminalRemediation.checks.nonEmptyCommit, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check refuses HAM terminal remediation when post-remediation checks fail', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-ham-terminal-red-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody: '{ "required_status_checks": { "contexts": ["agent-os/adversarial-gate"] } }\n',
      prPatch: {
        headRefOid: HAM_SHA,
        labels: [],
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'FAILURE' },
        ],
      },
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-13T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
      hamTerminalRemediation: hamTerminalEvidence(),
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.trace.hamTerminalRemediation.marker, 'ham_terminal_remediation_validated');
    assert.ok(verdict.reasons.includes('ci-not-green'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check accepts GitHub-plan protection sentinel only when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.branchProtection.required, false);
    assert.equal(verdict.trace.branchProtection.ok, true);
    assert.equal(verdict.trace.branchProtection.auditReason, 'branch_protection_requirement_waived');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check accepts unavailable 404-style protection input when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-404-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "message": "Branch not protected", "documentation_url": "https://docs.github.com/rest/branches/branch-protection#get-branch-protection", "status": "404" }\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.branchProtection.required, false);
    assert.equal(verdict.trace.branchProtection.ok, true);
    assert.equal(verdict.trace.branchProtection.auditReason, 'branch_protection_requirement_waived');
    assert.ok(!verdict.reasons.includes('branch-protection-missing-gate'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check accepts ordinary protection JSON when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-protection-json-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "required_status_checks": { "contexts": ["agent-os/adversarial-gate"] } }\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.branchProtection.required, false);
    assert.equal(verdict.trace.branchProtection.ok, true);
    assert.equal(verdict.trace.branchProtection.auditReason, 'branch_protection_requirement_waived');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check rejects malformed protection input when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-malformed-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to load input JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check rejects GitHub-plan protection sentinel when branch protection is required', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-required-sentinel-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /branch protection is required/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check keeps branch protection enforced when required=true and the gate context is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-required-missing-gate-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody: '{ "message": "Branch not protected", "status": "404" }\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.ok(verdict.reasons.includes('branch-protection-missing-gate'));
    assert.equal(verdict.trace.branchProtection.required, true);
    assert.equal(verdict.trace.branchProtection.ok, false);
    assert.equal(verdict.trace.branchProtection.auditReason, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed on empty protection snapshot when branch protection is required', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-required-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody: '{}\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.ok(verdict.reasons.includes('branch-protection-missing-gate'));
    assert.equal(verdict.trace.branchProtection.required, true);
    assert.equal(verdict.trace.branchProtection.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check: --review-cycle-exhausted true waives the soft gates (final hammer)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-final-hammer-'));
  try {
    const rootDir = join(tmp, 'root');
    writeCompletedLedgerJob(rootDir, { currentRound: 2, maxRounds: 2 });
    const paths = {
      pr: join(tmp, 'pr.json'),
      reviews: join(tmp, 'reviews.json'),
      protection: join(tmp, 'protection.json'),
      timeline: join(tmp, 'timeline.json'),
    };
    // Request-changes verdict, no operator-approved, branch protection required
    // but the snapshot has NO required context → normally blocked on
    // verdict-not-settled-success + branch-protection-missing-gate.
    writeJson(paths.pr, {
      number: 1234, headRefOid: HEAD_SHA, state: 'OPEN', isDraft: false,
      mergeStateStatus: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' }],
      author: { login: 'codex-worker-bot' }, baseRefName: 'main',
    });
    writeJson(paths.reviews, {
      reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-13T12:00:00Z', commit: { oid: HEAD_SHA } }],
    });
    writeFileSync(paths.protection, '{}'); // no required contexts
    writeJson(paths.timeline, []);
    const configPath = writeConfig(tmp, { branchProtectionRequired: true });
    const run = (exhausted) => spawnSync(process.execPath, [
      AMA_CHECK,
      '--pr', paths.pr, '--reviews', paths.reviews, '--protection', paths.protection,
      '--timeline', paths.timeline, '--reviewed-sha', HEAD_SHA, '--risk-class', 'low',
      '--reviewer', 'codex',
      '--repo', REPO, '--root-dir', rootDir,
      '--review-cycle-exhausted', exhausted,
    ], { encoding: 'utf8', env: { ...process.env, AGENT_OS_CONFIG_PATH: configPath } });

    // Not exhausted → blocked.
    const strict = JSON.parse(run('false').stdout);
    assert.equal(strict.eligible, false);
    assert.ok(strict.reasons.includes('verdict-not-settled-success'));

    // Exhausted → final hammer waives the STRUCTURAL gate (branch-protection)
    // but NOT the verdict gate — that now requires a current-head operator
    // override (fail-open fix). So still blocked on verdict-not-settled-success.
    const hammer = JSON.parse(run('true').stdout);
    assert.equal(hammer.eligible, false, JSON.stringify(hammer, null, 2));
    assert.equal(hammer.trace.finalHammer.active, true);
    assert.ok(hammer.reasons.includes('verdict-not-settled-success'));
    assert.ok(!hammer.trace.finalHammer.waived.includes('verdict-not-settled-success'));
    assert.ok(hammer.trace.finalHammer.waived.includes('branch-protection-missing-gate'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check recomputes final-hammer exhaustion from raised closer-time ledger budget', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-final-hammer-raised-budget-'));
  try {
    const rootDir = join(tmp, 'root');
    writeCompletedLedgerJob(rootDir, { currentRound: 2, maxRounds: 6 });
    const paths = {
      pr: join(tmp, 'pr.json'),
      reviews: join(tmp, 'reviews.json'),
      protection: join(tmp, 'protection.json'),
      timeline: join(tmp, 'timeline.json'),
    };
    writeJson(paths.pr, {
      number: 1234, headRefOid: HEAD_SHA, state: 'OPEN', isDraft: false,
      mergeStateStatus: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' }],
      author: { login: 'codex-worker-bot' }, baseRefName: 'main',
    });
    writeJson(paths.reviews, {
      reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-13T12:00:00Z', commit: { oid: HEAD_SHA } }],
    });
    writeFileSync(paths.protection, '{}');
    writeJson(paths.timeline, []);
    const configPath = writeConfig(tmp, { branchProtectionRequired: true });
    const result = spawnSync(process.execPath, [
      AMA_CHECK,
      '--pr', paths.pr, '--reviews', paths.reviews, '--protection', paths.protection,
      '--timeline', paths.timeline, '--reviewed-sha', HEAD_SHA, '--risk-class', 'low',
      '--reviewer', 'codex',
      '--repo', REPO, '--root-dir', rootDir,
      '--review-cycle-exhausted', 'true',
    ], { encoding: 'utf8', env: { ...process.env, AGENT_OS_CONFIG_PATH: configPath } });

    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.trace.finalHammer.active, false);
    assert.ok(verdict.reasons.includes('verdict-not-settled-success'));
    assert.ok(verdict.reasons.includes('branch-protection-missing-gate'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed when final-hammer recomputation lacks repo identity', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-final-hammer-missing-repo-'));
  try {
    const rootDir = join(tmp, 'root');
    writeCompletedLedgerJob(rootDir, { currentRound: 2, maxRounds: 2 });
    const paths = {
      pr: join(tmp, 'pr.json'),
      reviews: join(tmp, 'reviews.json'),
      protection: join(tmp, 'protection.json'),
      timeline: join(tmp, 'timeline.json'),
    };
    writeJson(paths.pr, {
      number: 1234, headRefOid: HEAD_SHA, state: 'OPEN', isDraft: false,
      mergeStateStatus: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' }],
      author: { login: 'codex-worker-bot' }, baseRefName: 'main',
    });
    writeJson(paths.reviews, {
      reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-06-13T12:00:00Z', commit: { oid: HEAD_SHA } }],
    });
    writeFileSync(paths.protection, '{}');
    writeJson(paths.timeline, []);
    const configPath = writeConfig(tmp, { branchProtectionRequired: true });
    const result = spawnSync(process.execPath, [
      AMA_CHECK,
      '--pr', paths.pr, '--reviews', paths.reviews, '--protection', paths.protection,
      '--timeline', paths.timeline, '--reviewed-sha', HEAD_SHA, '--risk-class', 'low',
      '--reviewer', 'codex',
      '--root-dir', rootDir,
      '--review-cycle-exhausted', 'true',
    ], { encoding: 'utf8', env: { ...process.env, AGENT_OS_CONFIG_PATH: configPath } });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /failed to recompute review-cycle exhaustion/);
    assert.match(result.stderr, /missing --repo/);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.trace.finalHammer.active, false);
    assert.ok(verdict.reasons.includes('verdict-not-settled-success'));
    assert.ok(verdict.reasons.includes('branch-protection-missing-gate'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Regression: closer pre-merge blocking-finding classification ----------
//
// Before this fix, `buildReviewState` never populated `blockingFindingState`
// / `blockingFindingCount`, so the eligibility predicate's
// `classifyBlockingFindings` returned `{ known: false }` for EVERY PR. That
// pushed `blocking-findings-unknown` + `verdict-not-settled-success` and the
// AMA closer deferred every settled-success closure on the pre-merge
// re-verification — while the watcher's eligibility pass (which set these
// fields from the durable job) passed. Net effect on AMA-enabled hosts:
// zero autonomous closures; the watcher looped recovery-fallback ->
// merge-agent (which the AMA-06A admit gate then refused). These tests pin
// the on-head body as the source of truth and the fail-closed default.

test('ama-check classifies a settled comment-only on-head review as eligible (blocking-findings known:0)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-settled-comment-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      // No operator-approved label: eligibility must come from the settled
      // verdict + known-zero blocking findings, NOT an override.
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'COMMENTED',
          body: SETTLED_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.blockingFindings.known, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.verdict.blockingFindings.count, 0);
    assert.equal(verdict.trace.verdict.settledSuccess, true);
    assert.ok(!verdict.reasons.includes('blocking-findings-unknown'));
    assert.ok(!verdict.reasons.includes('verdict-not-settled-success'));
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed when a settled comment-only body omits the blocking section entirely', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-missing-blocking-section-'));
  try {
    // A settled `Comment only` verdict whose body has NO `## Blocking Issues`
    // section at all. The shared merge-agent classifier is lenient here
    // (returns known:0 for a non-request-changes body lacking the section);
    // the AMA path must NOT trust that — absence of structured blocker
    // evidence is not evidence of zero blockers. Park at unknown.
    const noBlockingSectionBody = [
      '## Summary',
      'Looks fine.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n');
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'COMMENTED',
          body: noBlockingSectionBody,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.blockingFindings.known, false, JSON.stringify(verdict, null, 2));
    assert.ok(verdict.reasons.includes('blocking-findings-unknown'));
    assert.equal(verdict.eligible, false, JSON.stringify(verdict, null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check counts a populated blocking section on the on-head review (not synthesized known:0)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-blocking-present-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.blockingFindings.known, true, JSON.stringify(verdict, null, 2));
    assert.ok(verdict.trace.verdict.blockingFindings.count >= 1);
    assert.ok(verdict.reasons.includes('blocking-findings-present'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed to blocking-findings-unknown when no review is on the reviewed head', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-no-onhead-review-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      // Review is on a DIFFERENT commit than --reviewed-sha. Never synthesize
      // known:0 from an off-head body.
      reviews: [
        {
          state: 'COMMENTED',
          body: SETTLED_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.blockingFindings.known, false, JSON.stringify(verdict, null, 2));
    assert.ok(verdict.reasons.includes('blocking-findings-unknown'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check ignores a newer same-head review from a non-authoritative author', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-ignore-operator-comment-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
        {
          state: 'COMMENTED',
          body: 'LGTM',
          author: { login: 'paul-the-operator' },
          submittedAt: '2026-06-15T12:05:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.normalized, 'request-changes', JSON.stringify(verdict, null, 2));
    assert.ok(verdict.reasons.includes('blocking-findings-present'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed on a newer same-head reviewer comment without a normalizable Verdict', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-ignore-unstructured-comment-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
        {
          state: 'COMMENTED',
          body: 'LGTM',
          author: AUTHORITATIVE_REVIEWER,
          submittedAt: '2026-06-15T12:05:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.normalized, '', JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.verdict.blockingFindings.known, false);
    assert.ok(verdict.reasons.includes('blocking-findings-unknown'));
    assert.ok(verdict.reasons.includes('verdict-not-settled-success'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check does not search past an unknown newest same-head authoritative verdict', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-newest-unknown-authoritative-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviews: [
        {
          state: 'COMMENTED',
          body: SETTLED_COMMENT_BODY,
          author: CODEX_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
        {
          state: 'COMMENTED',
          body: '## Summary\nAmbiguous.\n\n## Blocking Issues\n- None.\n\n## Verdict\n\nUnclear',
          author: CODEX_REVIEWER,
          submittedAt: '2026-06-15T12:05:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.normalized, '', JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.verdict.blockingFindings.known, false);
    assert.ok(verdict.reasons.includes('blocking-findings-unknown'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check scopes Codex authority and ignores a newer Claude-family clean review', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-codex-authority-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewer: 'codex',
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: CODEX_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
        {
          state: 'COMMENTED',
          body: SETTLED_COMMENT_BODY,
          author: CLAUDE_REVIEWER,
          submittedAt: '2026-06-15T12:05:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.normalized, 'request-changes', JSON.stringify(verdict, null, 2));
    assert.ok(verdict.reasons.includes('blocking-findings-present'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check scopes Claude authority and ignores a newer Codex-family clean review', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-claude-authority-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "branchProtectionUnavailable": true, "reason": "github_plan" }\n',
      prPatch: { labels: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewer: 'claude-code',
      reviews: [
        {
          state: 'CHANGES_REQUESTED',
          body: BLOCKING_COMMENT_BODY,
          author: CLAUDE_REVIEWER,
          submittedAt: '2026-06-15T12:00:00Z',
          commit: { oid: HEAD_SHA },
        },
        {
          state: 'COMMENTED',
          body: SETTLED_COMMENT_BODY,
          author: CODEX_REVIEWER,
          submittedAt: '2026-06-15T12:05:00Z',
          commit: { oid: HEAD_SHA },
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.trace.verdict.normalized, 'request-changes', JSON.stringify(verdict, null, 2));
    assert.ok(verdict.reasons.includes('blocking-findings-present'));
    assert.equal(verdict.eligible, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
