import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const REPO = 'acme/myrepo';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixtureFiles(tmp, { protectionBody = '{}' } = {}) {
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
  });
  writeJson(paths.reviews, {
    reviews: [
      {
        state: 'APPROVED',
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

function runAmaCheck(tmp, { branchProtectionRequired, protectionBody }) {
  const paths = writeFixtureFiles(tmp, { protectionBody });
  const configPath = writeConfig(tmp, { branchProtectionRequired });
  return spawnSync(
    process.execPath,
    [
      AMA_CHECK,
      '--pr', paths.pr,
      '--reviews', paths.reviews,
      '--protection', paths.protection,
      '--timeline', paths.timeline,
      '--reviewed-sha', HEAD_SHA,
      '--risk-class', 'low',
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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check rejects ambiguous empty protection input when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-empty-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{}\n',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /branch protection waiver requires branchProtectionUnavailable sentinel/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check rejects non-sentinel protection input when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-wrong-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '{ "required_status_checks": { "contexts": ["agent-os/adversarial-gate"] } }\n',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /branch protection waiver requires branchProtectionUnavailable sentinel/);
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
      '--repo', REPO, '--root-dir', rootDir,
      '--review-cycle-exhausted', exhausted,
    ], { encoding: 'utf8', env: { ...process.env, AGENT_OS_CONFIG_PATH: configPath } });

    // Not exhausted → blocked.
    const strict = JSON.parse(run('false').stdout);
    assert.equal(strict.eligible, false);
    assert.ok(strict.reasons.includes('verdict-not-settled-success'));

    // Exhausted → final hammer waives the soft gates → eligible.
    const hammer = JSON.parse(run('true').stdout);
    assert.equal(hammer.eligible, true, JSON.stringify(hammer, null, 2));
    assert.equal(hammer.trace.finalHammer.active, true);
    assert.ok(hammer.trace.finalHammer.waived.includes('verdict-not-settled-success'));
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
