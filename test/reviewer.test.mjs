import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CLI, __test__ } from '../src/reviewer.mjs';
import { buildObviousDocsGuidance, extractLinkedRepoDocs, fetchLinkedSpecContents, parseGitHubBlobPath } from '../src/prompt-context.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';

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
  spawnCodexReview,
  spawnClaude,
  resolveGeminiCliPath,
  resolveGeminiOAuthCredsPath,
  assertGeminiOAuth,
  resolveGeminiReviewerModel,
  resolveReviewerMetadata,
  buildGeminiReviewArgs,
  isRetryableGeminiSubprocessError,
  spawnGeminiReview,
  reviewWithGemini,
  dispatchReviewerModel,
  LOCAL_REVIEW_SHADOW_LABEL,
  LOCAL_REVIEW_SHADOW_MODEL_ENV,
  hasLocalReviewShadowLabel,
  resolveBuilderFamily,
  resolveLocalShadowModelFamily,
  buildLocalReviewShadowRequest,
  persistLocalReviewShadowRequestBeforeHostedPost,
  markLocalReviewShadowHostedPosted,
  buildLocalReviewShadowSubprocessEnv,
  runLocalReviewShadowRequest,
  reconcileLocalReviewShadow,
  localReviewShadowArtifactPath,
} = __test__;

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

function queueWithFakes(reviewText) {
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

test('run-local-review-shadow label records a durable local shadow request without changing hosted reviewer selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-'));
  try {
    const hostedReviewerModel = 'gemini';
    const result = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 42,
      headSha: 'abc123',
      builderTag: '[codex]',
      hostedReviewerModel,
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
    });

    assert.equal(hostedReviewerModel, 'gemini');
    assert.equal(result.request.hostedReview.reviewerModel, 'gemini');
    assert.equal(result.request.status, 'pending-hosted-review');
    assert.equal(existsSync(result.requestPath), true);
    const persisted = JSON.parse(readFileSync(result.requestPath, 'utf8'));
    assert.equal(persisted.localReview.model, 'ollama/qwen2.5-coder');
    assert.equal(persisted.localReview.family, 'qwen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config-scope fixture keeps local shadow model out of shared CFG keys', () => {
  const cfgContract = readFileSync(join(process.cwd(), 'projects/cfg/LOADER-CONTRACT.md'), 'utf8');
  const checkedInConfig = readFileSync(join(process.cwd(), 'config.yaml'), 'utf8');
  assert.equal(cfgContract.includes('reviewer.local_reviewer_model'), false);
  assert.equal(checkedInConfig.includes('local_reviewer_model'), false);
});

test('local shadow contract is documented in the follow-up runbook', () => {
  const runbook = readFileSync(join(process.cwd(), 'docs/follow-up-runbook.md'), 'utf8');
  assert.match(runbook, /run-local-review-shadow/);
  assert.match(runbook, /ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL/);
  assert.match(runbook, /ADVERSARIAL_REVIEW_LOCAL_SHADOW_TIMEOUT_MS/);
  assert.match(runbook, /data\/local-review-shadow\/requests/);
  assert.match(runbook, /data\/local-review-shadow\/artifacts/);
  assert.match(runbook, /non-gating/);
});

test('durable local shadow request is written before hosted completion marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-order-'));
  try {
    const events = [];
    const shadow = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 43,
      headSha: 'def456',
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
    });
    events.push(existsSync(shadow.requestPath) ? 'shadow-request-written' : 'missing');
    markLocalReviewShadowHostedPosted({ rootDir: root, request: shadow.request });
    events.push('hosted-completion-marker');
    assert.deepEqual(events, ['shadow-request-written', 'hosted-completion-marker']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local shadow family guard fails closed for missing and same-family metadata across supported builders', () => {
  assert.equal(resolveBuilderFamily('[codex]'), 'codex');
  assert.equal(resolveBuilderFamily('[claude-code]'), 'claude');
  assert.equal(resolveBuilderFamily('[clio-agent]'), 'codex');
  assert.equal(resolveLocalShadowModelFamily('unknown-local-model'), null);

  const fixtures = [
    { builderTag: '[codex]', model: 'unknown-local-model', hostedReviewerModel: 'claude', reason: 'local-shadow-family-unproven' },
    { builderTag: '[codex]', model: 'local/codex', hostedReviewerModel: 'claude', reason: 'local-shadow-family-not-distinct' },
    { builderTag: '[claude-code]', model: 'local/claude', hostedReviewerModel: 'codex', reason: 'local-shadow-family-not-distinct' },
    { builderTag: '[clio-agent]', model: 'local/codex', hostedReviewerModel: 'claude', reason: 'local-shadow-family-not-distinct' },
  ];

  for (const fixture of fixtures) {
    const request = buildLocalReviewShadowRequest({
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 44,
      headSha: fixture.builderTag,
      builderTag: fixture.builderTag,
      hostedReviewerModel: fixture.hostedReviewerModel,
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: fixture.model },
    });
    assert.equal(request.status, 'hosted-only', fixture.builderTag);
    assert.equal(request.skipReason, fixture.reason, fixture.builderTag);
  }
});

test('local shadow execution is sequenced after hosted post marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-sequence-'));
  try {
    const events = [];
    const shadow = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 45,
      headSha: 'seq',
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
    });
    events.push('request');
    const marked = markLocalReviewShadowHostedPosted({ rootDir: root, request: shadow.request });
    events.push('hosted-posted');
    await runLocalReviewShadowRequest({
      rootDir: root,
      request: marked.request,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
      execFileImpl: async () => {
        events.push('litellm-started');
        return { stdout: 'local review text', stderr: '' };
      },
    });
    assert.deepEqual(events, ['request', 'hosted-posted', 'litellm-started']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local shadow LiteLLM subprocess receives only local routing env', async () => {
  const allowed = buildLocalReviewShadowSubprocessEnv({
    PATH: '/usr/bin:/bin',
    OLLAMA_HOST: 'http://127.0.0.1:11434',
    LITELLM_BASE_URL: 'http://127.0.0.1:4000',
    GH_CODEX_REVIEWER_TOKEN: 'gho_secret',
    GITHUB_TOKEN: 'ghp_secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret',
    OP_SERVICE_ACCOUNT_TOKEN: 'op-secret',
    REVIEWER_BROKER_TOKEN: 'broker-secret',
    HOME: '/Users/reviewer',
  });
  assert.deepEqual(allowed, {
    PATH: '/usr/bin:/bin',
    LITELLM_BASE_URL: 'http://127.0.0.1:4000',
    OLLAMA_HOST: 'http://127.0.0.1:11434',
  });

  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-env-'));
  try {
    const shadow = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 450,
      headSha: 'env',
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir: root, request: shadow.request });
    let subprocessEnv = null;
    await runLocalReviewShadowRequest({
      rootDir: root,
      request: marked.request,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      env: {
        PATH: '/usr/local/bin',
        OLLAMA_HOST: 'http://127.0.0.1:11434',
        GH_CLAUDE_REVIEWER_TOKEN: 'gho_secret',
        GITHUB_TOKEN: 'ghp_secret',
        OPENAI_API_KEY: 'openai-secret',
      },
      execFileImpl: async (_command, _args, options) => {
        subprocessEnv = options.env;
        return { stdout: 'local review text', stderr: '' };
      },
    });
    assert.deepEqual(subprocessEnv, {
      PATH: '/usr/local/bin',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crash recovery reconciles hosted-posted missing shadow artifact idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-reconcile-'));
  try {
    let calls = 0;
    const first = await reconcileLocalReviewShadow({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 46,
      headSha: 'recover',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      hostedReviewPosted: true,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
      execFileImpl: async () => {
        calls += 1;
        return { stdout: 'recovered local review', stderr: '' };
      },
    });
    assert.equal(first.status, 'completed');
    assert.equal(calls, 1);

    const second = await reconcileLocalReviewShadow({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 46,
      headSha: 'recover',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      hostedReviewPosted: true,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
      execFileImpl: async () => {
        calls += 1;
        return { stdout: 'should not run again', stderr: '' };
      },
    });
    assert.equal(second.reason, 'artifact-already-exists');
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR without run-local-review-shadow label leaves shadow behavior unchanged', () => {
  assert.equal(hasLocalReviewShadowLabel(['bug', 'enhancement']), false);
  const result = persistLocalReviewShadowRequestBeforeHostedPost({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 47,
    headSha: 'nolabel',
    builderTag: '[codex]',
    hostedReviewerModel: 'gemini',
    labels: ['bug'],
    env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
  });
  assert.equal(result, null);
});

test('local shadow timeout or LiteLLM failure records warning state without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-failure-'));
  try {
    const shadow = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 48,
      headSha: 'fail',
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: {
        [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder',
        ADVERSARIAL_REVIEW_LOCAL_SHADOW_TIMEOUT_MS: '1',
      },
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir: root, request: shadow.request });
    const warnings = [];
    const result = await runLocalReviewShadowRequest({
      rootDir: root,
      request: marked.request,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      execFileImpl: async () => {
        throw Object.assign(new Error('model unavailable'), { code: 'ENOENT' });
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.equal(result.reason, 'retryable-warning');
    assert.match(warnings[0], /WARNING local-review-shadow/);
    const persisted = JSON.parse(readFileSync(shadow.requestPath, 'utf8'));
    assert.equal(persisted.status, 'retryable-warning');
    assert.equal(existsSync(localReviewShadowArtifactPath(root, shadow.request.requestKey)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local shadow artifact provenance is explicitly local and non-gating', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adversarial-review-shadow-provenance-'));
  try {
    const shadow = persistLocalReviewShadowRequestBeforeHostedPost({
      rootDir: root,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 49,
      headSha: 'prov',
      builderTag: '[codex]',
      hostedReviewerModel: 'gemini',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
    });
    const marked = markLocalReviewShadowHostedPosted({ rootDir: root, request: shadow.request });
    const result = await runLocalReviewShadowRequest({
      rootDir: root,
      request: marked.request,
      diff: 'diff --git a/file b/file',
      hostedReviewText: 'hosted review',
      env: { [LOCAL_REVIEW_SHADOW_MODEL_ENV]: 'ollama/qwen2.5-coder' },
      execFileImpl: async () => ({ stdout: 'A local-only observation.', stderr: '' }),
    });
    const artifact = readFileSync(result.artifactPath, 'utf8');
    assert.match(artifact, /Local OSS Model Shadow Review \(Non-Gating\)/);
    assert.match(artifact, /generated by local OSS model `ollama\/qwen2\.5-coder` through LiteLLM/);
    assert.match(artifact, /does not alter the hosted adversarial review verdict or merge gate/);
    assert.doesNotMatch(artifact, /^## Adversarial Review/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('buildGeminiReviewArgs enters headless mode without carrying the prompt body', () => {
  const args = buildGeminiReviewArgs({ model: 'gemini-2.5-pro' });
  assert.deepEqual(args, ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', '']);
  // The prompt flag is intentionally empty: it enables non-interactive stdin
  // handling without putting prompt/diff content in argv.
  assert.equal(args[args.indexOf('--prompt') + 1], '');
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
