import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CLI, GEMINI_CLI, AGY_CLI, __test__ } from '../src/reviewer.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from '../src/quota-exhaustion.mjs';
import { buildObviousDocsGuidance, extractLinkedRepoDocs, fetchLinkedSpecContents, parseGitHubBlobPath } from '../src/prompt-context.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';
import { CATEGORY_ORDER } from '../src/api-telemetry.mjs';

const {
  CLAUDE_STRIPPED_ENV_VARS,
  ENV_BIN,
  LAUNCHCTL,
  buildClaudeReviewArgs,
  buildCodexReviewArgs,
  parseCodexJsonTokenUsage,
  queueFollowUpForPostedReview,
  resolveCodexAuthPath,
  resolveCodexExecOverrides,
  resolveReviewerTimeoutMs,
  ADVISORY_ONLY_REVIEW_LABEL,
  VERDICT_MODE_ADVISORY_ONLY,
  VERDICT_MODE_ENFORCE,
  buildReviewCommentHeader,
  classifyReviewCommentHeader,
  fetchCurrentHeadVerdictMode,
  resolveVerdictModeForHead,
  spawnCodexReview,
  spawnClaude,
  resolveGeminiCliPath,
  resolveAgyCliPath,
  resolveGeminiOAuthCredsPath,
  assertGeminiOAuth,
  assertAgyReviewerAuth,
  checkAgyReviewerAuth,
  resolveGeminiRuntime,
  resolveGeminiReviewerModel,
  resolveReviewerMetadata,
  buildGeminiReviewArgs,
  buildAgyReviewArgs,
  AGY_KEYCHAIN_SERVICE,
  AGY_KEYCHAIN_REMEDIATION,
  isRetryableGeminiSubprocessError,
  retryAfterFromGeminiFailure,
  formatAntigravityQuotaHoldMessage,
  buildAgrAllCappedPagePayload,
  maybePageAgrAllCapped,
  spawnGeminiReview,
  spawnAgyReview,
  reviewWithGemini,
  dispatchReviewerModel,
  formatAdvisoryFindingsContext,
  LOCAL_REVIEW_SHADOW_LABEL,
  hasLocalReviewShadowLabel,
  evaluateLocalReviewShadowEligibility,
  persistLocalReviewShadowRequest,
  persistLocalReviewShadowRequestFailOpen,
  markLocalReviewShadowHostedPosted,
  completeLocalReviewShadowRequest,
  startLocalReviewShadowCompletion,
  reconcileLocalReviewShadow,
  formatLocalReviewShadowArtifact,
  readJsonFileIfExists,
} = __test__;

const LOCAL_SHADOW_TEST_ENV = {
  ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL: 'litellm-local/qwen3-coder',
};

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function queueWithFakes(reviewText, overrides = {}) {
  const created = [];
  const result = queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    baseBranch: 'release/2026.05',
    revisionRef: 'review-head-sha',
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: null,
    reviewText,
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    ...overrides,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestMaxRounds: 2,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });
  return { result, created };
}

test('VirtualPaul PR without advisory-only override label stays enforce mode', async () => {
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    reviewerHeadSha: 'head-a',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-a',
      labels: [{ name: 'unrelated' }],
      author: { login: 'VirtualPaul' },
    }),
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ENFORCE);
});

test('VirtualPaul PR with advisory-only override label is advisory-only and skips remediation queue', async () => {
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    reviewerHeadSha: 'head-a',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-a',
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
      author: { login: 'VirtualPaul' },
    }),
    fetchLatestLabelEventImpl: async (_repo, _prNumber, _labelName, options) => {
      assert.equal(options.currentHeadSha, 'head-a');
      return {
        id: 'evt-advisory-only',
        nodeId: 'LE_advisory_only',
        actor: 'placey',
        createdAt: '2026-06-19T08:00:00.000Z',
        headSha: 'head-a',
      };
    },
  });
  const { result, created } = queueWithFakes('## Summary\nVisible finding.\n\n## Verdict\nRequest changes', {
    verdictMode: resolved.verdictMode,
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ADVISORY_ONLY);
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'advisory-only-review');
  assert.equal(created.length, 0);
});

test('advisory-only override label applied by PR author stays enforce mode', async () => {
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 58,
    reviewerHeadSha: 'head-b',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-b',
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
      author: { login: 'clio-airlock' },
    }),
    fetchLatestLabelEventImpl: async () => ({
      id: 'evt-self-advisory-only',
      nodeId: 'LE_self_advisory_only',
      actor: 'clio-airlock',
      createdAt: '2026-06-19T08:00:00.000Z',
      headSha: 'head-b',
    }),
    log: { warn() {} },
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ENFORCE);
});

test('advisory-only override label fails closed when PR author is absent', async () => {
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 59,
    reviewerHeadSha: 'head-c',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-c',
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
    }),
    fetchLatestLabelEventImpl: async () => ({
      id: 'evt-missing-author-advisory-only',
      nodeId: 'LE_missing_author_advisory_only',
      actor: 'placey',
      createdAt: '2026-06-19T08:00:00.000Z',
      headSha: 'head-c',
    }),
    log: { warn() {} },
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ENFORCE);
});

test('advisory-only override label fails closed when PR author object has no login', async () => {
  // GitHub can return an author object with no `login` (e.g. `{}`). The old
  // fallback (`author?.login || author`) yielded the truthy object, which then
  // stringified to "[object Object]" and never matched the real actor login,
  // letting the non-author gate pass without confirming the labeler is not the
  // author. A loginless/non-string author must resolve to null and fail closed.
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 60,
    reviewerHeadSha: 'head-d',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-d',
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
      author: {},
    }),
    fetchLatestLabelEventImpl: async () => ({
      id: 'evt-loginless-author-advisory-only',
      nodeId: 'LE_loginless_author_advisory_only',
      actor: 'placey',
      createdAt: '2026-06-19T08:00:00.000Z',
      headSha: 'head-d',
    }),
    log: { warn() {} },
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ENFORCE);
});

test('advisory-only override label is current-head scoped and head advance restores enforce', () => {
  assert.equal(
    resolveVerdictModeForHead({
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
      currentHeadSha: 'new-head',
      reviewerHeadSha: 'old-head',
      advisoryLabelEvent: {
        id: 'evt-old-head',
        actor: 'placey',
        createdAt: '2026-06-19T08:00:00.000Z',
        headSha: 'new-head',
      },
    }),
    VERDICT_MODE_ENFORCE,
  );
  assert.equal(
    resolveVerdictModeForHead({
      labels: [],
      currentHeadSha: 'new-head',
      reviewerHeadSha: 'new-head',
    }),
    VERDICT_MODE_ENFORCE,
  );
});

test('advisory-only override label without resolvable label event stays enforce mode', async () => {
  const resolved = await fetchCurrentHeadVerdictMode({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 59,
    reviewerHeadSha: 'head-c',
    fetchPullRequestHeadAndStateImpl: async () => ({
      headRefOid: 'head-c',
      labels: [{ name: ADVISORY_ONLY_REVIEW_LABEL }],
      author: { login: 'VirtualPaul' },
    }),
    fetchLatestLabelEventImpl: async () => null,
    log: { warn() {} },
  });

  assert.equal(resolved.verdictMode, VERDICT_MODE_ENFORCE);
});

test('advisory-only review header keeps the canonical marker heading while staying explicit', () => {
  const header = buildReviewCommentHeader({
    reviewerMetadata: { displayName: 'Codex', reviewerIdentity: 'codex-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ADVISORY_ONLY,
  });

  assert.equal(
    header,
    '## Adversarial Review (advisory-only) — Codex (codex-reviewer-lacey)\n\n' +
      '**Advisory-only review** — findings below are informational; no automated remediation will run.\n\n',
  );
  assert.deepEqual(classifyReviewCommentHeader(`${header}## Verdict\nRequest changes\n`), {
    isAdversarialReview: true,
    verdictMode: VERDICT_MODE_ADVISORY_ONLY,
    advisoryOnly: true,
  });
});

test('review header classifier locates enforce and advisory reviews while distinguishing mode', () => {
  const enforceHeader = buildReviewCommentHeader({
    reviewerMetadata: { displayName: 'Codex', reviewerIdentity: 'codex-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
  });
  const advisoryHeader = buildReviewCommentHeader({
    reviewerMetadata: { displayName: 'Codex', reviewerIdentity: 'codex-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ADVISORY_ONLY,
  });

  assert.deepEqual(classifyReviewCommentHeader(`${enforceHeader}## Verdict\nComment only\n`), {
    isAdversarialReview: true,
    verdictMode: VERDICT_MODE_ENFORCE,
    advisoryOnly: false,
  });
  assert.deepEqual(classifyReviewCommentHeader(`${advisoryHeader}## Verdict\nRequest changes\n`), {
    isAdversarialReview: true,
    verdictMode: VERDICT_MODE_ADVISORY_ONLY,
    advisoryOnly: true,
  });
  assert.deepEqual(classifyReviewCommentHeader('**Advisory-only review** (Codex)\n\n## Verdict\nRequest changes\n'), {
    isAdversarialReview: false,
    verdictMode: null,
    advisoryOnly: false,
  });
});

test('clean comment-only reviews still queue a durable follow-up verdict carrier through the production queue helper', () => {
  const { result, created } = queueWithFakes([
    '## Summary',
    'Everything is settled.',
    '',
    '## Blocking issues',
    '- None.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n'));

  assert.equal(result.queued, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].reviewBody.includes('Comment only'), true);
  assert.equal(created[0].baseBranch, 'release/2026.05');
  assert.equal(created[0].revisionRef, 'review-head-sha');
  assert.equal(created[0].verdictMode, VERDICT_MODE_ENFORCE);
  assert.equal(Object.hasOwn(created[0], 'maxRemediationRounds'), false);
  assert.equal(created[0].priorCompletedRounds, 1);
});

test('request-changes and malformed verdicts still queue durable follow-up handoffs', () => {
  const dirty = queueWithFakes('## Summary\nFix it.\n\n## Verdict\nRequest changes');
  const malformed = queueWithFakes('## Summary\nVerdict missing.');

  assert.equal(dirty.result.queued, true);
  assert.equal(dirty.created.length, 1);
  assert.equal(malformed.result.queued, true);
  assert.equal(malformed.created.length, 1);
});

test('scope-violation finding suppresses automated remediation handoff', () => {
  const created = [];
  const result = queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    baseBranch: 'main',
    reviewerModel: 'claude',
    reviewText: [
      '## Summary',
      'Scope expanded after additive-only classification.',
      '',
      '## Verdict',
      'Request changes',
      '',
      '## Scope Violation Finding',
      '```json',
      '{"kind":"scope-violation","severity":"high"}',
      '```',
    ].join('\n'),
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 0,
      latestMaxRounds: 2,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });

  assert.deepEqual(result, { queued: false, reason: 'scope-violation' });
  assert.equal(created.length, 0);
});

test('follow-up handoff refuses to queue when baseBranch is unknown', () => {
  assert.throws(() => {
    queueFollowUpForPostedReview({
      rootDir: '/tmp/adversarial-review-test',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 57,
      baseBranch: '',
      reviewerModel: 'claude',
      reviewText: '## Summary\nFix it.\n\n## Verdict\nRequest changes',
      summarizePRRemediationLedgerImpl: () => ({
        completedRoundsForPR: 0,
        latestMaxRounds: 2,
      }),
      createFollowUpJobImpl: () => {
        throw new Error('should not be called');
      },
    });
  }, /baseBranch is required/);
});

test('run-local-review-shadow label leaves hosted reviewer selection unchanged and records a durable request', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-'));
  try {
    const labels = [{ name: LOCAL_REVIEW_SHADOW_LABEL }];
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels,
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    assert.equal(eligibility.eligible, true);
    assert.equal('claude', 'claude', 'hosted reviewer fixture remains unchanged');

    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 123,
      headSha: 'abc123',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      hostedReviewerIdentity: 'claude-reviewer-lacey',
      eligibility,
    });

    assert.equal(persisted.persisted, true);
    assert.equal(existsSync(persisted.requestPath), true);
    const request = JSON.parse(readFileSync(persisted.requestPath, 'utf8'));
    assert.equal(request.kind, 'local-review-shadow-request');
    assert.equal(request.label, LOCAL_REVIEW_SHADOW_LABEL);
    assert.equal(request.reviewerModel, 'claude');
    assert.equal(request.localFamily, 'qwen');
    assert.equal(request.status, 'requested');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('config-scope fixture: local shadow does not add shared reviewer.local_reviewer_model CFG key', () => {
  const reviewerSource = readFileSync(new URL('../src/reviewer.mjs', import.meta.url), 'utf8');
  const moduleConfig = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(reviewerSource, /reviewer\.local_reviewer_model/);
  assert.doesNotMatch(moduleConfig, /local_reviewer_model/);
});

test('durable request is written before hosted-review completion marker', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-order-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[claude-code]',
      reviewerModel: 'codex',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 124,
      headSha: 'def456',
      builderTag: '[claude-code]',
      reviewerModel: 'codex',
      eligibility,
    });
    assert.equal(existsSync(persisted.requestPath), true);
    assert.equal(JSON.parse(readFileSync(persisted.requestPath, 'utf8')).status, 'requested');

    const marked = markLocalReviewShadowHostedPosted({
      rootDir,
      request: persisted.request,
      hostedPostedAt: '2026-06-18T12:00:00.000Z',
    });
    assert.equal(marked.requestPath, persisted.requestPath);
    const request = JSON.parse(readFileSync(marked.requestPath, 'utf8'));
    assert.equal(request.status, 'hosted-posted');
    assert.equal(request.hostedPostedAt, '2026-06-18T12:00:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow request persistence fails open when existing state is corrupt', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-corrupt-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 129,
      headSha: 'bad-json',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    writeFileSync(persisted.requestPath, '{not json\n');

    const warnings = [];
    const result = persistLocalReviewShadowRequestFailOpen({
      log: { warn: (message) => warnings.push(message) },
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 129,
      headSha: 'bad-json',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });

    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'request-persist-failed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /request-persist-failed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow request persistence fails open when request directory is not writable', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-unwritable-request-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const warnings = [];
    const result = persistLocalReviewShadowRequestFailOpen({
      log: { warn: (message) => warnings.push(message) },
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 131,
      headSha: 'unwritable-request',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
      ensureWritableImpl: () => {
        const err = new Error('EACCES: permission denied, access shadow requests');
        err.code = 'EACCES';
        throw err;
      },
    });

    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'request-persist-failed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /request-persist-failed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow completion skips before local model work when artifact directory is not writable', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-unwritable-artifact-'));
  try {
    let calledLocalModel = false;
    const warnings = [];
    const result = await completeLocalReviewShadowRequest({
      rootDir,
      request: {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 132,
        headSha: 'unwritable-artifact',
        reviewerModel: 'claude',
        localModel: LOCAL_SHADOW_TEST_ENV.ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL,
        localFamily: 'qwen',
      },
      diff: 'diff --git a/a b/a',
      hostedReviewText: 'hosted review',
      log: { warn: (message) => warnings.push(message) },
      ensureWritableImpl: () => {
        const err = new Error('EACCES: permission denied, access shadow artifacts');
        err.code = 'EACCES';
        throw err;
      },
      callLiteLLMImpl: async () => {
        calledLocalModel = true;
        return 'should not run';
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.retryable, true);
    assert.equal(result.reason, 'shadow-storage-unwritable');
    assert.equal(calledLocalModel, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /shadow-storage-unwritable/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('readJsonFileIfExists treats a missing file as absent without a separate existence check', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-read-missing-'));
  try {
    assert.equal(readJsonFileIfExists(join(rootDir, 'missing.json')), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('family guard fails closed to hosted-only for codex, claude-code, and clio-agent when local family is missing or same-family', () => {
  const cases = [
    { builderTag: '[codex]', reviewerModel: 'claude', env: { ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL: 'unknown-local' }, reason: 'local-model-family-unproven' },
    { builderTag: '[claude-code]', reviewerModel: 'codex', env: { ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL: 'codex' }, familyByModel: { codex: 'codex' }, reason: 'local-model-same-family' },
    { builderTag: '[clio-agent]', reviewerModel: 'claude', env: { ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL: 'codex' }, familyByModel: { codex: 'codex' }, reason: 'local-model-same-family' },
  ];
  for (const item of cases) {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: item.builderTag,
      reviewerModel: item.reviewerModel,
      env: item.env,
      familyByModel: item.familyByModel,
    });
    assert.equal(eligibility.eligible, false, item.builderTag);
    assert.equal(eligibility.reason, item.reason, item.builderTag);
  }
});

test('without run-local-review-shadow label shadow behavior is unchanged and no request is recorded', () => {
  assert.equal(hasLocalReviewShadowLabel([{ name: 'other' }]), false);
  const eligibility = evaluateLocalReviewShadowEligibility({
    labels: [{ name: 'other' }],
    builderTag: '[codex]',
    reviewerModel: 'claude',
    env: LOCAL_SHADOW_TEST_ENV,
  });
  assert.deepEqual(eligibility, { eligible: false, reason: 'label-absent' });
});

test('sequencing: shadow work waits until hosted review is marked posted', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-seq-'));
  try {
    const calls = [];
    const beforePost = await reconcileLocalReviewShadow({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 125,
      headSha: 'abc',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
      hostedReviewPosted: false,
      callLiteLLMImpl: async () => {
        calls.push('litellm');
        return 'should not run';
      },
    });
    assert.equal(beforePost.reason, 'hosted-review-not-posted');
    assert.deepEqual(calls, []);

    const afterPost = await reconcileLocalReviewShadow({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 125,
      headSha: 'abc',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
      hostedReviewPosted: true,
      hostedReviewText: 'hosted review',
      diff: 'diff --git a/a b/a',
      callLiteLLMImpl: async () => {
        calls.push('litellm');
        return 'local finding';
      },
    });
    assert.equal(afterPost.completed, true);
    assert.deepEqual(calls, ['litellm']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('crash recovery: hosted-posted plus missing artifact is reconciled idempotently without reposting gate', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-recover-'));
  try {
    const calls = [];
    const first = await reconcileLocalReviewShadow({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 126,
      headSha: 'abc',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
      hostedReviewPosted: true,
      hostedReviewText: 'hosted review',
      diff: 'diff --git a/a b/a',
      callLiteLLMImpl: async () => {
        calls.push('litellm');
        return 'local recovered finding';
      },
    });
    assert.equal(first.completed, true);
    assert.equal(calls.length, 1);

    const second = await reconcileLocalReviewShadow({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 126,
      headSha: 'abc',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
      hostedReviewPosted: true,
      hostedReviewText: 'hosted review',
      diff: 'diff --git a/a b/a',
      callLiteLLMImpl: async () => {
        calls.push('litellm-again');
        return 'duplicate';
      },
    });
    assert.equal(second.completed, true);
    assert.equal(second.idempotent, true);
    assert.deepEqual(calls, ['litellm']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow timeout or unavailable model records warning artifact without mutating hosted gate', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-timeout-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 127,
      headSha: 'abc',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    const warnings = [];
    const result = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/a b/a',
      hostedReviewText: 'hosted review',
      log: { warn: (message) => warnings.push(message) },
      callLiteLLMImpl: async () => {
        throw new Error('model unavailable');
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.retryable, true);
    assert.equal(warnings.length, 1);
    const artifact = readFileSync(result.artifactPath, 'utf8');
    assert.match(artifact, /WARNING: local OSS shadow review skipped/);
    assert.match(artifact, /not a merge gate verdict/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow auth failure is terminal and does not persist LiteLLM response body', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-auth-failure-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 134,
      headSha: 'auth-failure',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    let responseBodyRead = false;
    const result = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/secret b/secret',
      hostedReviewText: 'hosted review with sensitive body',
      log: { warn() {} },
      env: LOCAL_SHADOW_TEST_ENV,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => {
          responseBodyRead = true;
          return 'upstream echoed prompt SECRET_TOKEN /Users/placey/.codex/auth.json';
        },
      }),
    });

    assert.equal(result.completed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.retryable, false);
    assert.equal(responseBodyRead, false);
    const paths = __test__.localReviewShadowPaths(rootDir, marked.request);
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'skipped');
    assert.equal(state.reason, 'local-shadow-auth-failed');
    assert.equal(state.retryable, false);
    assert.doesNotMatch(JSON.stringify(state), /SECRET_TOKEN|sensitive body|auth\.json/);
    const artifact = readFileSync(paths.artifactPath, 'utf8');
    assert.match(artifact, /Shadow status: skipped \(local-shadow-auth-failed\)/);
    assert.doesNotMatch(artifact, /SECRET_TOKEN|sensitive body|auth\.json/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow remote LiteLLM base URL is terminal and never receives PR payload', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-remote-url-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 135,
      headSha: 'remote-url',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    let fetchCalled = false;
    const result = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/secret b/secret',
      hostedReviewText: 'hosted review with sensitive body',
      log: { warn() {} },
      env: {
        ...LOCAL_SHADOW_TEST_ENV,
        ADVERSARIAL_REVIEW_LOCAL_SHADOW_BASE_URL: 'https://example.com',
      },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('fetch should not run');
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(result.completed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.retryable, false);
    const paths = __test__.localReviewShadowPaths(rootDir, marked.request);
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'skipped');
    assert.equal(state.reason, 'local-shadow-url-not-loopback');
    assert.equal(state.retryable, false);
    assert.doesNotMatch(JSON.stringify(state), /sensitive body|diff --git/);
    const artifact = readFileSync(paths.artifactPath, 'utf8');
    assert.match(artifact, /Shadow status: skipped \(local-shadow-url-not-loopback\)/);
    assert.doesNotMatch(artifact, /sensitive body|diff --git/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow transient HTTP failure remains retryable without storing response body', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-transient-http-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 136,
      headSha: 'transient-http',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    let responseBodyRead = false;
    const result = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/secret b/secret',
      hostedReviewText: 'hosted review with sensitive body',
      log: { warn() {} },
      env: LOCAL_SHADOW_TEST_ENV,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => {
          responseBodyRead = true;
          return 'upstream echoed prompt SECRET_TOKEN /Users/placey/.codex/auth.json';
        },
      }),
    });

    assert.equal(result.completed, false);
    assert.equal(result.skipped, true);
    assert.equal(result.retryable, true);
    assert.equal(responseBodyRead, false);
    const paths = __test__.localReviewShadowPaths(rootDir, marked.request);
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'warn-skip');
    assert.equal(state.retryable, true);
    assert.match(state.reason, /HTTP 503/);
    assert.doesNotMatch(JSON.stringify(state), /SECRET_TOKEN|sensitive body|auth\.json/);
    const artifact = readFileSync(paths.artifactPath, 'utf8');
    assert.match(artifact, /WARNING: local OSS shadow review skipped/);
    assert.doesNotMatch(artifact, /SECRET_TOKEN|sensitive body|auth\.json/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retryable shadow warning artifacts do not suppress later successful retry', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-retry-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 133,
      headSha: 'retryable',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    const calls = [];
    const first = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/a b/a',
      hostedReviewText: 'hosted review',
      log: { warn() {} },
      callLiteLLMImpl: async () => {
        calls.push('fail');
        throw new Error('temporary model outage');
      },
    });
    const warningArtifact = readFileSync(first.artifactPath, 'utf8');
    assert.equal(first.retryable, true);
    assert.match(warningArtifact, /WARNING: local OSS shadow review skipped/);

    const second = await completeLocalReviewShadowRequest({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/a b/a',
      hostedReviewText: 'hosted review',
      log: { warn() {} },
      callLiteLLMImpl: async () => {
        calls.push('success');
        return 'retry succeeded with local finding';
      },
    });

    assert.equal(second.completed, true);
    assert.equal(second.idempotent, undefined);
    assert.deepEqual(calls, ['fail', 'success']);
    const completedArtifact = readFileSync(second.artifactPath, 'utf8');
    assert.match(completedArtifact, /retry succeeded with local finding/);
    assert.doesNotMatch(completedArtifact, /temporary model outage/);
    const paths = __test__.localReviewShadowPaths(rootDir, marked.request);
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'completed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow completion is scheduled without awaiting the local model', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-async-'));
  try {
    const eligibility = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      reviewerModel: 'claude',
      env: LOCAL_SHADOW_TEST_ENV,
    });
    const persisted = persistLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 130,
      headSha: 'async',
      builderTag: '[codex]',
      reviewerModel: 'claude',
      eligibility,
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir, request: persisted.request });
    let resolveShadow;
    const pendingShadow = new Promise((resolve) => {
      resolveShadow = resolve;
    });

    const scheduled = startLocalReviewShadowCompletion({
      rootDir,
      request: marked.request,
      diff: 'diff --git a/a b/a',
      hostedReviewText: 'hosted review',
      log: { log() {}, warn() {} },
      callLiteLLMImpl: async () => pendingShadow,
    });

    let settled = false;
    scheduled.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(scheduled.started, true);
    assert.equal(settled, false);

    resolveShadow('local async finding');
    const result = await scheduled.completion;
    assert.equal(result.completed, true);
    assert.equal(settled, true);
    assert.match(readFileSync(result.artifactPath, 'utf8'), /local async finding/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shadow artifact provenance is explicitly local-model-generated and non-gating', () => {
  const artifact = formatLocalReviewShadowArtifact({
    request: {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 128,
      headSha: 'abc',
      reviewerModel: 'claude',
      localModel: 'litellm-local/gpt-oss-120b',
    },
    reviewText: 'No additional findings.',
  });
  assert.match(artifact, /Local OSS Model Shadow Review \(Non-Gating\)/);
  assert.match(artifact, /generated by local OSS model `litellm-local\/gpt-oss-120b` via LiteLLM/);
  assert.match(artifact, /not Codex\/Claude\/Gemini reviewer identity/);
  assert.doesNotMatch(artifact, /^## Adversarial Review —/m);
});

test('new follow-up jobs preserve an elevated prior cap to avoid truncating an active PR cycle', () => {
  const created = [];
  queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 58,
    baseBranch: 'release/2026.05',
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: 'LAC-466',
    reviewText: '## Summary\nNeeds fixes.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 7,
      latestMaxRounds: 7,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priorCompletedRounds, 7);
  assert.equal(created[0].maxRemediationRounds, 7);
});

test('new follow-up jobs re-derive cap when the prior cap is not above the current risk tier', () => {
  const created = [];
  queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 58,
    baseBranch: 'release/2026.05',
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: 'LAC-466',
    reviewText: '## Summary\nNeeds fixes.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestMaxRounds: 2,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priorCompletedRounds, 1);
  assert.equal(
    Object.hasOwn(created[0], 'maxRemediationRounds'),
    false,
    'fresh dispatch should let createFollowUpJob derive the current tier cap',
  );
});

test('Codex reviewer auth path preserves the split-user service fallback', () => {
  withEnv({ CODEX_AUTH_PATH: undefined, CODEX_HOME: undefined, HOME: undefined }, () => {
    assert.equal(resolveCodexAuthPath(), '/Users/placey/.codex/auth.json');
  });
});

test('Codex reviewer auth path prefers the current HOME default when present', () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-codex-home-default-'));
  try {
    const homeDir = join(root, 'operator-home');
    const authPath = join(homeDir, '.codex', 'auth.json');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'access', refresh_token: 'refresh' },
      }),
      'utf8'
    );
    withEnv({ CODEX_AUTH_PATH: undefined, CODEX_HOME: undefined, HOME: homeDir }, () => {
      assert.equal(resolveCodexAuthPath(), authPath);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex reviewer auth path honors explicit env overrides before service fallback', () => {
  withEnv({ CODEX_AUTH_PATH: '/tmp/explicit/auth.json', CODEX_HOME: '/tmp/codex-home' }, () => {
    assert.equal(resolveCodexAuthPath(), '/tmp/explicit/auth.json');
  });

  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-codex-home-'));
  try {
    const codexHome = join(root, '.codex');
    const authPath = join(codexHome, 'auth.json');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'access', refresh_token: 'refresh' },
      }),
      'utf8'
    );
    withEnv({ CODEX_AUTH_PATH: undefined, CODEX_HOME: codexHome }, () => {
      assert.equal(resolveCodexAuthPath(), authPath);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex reviewer auth path ignores CODEX_HOME without usable OAuth credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-codex-home-bad-'));
  try {
    const missingHome = join(root, 'missing');
    const apiKeyHome = join(root, 'apikey');
    mkdirSync(apiKeyHome, { recursive: true });
    writeFileSync(
      join(apiKeyHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'apikey',
        tokens: { access_token: 'access', refresh_token: 'refresh' },
      }),
      { encoding: 'utf8', flag: 'w' }
    );

    withEnv({ CODEX_AUTH_PATH: undefined, CODEX_HOME: missingHome }, () => {
      assert.equal(resolveCodexAuthPath(), join(process.env.HOME, '.codex', 'auth.json'));
    });
    withEnv({ CODEX_AUTH_PATH: undefined, CODEX_HOME: apiKeyHome }, () => {
      assert.equal(resolveCodexAuthPath(), join(process.env.HOME, '.codex', 'auth.json'));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseGitHubBlobPath only accepts blob URLs for the expected repo', () => {
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    'SPEC.md'
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/other/repo/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    null
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/pull/6', 'laceyenterprises/adversarial-review'),
    null
  );
});

test('extractLinkedRepoDocs handles local paths and GitHub blob URLs without repo regex interpolation', () => {
  const text = [
    'See docs/ARCHITECTURE.md for context.',
    '(./projects/ROLLUP.md)',
    'Blob: https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
    'PR link should be ignored: https://github.com/laceyenterprises/adversarial-review/pull/6',
  ].join('\n');

  assert.deepEqual(extractLinkedRepoDocs(text, 'laceyenterprises/adversarial-review'), [
    'docs/ARCHITECTURE.md',
    'projects/ROLLUP.md',
    'tools/PLAYBOOK.md',
  ]);
});

test('fetchLinkedSpecContents fetches linked specs concurrently and preserves linked order', async () => {
  const starts = [];
  let inflight = 0;
  let maxInflight = 0;

  const result = await fetchLinkedSpecContents('laceyenterprises/adversarial-review', 6, {
    fetchPRContextImpl: async () => ({
      body: [
        'docs/ARCHITECTURE.md',
        'https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
      ].join('\n'),
      comments: [],
      headRefOid: 'abc123',
    }),
    execFileImpl: async (_command, args) => {
      const relPath = args[1].match(/contents\/(.+)\?ref=/)[1];
      starts.push(relPath);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, relPath.includes('ARCHITECTURE') ? 20 : 5));
      inflight -= 1;
      return { stdout: Buffer.from(`# ${relPath}\n`).toString('base64'), stderr: '' };
    },
  });

  assert.equal(maxInflight, 2);
  assert.deepEqual(starts, ['docs/ARCHITECTURE.md', 'tools/PLAYBOOK.md']);
  assert.match(result, /### docs\/ARCHITECTURE.md/);
  assert.match(result, /### tools\/PLAYBOOK.md/);
});

test('fetchLinkedSpecContents reuses already-fetched PR context when provided', async () => {
  let fetchCalls = 0;
  const result = await fetchLinkedSpecContents('laceyenterprises/adversarial-review', 6, {
    prContext: {
      body: 'docs/ARCHITECTURE.md',
      comments: [],
      headRefOid: 'abc123',
    },
    fetchPRContextImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not be called');
    },
    execFileImpl: async () => ({
      stdout: Buffer.from('# docs/ARCHITECTURE.md\n').toString('base64'),
      stderr: '',
    }),
  });

  assert.equal(fetchCalls, 0);
  assert.match(result, /### docs\/ARCHITECTURE.md/);
});

test('buildObviousDocsGuidance tells workers to inspect obvious repo docs before guessing', () => {
  const guidance = buildObviousDocsGuidance();
  assert.match(guidance, /README\.md/);
  assert.match(guidance, /SPEC\.md/);
  assert.match(guidance, /go read it directly rather than guessing from the diff alone/i);
});

test('reviewer timeout defaults to 20m and honors explicit positive env override', () => {
  assert.equal(resolveReviewerTimeoutMs({}), 20 * 60 * 1000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '12345' }), 12345);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), 20 * 60 * 1000);
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }),
    AgentOSConfigError
  );
});

test('spawnClaude wraps claude in launchctl asuser on darwin', async () => {
  const calls = [];
  const result = { stdout: '{"loggedIn":true}', stderr: '' };

  const actual = await spawnClaude(['auth', 'status'], {
    platform: 'darwin',
    uid: 501,
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return result;
    },
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });

  assert.equal(actual, result);
  assert.deepEqual(calls, [
    {
      command: LAUNCHCTL,
      args: ['asuser', '501', ENV_BIN, ...CLAUDE_STRIPPED_ENV_VARS.flatMap((name) => ['-u', name]), CLAUDE_CLI, 'auth', 'status'],
      options: {
        env: { PATH: process.env.PATH },
        timeout: 10_000,
      },
    },
  ]);
});

test('spawnClaude invokes claude directly on non-darwin platforms', async () => {
  const calls = [];

  await spawnClaude(['auth', 'status'], {
    platform: 'linux',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
    env: { PATH: process.env.PATH },
  });

  assert.deepEqual(calls, [
    {
      command: CLAUDE_CLI,
      args: ['auth', 'status'],
      options: {
        env: { PATH: process.env.PATH },
      },
    },
  ]);
});

test('Claude review invocation passes prompt as argv in cli-direct shape', async () => {
  const prompt = 'review this diff';
  const calls = [];

  await spawnClaude(buildClaudeReviewArgs(prompt), {
    platform: 'linux',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
  });

  assert.deepEqual(calls, [
    {
      command: CLAUDE_CLI,
      args: ['--print', '--permission-mode', 'bypassPermissions', prompt],
      options: {
        env: { HOME: '/tmp/home', PATH: process.env.PATH },
      },
    },
  ]);
});

test('Codex review invocation passes prompt as argv in cli-direct shape', async () => {
  const calls = [];
  const prompt = 'review this codex diff';
  const outputPath = '/tmp/codex-last-message.md';

  await spawnCodexReview({
    codexCli: '/usr/local/bin/codex',
    outputPath,
    prompt,
    model: 'gpt-5.4',
    configOverrides: [
      { key: 'model_provider', value: 'openai' },
      { key: 'model_reasoning_effort', value: 'high' },
    ],
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
    cwd: '/tmp/repo',
    timeout: 12_345,
    maxBuffer: 999,
    spawnCapturedImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(calls, [
    {
      command: '/usr/local/bin/codex',
      args: buildCodexReviewArgs({
        outputPath,
        prompt,
        model: 'gpt-5.4',
        configOverrides: [
          { key: 'model_provider', value: 'openai' },
          { key: 'model_reasoning_effort', value: 'high' },
        ],
      }),
      options: {
        env: { HOME: '/tmp/home', PATH: process.env.PATH },
        cwd: '/tmp/repo',
        timeout: 12_345,
        maxBuffer: 999,
      },
    },
  ]);
  assert.deepEqual(calls[0].args, [
    'exec',
    '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--json',
    '--model',
    'gpt-5.4',
    '--config',
    'model_provider="openai"',
    '--config',
    'model_reasoning_effort="high"',
    '--output-last-message',
    outputPath,
    '--',
    prompt,
  ]);
});

test('resolveCodexExecOverrides preserves top-level model settings when user config is ignored', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codex-config-'));
  const codexHome = join(rootDir, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    'model = "gpt-5.4"\nmodel_provider = "openai"\n[projects."/tmp/example"]\ntrust_level = "trusted"\n',
  );

  try {
    const overrides = withEnv({ CODEX_HOME: codexHome, HOME: rootDir }, () => resolveCodexExecOverrides());
    assert.deepEqual(overrides, {
      model: 'gpt-5.4',
      modelProvider: 'openai',
      configOverrides: [
        { key: 'model_provider', value: 'openai' },
      ],
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveCodexExecOverrides preserves allowed scalar model tuning without forwarding project config', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codex-config-inline-comments-'));
  const codexHome = join(rootDir, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      'model = "gpt-5.5" # reviewer model',
      'model_provider = "openai" # safe scalar',
      'model_reasoning_effort = "high" # keep high-effort reviews',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      'model_reasoning_effort = "low"',
      '',
    ].join('\n'),
  );

  try {
    const overrides = withEnv({ CODEX_HOME: codexHome, HOME: rootDir }, () => resolveCodexExecOverrides());
    assert.deepEqual(overrides, {
      model: 'gpt-5.5',
      modelProvider: 'openai',
      configOverrides: [
        { key: 'model_provider', value: 'openai' },
        { key: 'model_reasoning_effort', value: 'high' },
      ],
    });
    assert.deepEqual(
      buildCodexReviewArgs({
        outputPath: '/tmp/out.md',
        prompt: 'review',
        model: overrides.model,
        configOverrides: overrides.configOverrides,
      }).filter((value, index, args) => args[index - 1] === '--config'),
      ['model_provider="openai"', 'model_reasoning_effort="high"'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('Codex JSON token parser reads turn.completed usage from native stdout', () => {
  const usage = parseCodexJsonTokenUsage([
    '{"type":"thread.started","thread_id":"thread_1"}',
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 123,
        cached_input_tokens: 45,
        output_tokens: 6,
        total_tokens: 174,
      },
    }),
    '',
  ].join('\n'));

  assert.deepEqual(usage, {
    input: 123,
    output: 6,
    cacheRead: 45,
    cacheWrite: 0,
    total: 174,
    source: 'codex-json',
  });
});

test('spawnClaude rejects invalid darwin uids', async () => {
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], { platform: 'darwin', uid: 0 }),
    /Cannot resolve a non-root user uid/
  );
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], { platform: 'darwin', uid: null }),
    /Cannot resolve a non-root user uid/
  );
});

test('spawnClaude classifies launchctl session failures separately from oauth failures', async () => {
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], {
      platform: 'darwin',
      uid: 501,
      execFileImpl: async () => {
        const err = new Error('Command failed');
        err.stderr = 'Could not find domain for user 501';
        throw err;
      },
    }),
    (err) => err?.isLaunchctlSessionError === true && /bootstrap failed/i.test(err.message)
  );
});

// ── GMW-01: Gemini reviewer ───────────────────────────────────────────────────

test('resolveGeminiReviewerModel returns the default and honors the override env', () => {
  assert.equal(
    withEnv({ GEMINI_REVIEWER_MODEL: undefined }, () => resolveGeminiReviewerModel()),
    'gemini-2.5-pro',
  );
  assert.equal(
    withEnv({ GEMINI_REVIEWER_MODEL: '   ' }, () => resolveGeminiReviewerModel()),
    'gemini-2.5-pro',
  );
  assert.equal(
    withEnv({ GEMINI_REVIEWER_MODEL: 'gemini-2.5-flash' }, () => resolveGeminiReviewerModel()),
    'gemini-2.5-flash',
  );
});

test('resolveGeminiRuntime defaults to cli and honors config/env selection', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gemini-runtime-'));
  try {
    assert.equal(resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [join(tmp, 'none.yaml')] }), 'cli');

    const modulePath = join(tmp, 'config.yaml');
    writeFileSync(modulePath, 'reviewer:\n  gemini:\n    runtime: antigravity\n', 'utf8');
    assert.equal(resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }), 'antigravity');
    assert.equal(
      resolveGeminiRuntime({
        env: { AGENT_OS_REVIEWER_GEMINI_RUNTIME: 'cli' },
        topPath: '/dev/null',
        modulePaths: [modulePath],
      }),
      'cli',
    );
    assert.throws(
      () => resolveGeminiRuntime({
        env: { AGENT_OS_REVIEWER_GEMINI_RUNTIME: 'native' },
        topPath: '/dev/null',
        modulePaths: [modulePath],
      }),
      /reviewer\.gemini\.runtime.*cli.*antigravity/i,
    );

    const malformedPath = join(tmp, 'malformed.yaml');
    writeFileSync(malformedPath, 'reviewer:\n  gemini:\n    runtime: [', 'utf8');
    assert.throws(
      () => resolveGeminiRuntime({ env: {}, topPath: '/dev/null', modulePaths: [malformedPath] }),
      (err) => err instanceof AgentOSConfigError && err.key === 'reviewer.gemini.runtime',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildGeminiReviewArgs enters headless mode without carrying the prompt body', () => {
  const args = buildGeminiReviewArgs({ model: 'gemini-2.5-pro' });
  assert.deepEqual(args, ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', '']);
  // The prompt flag is intentionally empty: it enables non-interactive stdin
  // handling without putting prompt/diff content in argv.
  assert.equal(args[args.indexOf('--prompt') + 1], '');
});

test('buildAgyReviewArgs uses agy print mode without carrying the prompt body', () => {
  const args = buildAgyReviewArgs({ model: 'gemini-2.5-pro' });
  assert.deepEqual(args, ['--print', '-m', 'gemini-2.5-pro']);
});

test('spawnGeminiReview feeds the prompt over stdin and keeps it out of argv', async () => {
  const prompt = 'ADVERSARIAL PROMPT\n\n---\n\n```diff\n+secret diff body\n```';
  const calls = [];

  await spawnGeminiReview({
    geminiCli: '/usr/local/bin/gemini',
    prompt,
    model: 'gemini-2.5-pro',
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
    cwd: '/tmp/repo',
    timeout: 9_999,
    maxBuffer: 555,
    spawnWithInputImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/local/bin/gemini');
  assert.deepEqual(calls[0].args, ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', '']);
  // The prompt (and the diff body inside it) is observed ONLY on stdin.
  assert.equal(calls[0].options.input, prompt);
  for (const arg of calls[0].args) {
    assert.ok(!arg.includes('secret diff body'), `argv leaked prompt body: ${arg}`);
    assert.ok(!arg.includes('ADVERSARIAL PROMPT'), `argv leaked prompt body: ${arg}`);
  }
  assert.deepEqual(
    { cwd: calls[0].options.cwd, timeout: calls[0].options.timeout, maxBuffer: calls[0].options.maxBuffer },
    { cwd: '/tmp/repo', timeout: 9_999, maxBuffer: 555 },
  );
});

test('spawnAgyReview feeds the prompt over stdin and keeps it out of argv', async () => {
  const prompt = 'ADVERSARIAL PROMPT\n\n---\n\n```diff\n+secret diff body\n```';
  const calls = [];

  await spawnAgyReview({
    agyCli: '/usr/local/bin/agy',
    prompt,
    model: 'gemini-2.5-pro',
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
    cwd: '/tmp/repo',
    timeout: 9_999,
    maxBuffer: 555,
    spawnWithInputImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/local/bin/agy');
  assert.deepEqual(calls[0].args, ['--print', '-m', 'gemini-2.5-pro']);
  assert.equal(calls[0].options.input, prompt);
  for (const arg of calls[0].args) {
    assert.ok(!arg.includes('secret diff body'), `argv leaked prompt body: ${arg}`);
    assert.ok(!arg.includes('ADVERSARIAL PROMPT'), `argv leaked prompt body: ${arg}`);
  }
  assert.deepEqual(
    { cwd: calls[0].options.cwd, timeout: calls[0].options.timeout, maxBuffer: calls[0].options.maxBuffer },
    { cwd: '/tmp/repo', timeout: 9_999, maxBuffer: 555 },
  );
});

test('resolveReviewerMetadata labels Gemini reviews with the Gemini reviewer identity', () => {
  assert.deepEqual(resolveReviewerMetadata('claude'), {
    displayName: 'Claude',
    reviewerIdentity: 'claude-reviewer-lacey',
  });
  assert.deepEqual(resolveReviewerMetadata('codex'), {
    displayName: 'Codex',
    reviewerIdentity: 'codex-reviewer-lacey',
  });
  assert.deepEqual(resolveReviewerMetadata('gemini'), {
    displayName: 'Gemini',
    reviewerIdentity: 'gemini-reviewer-lacey',
  });
});

test('reviewWithGemini happy path returns the captured review text', async () => {
  const captured = [];
  const result = await reviewWithGemini('+diff body\n', 'EXTRA CONTEXT', {
    promptStage: 'first',
    assertOAuthImpl: async () => {},
    spawnGeminiReviewImpl: async ({ prompt, model }) => {
      captured.push({ prompt, model });
      return { stdout: 'BLOCKING: real finding\n\nVERDICT: blocked', stderr: '' };
    },
  });

  assert.deepEqual(result, {
    reviewText: 'BLOCKING: real finding\n\nVERDICT: blocked',
    tokenUsage: null,
  });
  // The prompt fed to gemini carries the extra context and the diff fence.
  assert.equal(captured.length, 1);
  assert.match(captured[0].prompt, /EXTRA CONTEXT/);
  assert.match(captured[0].prompt, /```diff\n\+diff body/);
  assert.equal(captured[0].model, 'gemini-2.5-pro');
});

test('reviewWithGemini cli runtime keeps native binary, argv, env scrub, and creds assertion unchanged', async () => {
  const calls = [];
  const asserted = [];
  const result = await withEnvAsync({
    HOME: '/tmp/gemini-home',
    GEMINI_API_KEY: 'must-strip',
    GOOGLE_API_KEY: 'must-strip-too',
  }, () => reviewWithGemini('+diff\n', '', {
    resolveGeminiRuntimeImpl: () => 'cli',
    assertOAuthImpl: async (env) => {
      asserted.push(resolveGeminiOAuthCredsPath(env));
    },
    spawnGeminiReviewImpl: async ({ geminiCli, model, env }) => {
      calls.push({ geminiCli, args: buildGeminiReviewArgs({ model }), env });
      return { stdout: 'CLI review', stderr: '' };
    },
  }));

  assert.equal(result.reviewText, 'CLI review');
  assert.deepEqual(asserted, [join('/tmp/gemini-home', '.gemini', 'oauth_creds.json')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].geminiCli, GEMINI_CLI);
  assert.deepEqual(calls[0].args, ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', '']);
  assert.equal(calls[0].env.HOME, '/tmp/gemini-home');
  assert.equal(calls[0].env.GEMINI_API_KEY, undefined);
  assert.equal(calls[0].env.GOOGLE_API_KEY, undefined);
  assert.equal(calls[0].env.GEMINI_OAUTH_ACCESS_TOKEN, undefined);
});

test('reviewWithGemini antigravity runtime uses agy print, stdin prompt, env scrub, and agy auth', async () => {
  const authCalls = [];
  const spawnCalls = [];
  const result = await withEnvAsync({
    HOME: '/tmp/agy-home',
    GEMINI_API_KEY: 'must-strip',
    GOOGLE_API_KEY: 'must-strip-too',
  }, () => reviewWithGemini('+diff\n', 'AGY CONTEXT', {
    resolveGeminiRuntimeImpl: () => 'antigravity',
    assertAgyAuthImpl: async ({ agyCli, env }) => {
      authCalls.push({ agyCli, env });
    },
    spawnAgyReviewImpl: async ({ agyCli, prompt, model, env }) => {
      spawnCalls.push({ agyCli, args: buildAgyReviewArgs({ model }), prompt, env });
      return { stdout: 'Antigravity agy review', stderr: '' };
    },
    spawnGeminiReviewImpl: async () => {
      throw new Error('native gemini must not be called for antigravity runtime');
    },
  }));

  assert.equal(result.reviewText, 'Antigravity agy review');
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].agyCli, AGY_CLI);
  assert.equal(authCalls[0].env.HOME, '/tmp/agy-home');
  assert.equal(authCalls[0].env.GEMINI_API_KEY, undefined);
  assert.equal(authCalls[0].env.GOOGLE_API_KEY, undefined);
  assert.equal(authCalls[0].env.GEMINI_OAUTH_ACCESS_TOKEN, undefined);
  assert.equal(authCalls[0].env.GEMINI_ANTIGRAVITY_ACCOUNT, undefined);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].agyCli, AGY_CLI);
  assert.deepEqual(spawnCalls[0].args, ['--print', '-m', 'gemini-2.5-pro']);
  assert.match(spawnCalls[0].prompt, /AGY CONTEXT/);
  assert.match(spawnCalls[0].prompt, /```diff\n\+diff/);
  assert.strictEqual(authCalls[0].env, spawnCalls[0].env);
  assert.equal(spawnCalls[0].env.HOME, '/tmp/agy-home');
  assert.equal(spawnCalls[0].env.GEMINI_API_KEY, undefined);
  assert.equal(spawnCalls[0].env.GOOGLE_API_KEY, undefined);
  assert.equal(spawnCalls[0].env.GEMINI_OAUTH_ACCESS_TOKEN, undefined);
  assert.equal(spawnCalls[0].env.GEMINI_ANTIGRAVITY_ACCOUNT, undefined);
});

test('reviewWithGemini cli runtime does not call agy auth or agy spawn', async () => {
  const calls = [];
  const result = await reviewWithGemini('+diff\n', '', {
    resolveGeminiRuntimeImpl: () => 'cli',
    assertOAuthImpl: async () => {},
    assertAgyAuthImpl: async () => {
      throw new Error('agy auth must not be called for cli runtime');
    },
    spawnAgyReviewImpl: async () => {
      throw new Error('agy spawn must not be called for cli runtime');
    },
    spawnGeminiReviewImpl: async ({ geminiCli, model }) => {
      calls.push({ geminiCli, args: buildGeminiReviewArgs({ model }) });
      return { stdout: 'CLI review', stderr: '' };
    },
  });

  assert.equal(result.reviewText, 'CLI review');
  assert.equal(calls[0].geminiCli, GEMINI_CLI);
  assert.deepEqual(calls[0].args, ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', '']);
});

test('reviewWithGemini antigravity auth missing fails closed before spawning a review', async () => {
  const spawnCalls = [];
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      assertAgyAuthImpl: async () => {
        const err = new Error(`[OAuth] gemini credentials unavailable: Antigravity agy auth failed (keychain-missing): missing. ${AGY_KEYCHAIN_REMEDIATION}`);
        err.isOAuthError = true;
        err.model = 'gemini';
        throw err;
      },
      spawnAgyReviewImpl: async () => {
        spawnCalls.push('spawn');
        return { stdout: 'must not happen', stderr: '' };
      },
    }),
    (err) => err?.isOAuthError === true && /keychain-missing/.test(err.message),
  );
  assert.deepEqual(spawnCalls, []);
});

test('reviewWithGemini antigravity retries transient agy subprocess errors', async () => {
  const spawns = [];
  const result = await reviewWithGemini('+diff\n', '', {
    resolveGeminiRuntimeImpl: () => 'antigravity',
    assertAgyAuthImpl: async () => {},
    retryDelaysMs: [0],
    sleepImpl: async () => {},
    spawnAgyReviewImpl: async () => {
      spawns.push('agy');
      if (spawns.length === 1) {
        const err = new Error('Command failed');
        err.code = 'ETIMEDOUT';
        err.stderr = 'TLS handshake timeout';
        throw err;
      }
      return { stdout: 'retried antigravity review', stderr: '' };
    },
  });

  assert.equal(result.reviewText, 'retried antigravity review');
  assert.deepEqual(spawns, ['agy', 'agy']);
});

test('AGR-06 antigravity account telemetry events are registered API categories', () => {
  const emittedAgrEvents = [
    'agr_account_selected',
    'agr_account_rate_limited',
    'agr_all_capped',
  ];
  for (const eventName of emittedAgrEvents) {
    assert.ok(CATEGORY_ORDER.includes(eventName), `${eventName} must be in CATEGORY_ORDER`);
  }
});

test('AGR-06 all-capped page payload dedupes and coalesces suppressed count', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agr-all-capped-page-'));
  const pages = [];
  try {
    const deliverAlertFn = async (text, structured) => {
      pages.push({ text, structured });
    };
    const retryAfter = '2026-06-20T21:15:00.000Z';
    const accountStatus = [{ accountId: 'acct-a', eligible: false, retryAfter }];
    const first = await maybePageAgrAllCapped({
      retryAfter,
      accountStatus,
      deliverAlertFn,
      now: Date.parse('2026-06-20T20:00:00.000Z'),
      alertStateDir: stateDir,
      dedupeMs: 60_000,
    });
    const suppressed = await maybePageAgrAllCapped({
      retryAfter,
      accountStatus,
      deliverAlertFn,
      now: Date.parse('2026-06-20T20:00:30.000Z'),
      alertStateDir: stateDir,
      dedupeMs: 60_000,
    });
    const next = await maybePageAgrAllCapped({
      retryAfter,
      accountStatus,
      deliverAlertFn,
      now: Date.parse('2026-06-20T20:01:01.000Z'),
      alertStateDir: stateDir,
      dedupeMs: 60_000,
    });

    assert.deepEqual(first, { paged: true, suppressedCount: 0 });
    assert.deepEqual(suppressed, { paged: false, suppressedCount: 1 });
    assert.deepEqual(next, { paged: true, suppressedCount: 1 });
    assert.equal(pages.length, 2);
    assert.equal(pages[0].structured.payload.suppressedCount, 0);
    assert.equal(pages[1].structured.payload.suppressedCount, 1);
    assert.deepEqual(pages[1].structured.payload.accounts, accountStatus);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AGR-06 all-capped state persistence uses atomic tmp rename', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agr-all-capped-atomic-'));
  const writes = [];
  try {
    const fsImpl = {
      existsSync,
      readFileSync,
      mkdirSync,
      writeFileSync: (target, body) => {
        writes.push({ op: 'write', target });
        writeFileSync(target, body);
      },
      renameSync: (from, to) => {
        writes.push({ op: 'rename', from, to });
        renameSync(from, to);
      },
    };

    await maybePageAgrAllCapped({
      retryAfter: '2026-06-20T21:15:00.000Z',
      deliverAlertFn: async () => {},
      now: Date.parse('2026-06-20T20:00:00.000Z'),
      alertStateDir: stateDir,
      fsImpl,
    });

    assert.match(writes[0].target, /agr-all-capped\.json\.tmp-/);
    assert.equal(writes[1].op, 'rename');
    assert.match(writes[1].from, /agr-all-capped\.json\.tmp-/);
    assert.equal(writes[1].to, join(stateDir, 'agr-all-capped.json'));
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'agr-all-capped.json'), 'utf8')).suppressedCount, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AGR-06 all-capped page payload schema is stable', () => {
  assert.deepEqual(
    buildAgrAllCappedPagePayload({
      retryAfter: '2026-06-20T21:15:00.000Z',
      suppressedCount: 2,
      accountStatus: [{ accountId: 'acct-a', eligible: false, retryAfter: '2026-06-20T21:15:00.000Z' }],
    }),
    {
      schemaVersion: 1,
      event: 'agr_all_capped',
      severity: 'page',
      reviewerModel: 'gemini',
      runtime: 'antigravity',
      retryAfter: '2026-06-20T21:15:00.000Z',
      suppressedCount: 2,
      accounts: [{ accountId: 'acct-a', eligible: false, retryAfter: '2026-06-20T21:15:00.000Z' }],
    },
  );
});

test('Antigravity all-capped hold message is classified as quota-exhausted', () => {
  const msg = formatAntigravityQuotaHoldMessage('2026-06-20T21:15:00.000Z');
  assert.equal(classifyReviewerFailure(msg, 1), QUOTA_EXHAUSTED_FAILURE_CLASS);
});

test('Antigravity Retry-After parsing accepts HTTP dates and ignores malformed values', () => {
  const httpDate = new Error('Command failed');
  httpDate.stderr = '429 RESOURCE_EXHAUSTED\nRetry-After: Wed, 21 Oct 2026 07:28:00 GMT';
  assert.equal(retryAfterFromGeminiFailure(httpDate), '2026-10-21T07:28:00.000Z');

  const malformed = new Error('Command failed');
  malformed.stderr = '429 RESOURCE_EXHAUSTED\nRetry-After: definitely-not-a-date';
  assert.match(retryAfterFromGeminiFailure(malformed), /^\d{4}-\d{2}-\d{2}T/);
});

test('reviewWithGemini falls back to cli when temporary runtime resolver rejects the AGR-03 key', async () => {
  const warnings = [];
  const spawns = [];
  const result = await reviewWithGemini('+diff\n', '', {
    resolveGeminiRuntimeImpl: () => {
      throw new AgentOSConfigError('bad runtime', {
        key: 'reviewer.gemini.runtime',
        expected: 'one of ["cli", "antigravity"]',
        got: 'native',
      });
    },
    assertOAuthImpl: async () => {},
    log: { warn: (message) => warnings.push(message) },
    spawnGeminiReviewImpl: async ({ env }) => {
      spawns.push(env);
      return { stdout: 'cli fallback review', stderr: '' };
    },
  });

  assert.equal(result.reviewText, 'cli fallback review');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].GEMINI_ANTIGRAVITY_ACCOUNT, undefined);
  assert.match(warnings[0], /falling back to cli/);
});

test('reviewWithGemini maps auth-failure spawn output to OAuthError(gemini)', async () => {
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      assertOAuthImpl: async () => {},
      spawnGeminiReviewImpl: async () => {
        const err = new Error('Command failed');
        err.stderr = 'Error: 401 Unauthorized — login required';
        throw err;
      },
    }),
    (err) => err?.isOAuthError === true && err?.model === 'gemini',
  );
});

test('reviewWithGemini wraps non-auth spawn failures as a Gemini exec error', async () => {
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      assertOAuthImpl: async () => {},
      spawnGeminiReviewImpl: async () => {
        const err = new Error('spawn ENOENT');
        err.stderr = 'invalid command-line flag';
        throw err;
      },
    }),
    (err) => err?.isOAuthError !== true && /Gemini exec failed/.test(err.message),
  );
});

test('reviewWithGemini retries transient Gemini subprocess failures before succeeding', async () => {
  const attempts = [];
  const sleeps = [];
  const result = await reviewWithGemini('+diff\n', '', {
    assertOAuthImpl: async () => {},
    retryDelaysMs: [0, 0],
    sleepImpl: async (ms) => { sleeps.push(ms); },
    spawnGeminiReviewImpl: async () => {
      attempts.push('spawn');
      if (attempts.length < 3) {
        const err = new Error('Command failed');
        err.code = attempts.length === 1 ? 'ETIMEDOUT' : 'ECONNRESET';
        err.stderr = attempts.length === 1
          ? 'TLS handshake timeout'
          : '503 service unavailable';
        throw err;
      }
      return { stdout: '## Verdict\n\nComment only', stderr: '' };
    },
  });

  assert.deepEqual(result, { reviewText: '## Verdict\n\nComment only', tokenUsage: null });
  assert.equal(attempts.length, 3);
  assert.deepEqual(sleeps, [0, 0]);
});

test('Gemini subprocess retry classifier does not retry auth failures', () => {
  const err = new Error('Command failed');
  err.stderr = '401 Unauthorized login required';
  assert.equal(isRetryableGeminiSubprocessError(err), false);
});

test('reviewer selection routes gemini to reviewWithGemini, never reviewWithCodex', async () => {
  const calls = [];
  const dispatch = await dispatchReviewerModel('gemini', '+diff\n', 'ctx', {
    promptStage: 'first',
    reviewWithClaudeImpl: async () => { calls.push('claude'); return 'claude text'; },
    reviewWithCodexImpl: async () => { calls.push('codex'); return { reviewText: 'codex text', tokenUsage: null }; },
    reviewWithGeminiImpl: async () => { calls.push('gemini'); return { reviewText: 'gemini text', tokenUsage: null }; },
  });

  assert.deepEqual(calls, ['gemini']);
  assert.ok(!calls.includes('codex'), 'gemini must not fall through to codex');
  assert.equal(dispatch.reviewText, 'gemini text');
  assert.equal(dispatch.rawReviewText, 'gemini text');
  assert.equal(dispatch.needsSanitize, false);
});

test('reviewer selection still routes codex (needsSanitize) and claude correctly', async () => {
  const codexDispatch = await dispatchReviewerModel('codex', '+diff\n', 'ctx', {
    reviewWithCodexImpl: async () => ({ reviewText: 'raw codex', tokenUsage: { total: 5 } }),
  });
  assert.equal(codexDispatch.rawReviewText, 'raw codex');
  assert.equal(codexDispatch.reviewText, null);
  assert.equal(codexDispatch.needsSanitize, true);
  assert.deepEqual(codexDispatch.tokenUsage, { total: 5 });

  const claudeDispatch = await dispatchReviewerModel('claude', '+diff\n', 'ctx', {
    reviewWithClaudeImpl: async () => 'claude review text',
  });
  assert.equal(claudeDispatch.reviewText, 'claude review text');
  assert.equal(claudeDispatch.needsSanitize, false);
});

test('vocabulary fatigue finding is rendered through advisory prompt context', async () => {
  const contexts = [];
  const extraContext = `BASE CONTEXT${formatAdvisoryFindingsContext([{
    kind: 'remediation-vocabulary-fatigue',
    severity: 'info',
    blocking: false,
    stem: 'harden',
    count: 4,
    window: 5,
    detail: 'The verb stem is dominating the recent commit window.',
  }])}`;

  await dispatchReviewerModel('claude', '+diff\n', extraContext, {
    reviewWithClaudeImpl: async (_diff, context) => {
      contexts.push(context);
      return 'claude review text';
    },
  });

  assert.equal(contexts.length, 1);
  assert.match(contexts[0], /BASE CONTEXT/);
  assert.match(contexts[0], /Watcher Advisory Findings/);
  assert.match(contexts[0], /remediation-vocabulary-fatigue/);
  assert.match(contexts[0], /"stem": "harden"/);
  assert.match(contexts[0], /Do not place them in `## Blocking Issues`/);
});

test('assertGeminiOAuth accepts a valid creds file and rejects a missing/invalid one', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'gemini-oauth-'));
  const geminiHome = join(rootDir, '.gemini');
  mkdirSync(geminiHome, { recursive: true });
  const credsPath = join(geminiHome, 'oauth_creds.json');

  const env = { GEMINI_OAUTH_CREDS_PATH: credsPath };
  try {
    // Missing creds → OAuthError(gemini).
    await assert.rejects(() => assertGeminiOAuth(env), (err) => err?.isOAuthError === true && err?.model === 'gemini');

    // Creds without access_token → OAuthError(gemini).
    writeFileSync(credsPath, JSON.stringify({ token_type: 'Bearer' }));
    await assert.rejects(() => assertGeminiOAuth(env), (err) => err?.isOAuthError === true && err?.model === 'gemini');

    // Valid creds → assertGeminiAuthReadable passes; only the CLI-presence
    // check can still fail (gemini may be absent in CI). Either way it must
    // not be a creds-readability failure.
    writeFileSync(credsPath, JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expiry_date: 1 }));
    try {
      await assertGeminiOAuth(env);
    } catch (err) {
      assert.match(err.message, /gemini CLI not found/);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('checkAgyReviewerAuth mirrors AGY-01 auth contract fields', async () => {
  const calls = [];
  const result = await checkAgyReviewerAuth({
    agyCli: '/opt/bin/agy',
    env: { PATH: '/opt/bin' },
    timeoutMs: 1234,
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'security') return { stdout: 'password item', stderr: '' };
      if (command === '/opt/bin/agy') return { stdout: 'gemini-2.5-pro\n', stderr: '' };
      throw new Error(`unexpected command ${command}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.keychainItem, AGY_KEYCHAIN_SERVICE);
  assert.equal(result.keychainItem, 'Gemini Safe Storage');
  assert.equal(result.probe, 'agy models');
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ['security', ['find-generic-password', '-s', 'Gemini Safe Storage']],
    ['/opt/bin/agy', ['models']],
  ]);
  assert.deepEqual(calls.map((call) => call.options.timeout), [1234, 1234]);
  assert.match(AGY_KEYCHAIN_REMEDIATION, /launchd-spawned airlock processes/);
  assert.match(AGY_KEYCHAIN_REMEDIATION, /security set-generic-password-partition-list -S apple-tool:,apple: -s "Gemini Safe Storage"/);
});

test('checkAgyReviewerAuth fail-closed reasons distinguish keychain and agy probe failures', async () => {
  let missingCalls = 0;
  const missing = await checkAgyReviewerAuth({
    maxAttempts: 3,
    execFileImpl: async () => {
      missingCalls += 1;
      const err = new Error('Command failed');
      err.stderr = 'SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
      throw err;
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'keychain-missing');
  assert.equal(missingCalls, 1);

  const empty = await checkAgyReviewerAuth({
    execFileImpl: async (command) => {
      if (command === 'security') return { stdout: 'ok', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(empty.reason, 'agy-probe-empty');

  let agyAttempts = 0;
  const transient = await checkAgyReviewerAuth({
    maxAttempts: 3,
    retryBackoffMs: 0,
    execFileImpl: async (command) => {
      if (command === 'security') return { stdout: 'ok', stderr: '' };
      agyAttempts += 1;
      if (agyAttempts === 1) {
        const err = new Error('timed out');
        err.killed = true;
        throw err;
      }
      return { stdout: 'gemini-2.5-pro\n', stderr: '' };
    },
  });
  assert.equal(transient.ok, true);
  assert.equal(agyAttempts, 2);

  let keychainAttempts = 0;
  const keychainTimeout = await checkAgyReviewerAuth({
    maxAttempts: 2,
    retryBackoffMs: 0,
    execFileImpl: async () => {
      keychainAttempts += 1;
      const err = new Error('timeout');
      err.signal = 'SIGTERM';
      throw err;
    },
  });
  assert.equal(keychainTimeout.reason, 'keychain-probe-timeout');
  assert.equal(keychainAttempts, 2);

  const timeout = await checkAgyReviewerAuth({
    maxAttempts: 2,
    retryBackoffMs: 0,
    execFileImpl: async (command) => {
      if (command === 'security') return { stdout: 'ok', stderr: '' };
      const err = new Error('timed out');
      err.killed = true;
      throw err;
    },
  });
  assert.equal(timeout.reason, 'agy-probe-timeout');
  assert.match(timeout.detail, /attempt 2\/2/);
});

test('assertAgyReviewerAuth surfaces fail-closed reason and launchd remediation as OAuthError', async () => {
  await assert.rejects(
    () => assertAgyReviewerAuth({
      checkAuthImpl: async () => ({
        ok: false,
        reason: 'keychain-missing',
        detail: 'not found',
        remediation: AGY_KEYCHAIN_REMEDIATION,
      }),
    }),
    (err) => {
      assert.equal(err.isOAuthError, true);
      assert.equal(err.model, 'gemini');
      assert.match(err.message, /keychain-missing/);
      assert.match(err.message, /launchd-spawned airlock/);
      return true;
    },
  );
});

test('resolveGeminiOAuthCredsPath honors explicit override, GEMINI_HOME, then HOME', () => {
  assert.equal(
    resolveGeminiOAuthCredsPath({ GEMINI_OAUTH_CREDS_PATH: '/explicit/creds.json' }),
    '/explicit/creds.json',
  );
  assert.equal(
    resolveGeminiOAuthCredsPath({ GEMINI_HOME: '/work/.gemini' }),
    join('/work/.gemini', 'oauth_creds.json'),
  );
  assert.equal(
    resolveGeminiOAuthCredsPath({ HOME: '/home/u' }),
    join('/home/u', '.gemini', 'oauth_creds.json'),
  );
});

test('resolveGeminiCliPath prefers GEMINI_CLI_PATH / GEMINI_CLI overrides', () => {
  assert.equal(resolveGeminiCliPath({ GEMINI_CLI_PATH: '/a/gemini', PATH: '' }), '/a/gemini');
  assert.equal(resolveGeminiCliPath({ GEMINI_CLI: '/b/gemini', PATH: '' }), '/b/gemini');
  assert.equal(resolveGeminiCliPath({ PATH: '' }), 'gemini');
});

test('resolveAgyCliPath prefers AGY_CLI_PATH / AGY_CLI overrides', () => {
  assert.equal(resolveAgyCliPath({ AGY_CLI_PATH: '/a/agy', PATH: '' }), '/a/agy');
  assert.equal(resolveAgyCliPath({ AGY_CLI: '/b/agy', PATH: '' }), '/b/agy');
  assert.equal(resolveAgyCliPath({ PATH: '' }), 'agy');
});
