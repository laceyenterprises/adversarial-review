import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CLI, GEMINI_CLI, AGY_CLI, __test__ } from '../src/reviewer.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { buildObviousDocsGuidance, extractLinkedRepoDocs, fetchLinkedSpecContents, parseGitHubBlobPath } from '../src/prompt-context.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import {
  AGY_TRANSIENT_REMEDIATION,
  clearAgyReviewerAuthCache,
  safeExecFile,
} from '../src/agy-reviewer-auth.mjs';

const {
  CLAUDE_STRIPPED_ENV_VARS,
  ENV_BIN,
  LAUNCHCTL,
  buildClaudeReviewArgs,
  buildCodexReviewArgs,
  parseClaudeJsonOutput,
  parseCodexJsonTokenUsage,
  queueFollowUpForPostedReview,
  resolveCodexAuthPath,
  resolveCodexExecOverrides,
  resolveReviewerTimeoutMs,
  ADVISORY_ONLY_REVIEW_LABEL,
  VERDICT_MODE_ADVISORY_ONLY,
  VERDICT_MODE_ENFORCE,
  buildReviewCommentHeader,
  buildReviewCommentBody,
  classifyReviewCommentHeader,
  startsWithReviewCommentHeader,
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
  resolveGeminiAntigravityModel,
  resolveGeminiReviewerModel,
  resolveGeminiReviewerSessionParent,
  purgeStaleGeminiReviewerSessionDirs,
  resetGeminiReviewerSessionPreflightForTest,
  checkoutGeminiCredentialFromBroker,
  geminiSpendReportsForUsage,
  reportGeminiCredentialSpend,
  releaseGeminiCredentialCheckout,
  materializeGeminiCheckoutSession,
  acquireGeminiFallbackLock,
  GeminiCredentialPoolUnavailableError,
  GeminiCredentialPoolNoCreditError,
  resolveReviewerMetadata,
  buildGeminiReviewArgs,
  buildAgyReviewArgs,
  DEFAULT_AGY_ARGV_MAX_BYTES,
  resolveAgyArgvMaxBytes,
  agyPromptBytes,
  assertAgyPromptFitsArgv,
  AGY_ARGV_MAX_BYTES,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  formatAgyPrintTimeout,
  sanitizeAgyReviewOutput,
  buildPromptForReviewerModel,
  chooseAgyOversizedCrossModelRoute,
  resolveAgyOversizedReviewRoute,
  splitDiffForAgyChunks,
  extractMarkdownIssueList,
  mergeChunkedAgyReviews,
  reviewAgyOversizedInChunks,
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_SERVICE,
  AGY_KEYCHAIN_REMEDIATION,
  isRetryableGeminiSubprocessError,
  alertClioOversizedAgyFailure,
  spawnGeminiReview,
  spawnAgyReview,
  reviewWithGemini,
  dispatchReviewerModel,
  formatAdvisoryFindingsContext,
  postGitHubReview,
  postGitHubReviewWithCapture,
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

test('postGitHubReview uses adapter mutation with the intended reviewer bot identity', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-post-adapter-'));
  const calls = [];
  await withEnvAsync({
    GHA_ADAPTER_BIN: '/wrong/global-adapter',
    GH_CODEX_REVIEWER_TOKEN: 'ghp_wrong_global_pat',
    HTTP_PROXY: 'http://wrong-global-proxy.invalid:8080',
    GITHUB_TOKEN: 'ghp_ambient_operator_token',
  }, async () => {
    const sourceEnv = {
      GHA_ADAPTER_BIN: '/fixture/github-adapter',
      GH_CODEX_REVIEWER_TOKEN: 'ghp_codex_reviewer_pat',
      GH_CODEX_REVIEWER_TOKEN_SOURCE: 'oauth-broker',
      GH_CODEX_REVIEWER_TOKEN_BROKER_PROVIDER: 'github-app-lacey-codex-reviewer',
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/test',
      HTTP_PROXY: 'http://proxy.example:8080',
      SSL_CERT_FILE: '/tmp/corp-ca.pem',
      GITHUB_TOKEN: 'ghp_ambient_operator_token',
    };
    await postGitHubReview(
      'laceyenterprises/demo',
      42,
      'review body',
      'GH_CODEX_REVIEWER_TOKEN',
      async (command, args, options = {}) => {
        calls.push({ command, args, options });
        assert.equal(command, '/fixture/github-adapter');
        return { stdout: JSON.stringify({ ok: true }) };
      },
      {
        rootDir,
        env: sourceEnv,
        reviewerIdentity: 'codex-reviewer-lacey',
        prepareReviewWrite: async ({ selfLogin, token }) => {
          assert.equal(selfLogin, 'lacey-codex-reviewer[bot]');
          assert.equal(token, 'ghp_codex_reviewer_pat');
        },
      }
    );
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GH_TOKEN, 'ghp_codex_reviewer_pat');
  assert.equal(calls[0].options.env.GH_CODEX_REVIEWER_TOKEN, 'ghp_codex_reviewer_pat');
  assert.equal(calls[0].options.env.GH_CODEX_REVIEWER_TOKEN_SOURCE, 'oauth-broker');
  assert.equal(calls[0].options.env.GH_CODEX_REVIEWER_TOKEN_BROKER_PROVIDER, 'github-app-lacey-codex-reviewer');
  assert.equal(calls[0].options.env.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(calls[0].options.env.SSL_CERT_FILE, '/tmp/corp-ca.pem');
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
  assert.deepEqual(calls[0].args, [
    'write',
    '--kind',
    'pull-request-review',
    '--json',
    '--repo',
    'laceyenterprises/demo',
    '--pr-number',
    '42',
    '--body',
    'review body',
    '--reviewer-login',
    'lacey-codex-reviewer[bot]',
    '--auth',
    'codex-reviewer',
    '--auth-mode',
    'env-token',
    '--pat-env',
    'GH_CODEX_REVIEWER_TOKEN',
    '--expected-login',
    'lacey-codex-reviewer[bot]',
  ]);
});

test('postGitHubReviewWithCapture emits a reviewed attestation for the reviewed head and D3 verdict', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-post-attestation-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  try {
    const attestCalls = [];
    await withEnvAsync({
      GHA_ADAPTER_BIN: '/fixture/github-adapter',
      GH_CODEX_REVIEWER_TOKEN: 'ghp_codex_reviewer_pat',
    }, async () => {
      await postGitHubReviewWithCapture({
        rootDir,
        repo: 'laceyenterprises/demo',
        prNumber: 42,
        attemptNumber: 1,
        reviewerModel: 'codex',
        reviewerHeadSha: 'reviewed-head-sha',
        reviewBody: [
          '## Summary',
          'Blocking verdict.',
          '',
          '## Blocking issues',
          '- **Regression**',
          '  - **File:** src/demo.mjs',
          '  - **Lines:** 1-2',
          '  - **Problem:** The reviewed head is unsafe.',
          '',
          '## Verdict',
          'Request changes',
        ].join('\n'),
        botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
        passKind: 'first-pass',
        execFileImpl: async (command) => {
          assert.equal(command, '/fixture/github-adapter');
          return { stdout: JSON.stringify({ ok: true }) };
        },
        attestExecFileImpl: async (command, args, options = {}) => {
          attestCalls.push({ command, args, options });
          const payload = JSON.parse(options.input);
          return {
            stdout: JSON.stringify({
              ...payload,
              signature: {
                verified: true,
                hcp_subject: payload.reviewer_identity,
              },
            }),
          };
        },
        prepareReviewWrite: async () => {},
        reviewerIdentity: 'codex-reviewer-lacey',
        log: { log() {}, warn() {} },
      });
    });

    assert.equal(attestCalls.length, 1);
    assert.equal(attestCalls[0].command, 'hq');
    assert.deepEqual(attestCalls[0].args, ['attest', 'sign', '--payload', '-']);
    const payload = JSON.parse(attestCalls[0].options.input);
    assert.equal(payload.kind, 'reviewed');
    assert.equal(payload.head_sha, 'reviewed-head-sha');
    assert.equal(payload.verdict, 'request-changes');
    assert.equal(payload.findings_count, 1);
    assert.equal(payload.reviewer_identity, 'codex-reviewer-lacey');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('postGitHubReviewWithCapture propagates signing failure after posting for watcher recovery', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-post-attestation-failure-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  try {
    beginReviewerPass(rootDir, {
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      attemptNumber: 1,
      reviewerClass: 'codex',
      reviewerModel: 'codex',
      passKind: 'first-pass',
    });
    let postCalls = 0;
    const postAndFailSigning = () => postGitHubReviewWithCapture({
      rootDir,
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      attemptNumber: 1,
      reviewerModel: 'codex',
      reviewerHeadSha: 'reviewed-head-sha',
      reviewBody: '## Verdict\nComment only',
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      passKind: 'first-pass',
      execFileImpl: async (command) => {
        if (command === '/fixture/github-adapter') postCalls += 1;
        return { stdout: '{}' };
      },
      attestExecFileImpl: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      prepareReviewWrite: async () => {},
    });
    await withEnvAsync({
      GHA_ADAPTER_BIN: '/fixture/github-adapter',
      GH_CODEX_REVIEWER_TOKEN: 'ghp_codex_reviewer_pat',
    }, async () => {
      await assert.rejects(postAndFailSigning(), /permission denied/);
    });
    await withEnvAsync({
      GHA_ADAPTER_BIN: '/fixture/github-adapter',
      GH_CODEX_REVIEWER_TOKEN: undefined,
    }, async () => {
      await assert.rejects(postAndFailSigning(), /permission denied/);
    });
    assert.equal(postCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

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

test('review comment body prepends canonical header when reviewer output has none', () => {
  const body = buildReviewCommentBody({
    reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
    reviewText: '## Summary\nClean.\n\n## Verdict\nComment only',
  });

  assert.equal(
    body,
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n' +
      '## Summary\nClean.\n\n## Verdict\nComment only',
  );
});

test('review comment body skips prepending when reviewer output already has a title', () => {
  const modelOutput = [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'Clean.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  const body = buildReviewCommentBody({
    reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
    reviewText: modelOutput,
  });

  assert.equal(body, modelOutput);
  assert.equal(body.match(/^##\s+Adversarial Review\b/gm).length, 1);
});

test('review comment body recognizes loose model-supplied adversarial review titles', () => {
  const modelOutput = [
    '## Adversarial Review - Gemini',
    '',
    '## Summary',
    'Clean.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  assert.equal(startsWithReviewCommentHeader(modelOutput), true);
  assert.equal(
    buildReviewCommentBody({
      reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
      verdictMode: VERDICT_MODE_ENFORCE,
      reviewText: modelOutput,
    }),
    modelOutput,
  );
});

test('review comment body skips prepending when model title has leading whitespace', () => {
  const modelOutput = [
    '',
    '  ## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'Clean.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  const body = buildReviewCommentBody({
    reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
    reviewText: modelOutput,
  });

  assert.equal(startsWithReviewCommentHeader(modelOutput), true);
  assert.equal(
    body,
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n' +
      '## Summary\nClean.\n\n## Verdict\nComment only',
  );
  assert.equal(body.match(/^##\s+Adversarial Review\b/gm).length, 1);
});

test('review comment body inserts waiver under existing model-supplied title', () => {
  const waiverAuditBlock = '> Cross-model review waiver: operator override.\n\n';
  const body = buildReviewCommentBody({
    reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
    waiverAuditBlock,
    reviewText: [
      '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
      '',
      '## Summary',
      'Clean.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
  });

  assert.equal(
    body,
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n' +
      waiverAuditBlock +
      '## Summary\nClean.\n\n## Verdict\nComment only',
  );
});

test('review comment body inserts waiver below title with leading carriage-return newlines', () => {
  const waiverAuditBlock = '> Cross-model review waiver: operator override.\n\n';
  const body = buildReviewCommentBody({
    reviewerMetadata: { displayName: 'Gemini', reviewerIdentity: 'gemini-reviewer-lacey' },
    verdictMode: VERDICT_MODE_ENFORCE,
    waiverAuditBlock,
    reviewText: '\r\n\r\n## Adversarial Review — Gemini (gemini-reviewer-lacey)\r\n\r\n## Summary\r\nClean.\r\n\r\n## Verdict\r\nComment only',
  });

  assert.equal(
    body,
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n' +
      waiverAuditBlock +
      '## Summary\r\nClean.\r\n\r\n## Verdict\r\nComment only',
  );
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
  assert.deepEqual(dirty.result.handoffWake, { attempted: false });
  assert.equal(malformed.result.queued, true);
  assert.equal(malformed.created.length, 1);
});

test('review-to-remediation handoff wakes follow-up daemon only when enabled', () => {
  const disabled = queueWithFakes('## Summary\nFix it.\n\n## Verdict\nRequest changes', {
    resolveHandoffConfigImpl: () => ({
      enabled: false,
      reviewToRemediation: true,
    }),
    signalFollowUpDaemonWakeImpl: () => {
      throw new Error('disabled path should not wake');
    },
  });
  assert.equal(disabled.result.queued, true);
  assert.deepEqual(disabled.result.handoffWake, { attempted: false });

  const wakeCalls = [];
  const enabled = queueWithFakes('## Summary\nFix it.\n\n## Verdict\nRequest changes', {
    rootDir: '/tmp/adversarial-review-handoff-test',
    resolveHandoffConfigImpl: () => ({
      enabled: true,
      reviewToRemediation: true,
    }),
    signalFollowUpDaemonWakeImpl: (payload) => {
      wakeCalls.push(payload);
      return { target: 'follow-up-daemon', wakePath: '/tmp/wake' };
    },
  });

  assert.equal(enabled.result.queued, true);
  assert.deepEqual(wakeCalls, [{
    rootDir: '/tmp/adversarial-review-handoff-test',
    reason: 'review-to-remediation',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    headSha: 'review-head-sha',
  }]);
  assert.deepEqual(enabled.result.handoffWake, {
    attempted: true,
    ok: true,
    target: 'follow-up-daemon',
    wakePath: '/tmp/wake',
  });
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

test('buildClaudeReviewArgs requests json output for exact usage capture', () => {
  const args = buildClaudeReviewArgs('the prompt');
  const oIdx = args.indexOf('--output-format');
  assert.ok(oIdx >= 0 && args[oIdx + 1] === 'json', 'must pass --output-format json');
});

test('parseClaudeJsonOutput extracts review text + exact usage (no transcript needed)', () => {
  const raw = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: '## Verdict\nRequest changes',
    usage: {
      input_tokens: 12000,
      output_tokens: 450,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1500,
    },
  });
  const { reviewText, tokenUsage } = parseClaudeJsonOutput(raw);
  assert.equal(reviewText, '## Verdict\nRequest changes');
  assert.equal(tokenUsage.input, 12000);
  assert.equal(tokenUsage.output, 450);
  assert.equal(tokenUsage.cacheRead, 8000);
  assert.equal(tokenUsage.cacheWrite, 1500);
  assert.equal(tokenUsage.source, 'claude-json');
});

test('parseClaudeJsonOutput extracts warning-prefixed json output', () => {
  const raw = [
    'Warning: using cached OAuth session',
    JSON.stringify({ result: '## Verdict\nComment only', usage: { input_tokens: 7 } }),
  ].join('\n');
  const { reviewText, tokenUsage } = parseClaudeJsonOutput(raw);
  assert.equal(reviewText, '## Verdict\nComment only');
  assert.equal(tokenUsage.input, 7);
  assert.equal(tokenUsage.source, 'claude-json');
});

test('parseClaudeJsonOutput fails closed instead of returning raw stdout', () => {
  assert.throws(
    () => parseClaudeJsonOutput('## Verdict\nplain text review'),
    /Failed to parse Claude JSON output/
  );
  assert.throws(
    () => parseClaudeJsonOutput(JSON.stringify({ error: 'Rate limit' })),
    /missing string 'result' field/
  );
  assert.throws(
    () => parseClaudeJsonOutput(JSON.stringify({ result: '   ' })),
    /empty 'result' field/
  );
});

test('parseClaudeJsonOutput yields no usage when the usage block is absent', () => {
  const { reviewText, tokenUsage } = parseClaudeJsonOutput(JSON.stringify({ result: 'hi' }));
  assert.equal(reviewText, 'hi');
  assert.equal(tokenUsage, null);
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
      args: ['--print', '--output-format', 'json', '--permission-mode', 'bypassPermissions', prompt],
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
    reasoning: null,
    cacheRead: 45,
    cacheWrite: 0,
    total: 174,
    source: 'codex-json',
    usageTag: 'guardrail',
    guardrail: 174,
  });
});

test('Codex JSON token parser captures reasoning + gemini usageMetadata (full fidelity)', () => {
  const codex = parseCodexJsonTokenUsage(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 7, total_tokens: 117 },
    }),
  );
  assert.equal(codex.reasoning, 7, 'reasoning_output_tokens captured');

  const gemini = parseCodexJsonTokenUsage(
    JSON.stringify({
      usageMetadata: {
        promptTokenCount: 800,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 15,
        cachedContentTokenCount: 200,
        toolUsePromptTokenCount: 5,
        totalTokenCount: 835,
      },
    }),
  );
  assert.equal(gemini.input, 800);
  assert.equal(gemini.output, 20 + 15);
  assert.equal(gemini.reasoning, 15);
  assert.equal(gemini.cacheRead, 200);
  assert.equal(gemini.toolContext, 5);
  assert.equal(gemini.source, 'gemini-json');
});

test('Reviewer Codex token parser uses canonical side-channel marker handling', () => {
  const usage = parseCodexJsonTokenUsage(JSON.stringify({
    type: 'reviewer.token_usage',
    tokenUsage: {
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 0,
      total: 1500,
      source: 'codex-json',
    },
  }));

  assert.deepEqual(usage, {
    input: 1000,
    output: 200,
    cacheRead: 300,
    cacheWrite: 0,
    total: 1500,
    source: 'codex-json',
    usageTag: 'guardrail',
    guardrail: 1500,
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

test('buildAgyReviewArgs binds --model before --print and carries the prompt as the --print value', () => {
  const prompt = '## Adversarial Review\n\n```diff\n+x\n```';
  const args = buildAgyReviewArgs({ model: 'Gemini 3.1 Pro (High)', prompt, printTimeoutMs: 1_140_000 });
  // agy's --print is a VALUE flag: the prompt must be its argument, and every
  // value-bearing flag (incl. --model) must precede --print so it binds.
  assert.deepEqual(args, [
    '--model', 'Gemini 3.1 Pro (High)',
    '--print-timeout', '1140s',
    '--dangerously-skip-permissions',
    '--print', prompt,
  ]);
  const modelIdx = args.indexOf('--model');
  const printIdx = args.indexOf('--print');
  assert.ok(modelIdx >= 0, '--model present');
  assert.equal(args[modelIdx + 1], 'Gemini 3.1 Pro (High)', '--model bound to the agy display-name token');
  assert.ok(modelIdx < printIdx, '--model must precede --print so the model binds (was the silent-Flash bug)');
  // The prompt rides on argv as the --print value, NOT left to stdin (which
  // would let --print swallow the next token and unbind --model).
  assert.equal(args[printIdx + 1], prompt, 'prompt delivered as the --print argv value');
  // The old boolean `-m`/stdin form must be gone.
  assert.ok(!args.includes('-m'), 'legacy -m short flag removed');
});

test('agy print timeout is independently tunable and reviewer subprocess gets headroom', () => {
  const reviewerTimeoutMs = 20 * 60 * 1000;
  const printTimeoutMs = resolveAgyPrintTimeoutMs({});
  const args = buildAgyReviewArgs({ model: 'Gemini 3.1 Pro (High)', prompt: 'p', printTimeoutMs });
  const printTimeoutArg = args[args.indexOf('--print-timeout') + 1];

  assert.equal(printTimeoutMs, 1_140_000);
  assert.equal(formatAgyPrintTimeout(printTimeoutMs), '1140s');
  assert.equal(printTimeoutArg, '1140s');
  assert.ok(printTimeoutMs < reviewerTimeoutMs);
  assert.equal(
    resolveAgyPrintTimeoutMs({ ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' }),
    1_500_000,
  );
  assert.equal(
    resolveAgyReviewerSubprocessTimeoutMs(
      { ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' },
      { reviewerTimeoutMs },
    ),
    1_530_000,
  );
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

test('spawnAgyReview delivers the prompt on argv (as the --print value) so the model binds, and closes stdin', async () => {
  const prompt = 'ADVERSARIAL PROMPT\n\n---\n\n```diff\n+diff body\n```';
  const calls = [];

  await spawnAgyReview({
    agyCli: '/usr/local/bin/agy',
    prompt,
    model: 'Gemini 3.1 Pro (High)',
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
    cwd: '/tmp/repo',
    timeout: 9_999,
    printTimeoutMs: 9_000,
    maxBuffer: 555,
    spawnWithInputImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/local/bin/agy');
  assert.deepEqual(calls[0].args, [
    '--model', 'Gemini 3.1 Pro (High)',
    '--print-timeout', '9s',
    '--dangerously-skip-permissions',
    '--print', prompt,
  ]);
  // --model precedes --print so it actually binds (the silent-Flash regression).
  const modelIdx = calls[0].args.indexOf('--model');
  const printIdx = calls[0].args.indexOf('--print');
  assert.ok(modelIdx < printIdx, '--model must precede --print');
  assert.equal(calls[0].args[modelIdx + 1], 'Gemini 3.1 Pro (High)');
  // Prompt is on argv, stdin is closed (NOT fed the prompt — that unbinds the model).
  assert.equal(calls[0].args[printIdx + 1], prompt);
  assert.equal(calls[0].options.input, '');
  assert.deepEqual(
    { cwd: calls[0].options.cwd, timeout: calls[0].options.timeout, maxBuffer: calls[0].options.maxBuffer },
    { cwd: '/tmp/repo', timeout: 39_000, maxBuffer: 555 },
  );
});

test('spawnAgyReview refuses an oversized prompt rather than reverting to the model-unbinding stdin form', async () => {
  const oversized = 'x'.repeat(AGY_ARGV_MAX_BYTES + 1);
  let spawned = false;
  await assert.rejects(
    () => spawnAgyReview({
      agyCli: '/usr/local/bin/agy',
      prompt: oversized,
      model: 'Gemini 3.1 Pro (High)',
      env: { HOME: '/tmp/home', PATH: process.env.PATH },
      printTimeoutMs: 9_000,
      spawnWithInputImpl: async () => { spawned = true; return { stdout: 'ok', stderr: '' }; },
    }),
    /argv budget/,
  );
  assert.equal(spawned, false, 'must not spawn agy with an oversized argv');
});

test('assertAgyPromptFitsArgv accepts prompts under the budget and rejects oversized ones', () => {
  assert.equal(assertAgyPromptFitsArgv('ok', { maxBytes: 10 }), 2);
  assert.throws(() => assertAgyPromptFitsArgv('x'.repeat(11), { maxBytes: 10 }), /argv budget/);
});

test('agy argv budget is a named configurable 262144-byte default', () => {
  assert.equal(DEFAULT_AGY_ARGV_MAX_BYTES, 262_144);
  assert.equal(AGY_ARGV_MAX_BYTES, 262_144);
  assert.equal(resolveAgyArgvMaxBytes({}), 262_144);
  assert.equal(resolveAgyArgvMaxBytes({ ADVERSARIAL_REVIEW_AGY_ARGV_MAX_BYTES: '12345' }), 12_345);
});

test('oversized agy prompt on [codex] routes this review to claude', () => {
  const diff = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n+${'x'.repeat(500)}`;
  const route = resolveAgyOversizedReviewRoute({
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    builderTag: '[codex]',
    diff,
    extraContext: '',
    promptStage: 'first',
    geminiRuntime: 'antigravity',
    maxBytes: 300,
  });

  assert.equal(route.oversized, true);
  assert.equal(route.reason, 'agy-argv-budget-exceeded');
  assert.equal(route.route.reviewerModel, 'claude');
  assert.equal(route.route.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.ok(route.promptBytes > route.maxBytes);
  assert.deepEqual(chooseAgyOversizedCrossModelRoute('[claude-code]'), {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });
});

test('normal-size always-on gemini antigravity review stays on gemini', () => {
  const route = resolveAgyOversizedReviewRoute({
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    builderTag: '[codex]',
    diff: 'diff --git a/a.txt b/a.txt\n+a\n',
    extraContext: '',
    promptStage: 'first',
    geminiRuntime: 'antigravity',
    maxBytes: 100_000,
  });

  assert.equal(route.oversized, false);
  assert.deepEqual(route.route, {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  });
});

test('only agy available: oversized diff chunk fallback keeps each chunk under budget and merges findings', async () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    ...Array.from({ length: 12 }, (_, index) => `+line ${index} ${'x'.repeat(20)}`),
  ].join('\n');
  const maxBytes = 16_000;
  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes,
    maxChunks: 20,
  });
  assert.equal(split.ok, true);
  assert.ok(split.chunks.length > 1);
  for (const chunk of split.chunks) {
    assert.ok(chunk.promptBytes <= maxBytes, `chunk prompt ${chunk.promptBytes} exceeded ${maxBytes}`);
    const prompt = buildPromptForReviewerModel('gemini', chunk.diff, '', {
      promptStage: 'first',
      runtime: 'antigravity',
    });
    assert.equal(agyPromptBytes(prompt), chunk.promptBytes);
  }

  const calls = [];
  const result = await reviewAgyOversizedInChunks(diff, '', {
    promptStage: 'first',
    maxBytes,
    maxChunks: 20,
    reviewWithGeminiImpl: async (chunkDiff, chunkContext) => {
      calls.push(chunkDiff);
      const prompt = buildPromptForReviewerModel('gemini', chunkDiff, chunkContext, {
        promptStage: 'first',
        runtime: 'antigravity',
      });
      assert.ok(agyPromptBytes(prompt) <= maxBytes, 'runtime chunk prompt must stay under argv budget');
      return {
        reviewText: calls.length === 1
          ? '## Blocking issues\n- Bad first chunk.\n\n## Verdict\nRequest changes'
          : '## Blocking issues\n- None.\n\n## Verdict\nComment only',
        tokenUsage: null,
      };
    },
  });

  assert.ok(
    calls.length >= split.chunks.length,
    'runtime reserved context may split more finely than a raw direct split',
  );
  assert.equal(result.needsSanitize, false);
  assert.equal(result.chunked, true);
  assert.match(result.reviewText, /Bad first chunk/);
  assert.match(result.reviewText, /## Verdict\nRequest changes/);
});

test('agy chunk fallback packs multiple small file patches into one chunk when they fit', () => {
  const filePatch = (name) => [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -1 +1 @@',
    `+${name}`,
  ].join('\n');
  const diff = [filePatch('a.txt'), filePatch('b.txt'), filePatch('c.txt')].join('\n');

  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes: 100_000,
    maxChunks: 20,
  });

  assert.equal(split.ok, true);
  assert.equal(split.chunks.length, 1);
  assert.match(split.chunks[0].diff, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(split.chunks[0].diff, /diff --git a\/b\.txt b\/b\.txt/);
  assert.match(split.chunks[0].diff, /diff --git a\/c\.txt b\/c\.txt/);
});

test('agy chunk fallback preserves file headers on line-split chunks', () => {
  const header = [
    'diff --git a/big.txt b/big.txt',
    'index 1111111..2222222 100644',
    '--- a/big.txt',
    '+++ b/big.txt',
  ];
  const body = [
    '@@ -1,20 +1,20 @@',
    ...Array.from({ length: 20 }, (_, index) => `+line ${index} ${'x'.repeat(120)}`),
  ];
  const diff = [...header, ...body].join('\n');
  const promptOverheadBytes = agyPromptBytes(buildPromptForReviewerModel('gemini', '', '', {
    promptStage: 'first',
    runtime: 'antigravity',
  }));
  const maxBytes = promptOverheadBytes
    + agyPromptBytes(header.join('\n'))
    + 1
    + agyPromptBytes(body.slice(0, 3).join('\n'));

  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes,
    maxChunks: 20,
  });

  assert.equal(split.ok, true);
  assert.ok(split.chunks.length > 1);
  for (const chunk of split.chunks) {
    assert.match(chunk.diff, /^diff --git a\/big\.txt b\/big\.txt\nindex 1111111\.\.2222222 100644\n--- a\/big\.txt\n\+\+\+ b\/big\.txt\n@@ /);
    assert.ok(chunk.promptBytes <= maxBytes);
  }
});

test('agy chunk fallback tracks the active hunk header for multi-hunk line splits', () => {
  const header = [
    'diff --git a/big.txt b/big.txt',
    'index 1111111..2222222 100644',
    '--- a/big.txt',
    '+++ b/big.txt',
  ];
  const firstHunk = [
    '@@ -1,8 +1,8 @@',
    ...Array.from({ length: 8 }, (_, index) => `+early ${index} ${'x'.repeat(90)}`),
  ];
  const secondHunk = [
    '@@ -500,8 +500,8 @@',
    ...Array.from({ length: 8 }, (_, index) => `+later ${index} ${'y'.repeat(90)}`),
  ];
  const diff = [...header, ...firstHunk, ...secondHunk].join('\n');
  const promptOverheadBytes = agyPromptBytes(buildPromptForReviewerModel('gemini', '', '', {
    promptStage: 'first',
    runtime: 'antigravity',
  }));
  const maxBytes = promptOverheadBytes
    + agyPromptBytes(header.join('\n'))
    + 1
    + agyPromptBytes(secondHunk.slice(0, 3).join('\n'));

  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes,
    maxChunks: 20,
  });

  assert.equal(split.ok, true);
  const laterChunk = split.chunks.find((chunk) => chunk.diff.includes('+later 4 '));
  assert.ok(laterChunk, 'expected a split chunk from the second hunk');
  assert.match(laterChunk.diff, /^diff --git a\/big\.txt b\/big\.txt\nindex 1111111\.\.2222222 100644\n--- a\/big\.txt\n\+\+\+ b\/big\.txt\n@@ -500,8 \+500,8 @@/);
  assert.doesNotMatch(laterChunk.diff, /@@ -1,8 \+1,8 @@/);
});

test('agy chunk fallback preserves active hunk context for metadata-less diffs', () => {
  const diff = [
    '@@ -1,8 +1,8 @@',
    ...Array.from({ length: 8 }, (_, index) => `+line ${index} ${'z'.repeat(100)}`),
  ].join('\n');
  const promptOverheadBytes = agyPromptBytes(buildPromptForReviewerModel('gemini', '', '', {
    promptStage: 'first',
    runtime: 'antigravity',
  }));
  const maxBytes = promptOverheadBytes + agyPromptBytes(diff.split('\n').slice(0, 3).join('\n'));

  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes,
    maxChunks: 20,
  });

  assert.equal(split.ok, true);
  assert.ok(split.chunks.length > 1);
  for (const chunk of split.chunks) {
    assert.match(chunk.diff, /^@@ -1,8 \+1,8 @@/);
    assert.ok(chunk.promptBytes <= maxBytes);
  }
});

test('agy chunking preserves leading and trailing diff whitespace', () => {
  const diff = ' context line\n ';
  const split = splitDiffForAgyChunks(diff, {
    extraContext: '',
    promptStage: 'first',
    maxBytes: 100_000,
    maxChunks: 20,
  });

  assert.equal(split.ok, true);
  assert.equal(split.chunks[0].diff, diff);
});

test('mergeChunkedAgyReviews merges only issue bullets from child review sections', () => {
  const merged = mergeChunkedAgyReviews([
    {
      reviewText: [
        '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
        '',
        '## Summary',
        'First summary must not be nested.',
        '',
        '## Blocking issues',
        '- **Bad split**',
        '  - Detail from first chunk.',
        '',
        '## Non-blocking issues',
        '- Nit from first chunk.',
        '',
        '## Suggested fixes',
        '- Fix the split.',
        '',
        '## Verdict',
        'Request changes',
      ].join('\n'),
    },
    {
      reviewText: [
        '## Summary',
        'Second summary must not be nested.',
        '',
        '## Blocking issues',
        '- None.',
        '',
        '## Non-blocking issues',
        '- Nit from second chunk.',
        '',
        '## Suggested fixes',
        '- Add a regression test.',
        '',
        '## Verdict',
        'Comment only',
      ].join('\n'),
    },
  ]);

  assert.match(merged, /## Blocking issues\n- \*\*Bad split\*\*\n  - Detail from first chunk\./);
  assert.match(merged, /## Non-blocking issues\n- Nit from first chunk\.\n- Nit from second chunk\./);
  assert.match(merged, /## Suggested fixes\n- Fix the split\.\n- Add a regression test\./);
  assert.match(merged, /## Verdict\nRequest changes/);
  assert.doesNotMatch(merged, /First summary must not be nested/);
  assert.doesNotMatch(merged, /Second summary must not be nested/);
  assert.equal((merged.match(/## Summary/g) || []).length, 1);
});

test('mergeChunkedAgyReviews sanitizes each child before extracting sections', () => {
  const merged = mergeChunkedAgyReviews([
    {
      reviewText: [
        '### Summary',
        'First chunk.',
        '',
        '### Blocking issues:',
        '- **First chunk blocker**',
        '',
        '### Verdict',
        'Request changes',
      ].join('\n'),
    },
    {
      reviewText: [
        '### Summary',
        'Second chunk.',
        '',
        '### Blocking issues:',
        '- **Second chunk blocker**',
        '',
        '### Verdict',
        'Request changes',
      ].join('\n'),
    },
  ]);

  assert.match(merged, /## Blocking issues\n- \*\*First chunk blocker\*\*\n- \*\*Second chunk blocker\*\*/);
  assert.match(merged, /## Verdict\nRequest changes/);
});

test('mergeChunkedAgyReviews derives verdict from merged blocking issues', () => {
  const merged = mergeChunkedAgyReviews([
    {
      reviewText: [
        '## Summary',
        'Child had a stale verdict.',
        '',
        '## Blocking issues',
        '- None.',
        '',
        '## Non-blocking issues',
        '- Worth noting.',
        '',
        '## Suggested fixes',
        '- Optional cleanup.',
        '',
        '## Verdict',
        'Request changes',
      ].join('\n'),
    },
  ]);

  assert.match(merged, /## Blocking issues\n- None\./);
  assert.match(merged, /## Non-blocking issues\n- Worth noting\./);
  assert.match(merged, /## Suggested fixes\n- Optional cleanup\./);
  assert.match(merged, /## Verdict\nComment only/);
});

test('mergeChunkedAgyReviews preserves non-bulleted issue section text as a synthetic bullet', () => {
  const merged = mergeChunkedAgyReviews([
    {
      reviewText: [
        '## Summary',
        'Plain prose child.',
        '',
        '## Blocking issues',
        'This blocking issue lost its bullet formatting.',
        'It still needs to survive merging.',
        '',
        '## Non-blocking issues',
        '- None.',
        '',
        '## Suggested fixes',
        'Use a fallback bullet.',
        '',
        '## Verdict',
        'Request changes',
      ].join('\n'),
    },
  ]);

  assert.match(merged, /## Blocking issues\n- This blocking issue lost its bullet formatting\.\n  It still needs to survive merging\./);
  assert.match(merged, /## Suggested fixes\n- Use a fallback bullet\./);
  assert.match(merged, /## Verdict\nRequest changes/);
});

test('extractMarkdownIssueList keeps indented detail bullets with their parent issue', () => {
  const issues = extractMarkdownIssueList([
    '## Blocking issues',
    '- **Parent issue**',
    '  - **File:** `src/reviewer.mjs`',
    '  - **Problem:** detail should stay nested',
    '- **Second issue**',
    '  - **File:** `test/reviewer.test.mjs`',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n'), 'Blocking issues');

  assert.equal(issues.length, 2);
  assert.match(issues[0], /Parent issue/);
  assert.match(issues[0], /Problem/);
  assert.match(issues[1], /Second issue/);
});

test('oversized agy alert retries transient curl failures before succeeding', async () => {
  const calls = [];
  await alertClioOversizedAgyFailure({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 506,
    promptBytes: 300_000,
    maxBytes: 262_144,
    reason: 'chunking-disabled',
  }, {
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        const err = new Error('curl: (22) The requested URL returned error: 503');
        err.code = 22;
        throw err;
      }
      if (calls.length === 2) {
        const err = new Error('spawn killed after timeout');
        err.killed = true;
        err.signal = 'SIGTERM';
        throw err;
      }
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'curl');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-sS', '-f', '--max-time', '10']);
  assert.equal(calls[0].options.timeout, undefined);
});

test('oversized agy fallback alerts when cross-model route and chunking are unavailable', async () => {
  const diff = 'diff --git a/a.txt b/a.txt\n+' + 'x'.repeat(100);
  const route = resolveAgyOversizedReviewRoute({
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    builderTag: '[pi]',
    diff,
    extraContext: '',
    promptStage: 'first',
    geminiRuntime: 'antigravity',
    maxBytes: 50,
  });
  assert.equal(route.oversized, true);
  assert.equal(route.route, null);

  await assert.rejects(
    () => reviewAgyOversizedInChunks(diff, '', {
      promptStage: 'first',
      promptBytes: route.promptBytes,
      maxBytes: 50,
      maxChunks: 0,
      reviewWithGeminiImpl: async () => {
        throw new Error('must not spawn chunk when chunking is disabled');
      },
    }),
    /chunking unavailable: chunking-disabled/,
  );
});

test('resolveGeminiAntigravityModel: agy uses the display-name token while the cli path keeps its slug', () => {
  const modulePath = join(mkdtempSync(join(tmpdir(), 'agy-model-')), 'config.yaml');
  // Antigravity model comes from reviewer.gemini.model (agy display name).
  writeFileSync(modulePath, 'reviewer:\n  gemini:\n    model: "Gemini 3.1 Pro (High)"\n', 'utf8');
  assert.equal(
    resolveGeminiAntigravityModel({ env: {}, topPath: '/dev/null', modulePaths: [modulePath] }),
    'Gemini 3.1 Pro (High)',
  );
  // Default when unset is the agy display-name token, NOT a cli slug.
  const emptyPath = join(mkdtempSync(join(tmpdir(), 'agy-model-')), 'config.yaml');
  writeFileSync(emptyPath, 'reviewer:\n  gemini:\n    runtime: antigravity\n', 'utf8');
  assert.equal(
    resolveGeminiAntigravityModel({ env: {}, topPath: '/dev/null', modulePaths: [emptyPath] }),
    'Gemini 3.1 Pro (High)',
  );
  // Env override (canonical + legacy alias).
  assert.equal(
    resolveGeminiAntigravityModel({ env: { AGENT_OS_REVIEWER_GEMINI_MODEL: 'Claude Opus 4.6 (Thinking)' }, topPath: '/dev/null', modulePaths: [emptyPath] }),
    'Claude Opus 4.6 (Thinking)',
  );
  assert.equal(
    resolveGeminiAntigravityModel({ env: { ADVERSARIAL_REVIEW_GEMINI_MODEL: 'GPT-OSS 120B (Medium)' }, topPath: '/dev/null', modulePaths: [emptyPath] }),
    'GPT-OSS 120B (Medium)',
  );
  // The gemini-CLI model resolver is unchanged: still a slug.
  assert.equal(
    withEnv({ GEMINI_REVIEWER_MODEL: undefined }, () => resolveGeminiReviewerModel()),
    'gemini-2.5-pro',
  );
  // And buildGeminiReviewArgs (cli path) is untouched.
  assert.deepEqual(
    buildGeminiReviewArgs({ model: 'gemini-2.5-pro' }),
    ['-m', 'gemini-2.5-pro', '-o', 'text', '--prompt', ''],
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

// These generic Gemini reviewer tests pin the cli runtime so host-local
// antigravity config cannot route them through the agy auth preflight; dedicated
// antigravity tests below cover the production agy spawn and auth path.
test('reviewWithGemini happy path returns the captured review text', async () => {
  const captured = [];
  const result = await reviewWithGemini('+diff body\n', 'EXTRA CONTEXT', {
    promptStage: 'first',
    resolveGeminiRuntimeImpl: () => 'cli',
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
  const validAgyReview = '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Summary\nClean.\n\n## Verdict\nComment only';
  const root = mkdtempSync(join(tmpdir(), 'agy-home-'));
  let result;
  try {
    result = await withEnvAsync({
      HOME: root,
      GEMINI_API_KEY: 'must-strip',
      GOOGLE_API_KEY: 'must-strip-too',
    }, () => reviewWithGemini('+diff\n', 'AGY CONTEXT', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'co_1', credentialId: 'cred_1', oauthCreds: { access_token: 'token-1' } }),
      materializeGeminiCheckoutSessionImpl: ({ env }) => ({ env, cleanup() {} }),
      releaseGeminiCredentialCheckoutImpl: async () => {},
      assertAgyAuthImpl: async ({ agyCli, env }) => {
        authCalls.push({ agyCli, env });
      },
      spawnAgyReviewImpl: async ({ agyCli, prompt, model, env, timeout }) => {
        const printTimeoutMs = resolveAgyPrintTimeoutMs(env);
        spawnCalls.push({ agyCli, model, args: buildAgyReviewArgs({ model, prompt, printTimeoutMs }), prompt, env });
        assert.equal(timeout, 1_200_000);
        return { stdout: validAgyReview, stderr: '' };
      },
      spawnGeminiReviewImpl: async () => {
        throw new Error('native gemini must not be called for antigravity runtime');
      },
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(result.reviewText, validAgyReview);
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].agyCli, AGY_CLI);
  assert.equal(authCalls[0].env.HOME, root);
  assert.equal(authCalls[0].env.GEMINI_API_KEY, undefined);
  assert.equal(authCalls[0].env.GOOGLE_API_KEY, undefined);
  assert.equal(authCalls[0].env.GEMINI_OAUTH_ACCESS_TOKEN, undefined);
  assert.equal(authCalls[0].env.GEMINI_ANTIGRAVITY_ACCOUNT, undefined);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].agyCli, AGY_CLI);
  // antigravity runtime resolves the agy display-name token (default), NOT the
  // cli slug, and binds --model BEFORE --print with the prompt as the --print value.
  assert.equal(spawnCalls[0].model, 'Gemini 3.1 Pro (High)');
  const aMi = spawnCalls[0].args.indexOf('--model');
  const aPi = spawnCalls[0].args.indexOf('--print');
  assert.ok(aMi >= 0 && aMi < aPi, '--model must be present and precede --print');
  assert.equal(spawnCalls[0].args[aMi + 1], 'Gemini 3.1 Pro (High)');
  assert.equal(spawnCalls[0].args[aPi + 1], spawnCalls[0].prompt, 'prompt rides on argv as --print value');
  assert.match(spawnCalls[0].prompt, /AGY CONTEXT/);
  assert.match(spawnCalls[0].prompt, /Review the PROVIDED diff/);
  assert.match(spawnCalls[0].prompt, /Do not re-list the repository/);
  assert.match(spawnCalls[0].prompt, /Emit ONLY the final Markdown review block/);
  assert.match(spawnCalls[0].prompt, /```diff\n\+diff/);
  assert.strictEqual(authCalls[0].env, spawnCalls[0].env);
  assert.equal(spawnCalls[0].env.HOME, root);
  assert.equal(spawnCalls[0].env.GEMINI_API_KEY, undefined);
  assert.equal(spawnCalls[0].env.GOOGLE_API_KEY, undefined);
  assert.equal(spawnCalls[0].env.GEMINI_OAUTH_ACCESS_TOKEN, undefined);
  assert.equal(spawnCalls[0].env.GEMINI_ANTIGRAVITY_ACCOUNT, undefined);
});

test('materializeGeminiCheckoutSession writes isolated 0700 session dir and 0600 oauth_creds.json, then cleans up', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-session-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    const session = materializeGeminiCheckoutSession({
      checkout: { checkoutId: 'co_a', credentialId: 'cred_a', oauthCreds: { access_token: 'a', refresh_token: 'ra' } },
      env: { HOME: root },
      sessionParent: parent,
    });
    assert.equal(resolveGeminiReviewerSessionParent({ HOME: root }), parent);
    assert.equal(session.env.GEMINI_HOME, session.sessionDir);
    assert.equal(session.env.GEMINI_OAUTH_CREDS_PATH, session.credsPath);
    assert.equal(statSync(session.sessionDir).mode & 0o777, 0o700);
    assert.equal(statSync(session.credsPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(session.credsPath, 'utf8')), {
      access_token: 'a',
      refresh_token: 'ra',
    });
    session.cleanup();
    assert.equal(existsSync(session.sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeStaleGeminiReviewerSessionDirs removes only stale or dead-owner reviewer session dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-purge-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    const activeSession = join(parent, `review-${process.pid}-active`);
    const deadSession = join(parent, 'review-999999-dead');
    const oldSession = join(parent, 'review-old');
    mkdirSync(activeSession, { recursive: true, mode: 0o700 });
    mkdirSync(deadSession, { recursive: true, mode: 0o700 });
    mkdirSync(oldSession, { recursive: true, mode: 0o700 });
    writeFileSync(join(activeSession, 'owner.json'), `${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`);
    writeFileSync(join(deadSession, 'owner.json'), `${JSON.stringify({ pid: 999999, hostname: hostname() })}\n`);
    mkdirSync(join(parent, 'operator-files'), { recursive: true, mode: 0o700 });
    writeFileSync(join(parent, 'loose.txt'), 'keep\n');
    const oldDate = new Date(Date.now() - (13 * 60 * 60 * 1000));
    utimesSync(oldSession, oldDate, oldDate);
    const result = purgeStaleGeminiReviewerSessionDirs({
      env: { HOME: root },
      isProcessAliveImpl: (pid) => pid === process.pid,
    });
    assert.equal(result.purged, 2);
    assert.equal(existsSync(activeSession), true);
    assert.equal(existsSync(deadSession), false);
    assert.equal(existsSync(oldSession), false);
    assert.equal(existsSync(join(parent, 'operator-files')), true);
    assert.equal(existsSync(join(parent, 'loose.txt')), true);
    assert.equal(statSync(parent).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeStaleGeminiReviewerSessionDirs preserves foreign-host reviewer session dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-purge-foreign-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    const foreignSession = join(parent, 'review-999999-foreign');
    mkdirSync(foreignSession, { recursive: true, mode: 0o700 });
    writeFileSync(join(foreignSession, 'owner.json'), `${JSON.stringify({ pid: 999999, hostname: 'other-host' })}\n`);
    const oldDate = new Date(Date.now() - (13 * 60 * 60 * 1000));
    utimesSync(foreignSession, oldDate, oldDate);
    const result = purgeStaleGeminiReviewerSessionDirs({
      env: { HOME: root },
      isProcessAliveImpl: () => false,
      localHostname: hostname(),
    });
    assert.equal(result.purged, 0);
    assert.equal(existsSync(foreignSession), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeStaleGeminiReviewerSessionDirs ignores EPERM chmod on shared parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-purge-eperm-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const warnings = [];
    const result = purgeStaleGeminiReviewerSessionDirs({
      env: { HOME: root },
      chmodSyncImpl: () => {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.equal(result.sessionParent, parent);
    assert.match(warnings[0], /cannot chmod shared Gemini reviewer path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeStaleGeminiReviewerSessionDirs continues after one stale dir fails to delete', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-purge-error-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    mkdirSync(join(parent, 'review-bad'), { recursive: true, mode: 0o700 });
    mkdirSync(join(parent, 'review-good'), { recursive: true, mode: 0o700 });
    const oldDate = new Date(Date.now() - 1000);
    utimesSync(join(parent, 'review-bad'), oldDate, oldDate);
    utimesSync(join(parent, 'review-good'), oldDate, oldDate);
    const warnings = [];
    const removed = [];
    const result = purgeStaleGeminiReviewerSessionDirs({
      env: { HOME: root },
      staleAgeMs: 0,
      isProcessAliveImpl: () => false,
      rmSyncImpl: (target, options) => {
        if (target.endsWith('review-bad')) {
          throw new Error('permission denied');
        }
        removed.push(target);
        rmSync(target, options);
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.equal(result.purged, 1);
    assert.equal(existsSync(join(parent, 'review-bad')), true);
    assert.equal(existsSync(join(parent, 'review-good')), false);
    assert.deepEqual(removed, [join(parent, 'review-good')]);
    assert.match(warnings[0], /failed to purge stale Gemini reviewer session review-bad/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createGeminiReviewerSessionDir ignores EPERM chmod on shared parent but chmods child', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-create-eperm-'));
  try {
    const parent = join(root, '.gemini', 'reviewer-sessions');
    const chmodTargets = [];
    const warnings = [];
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const created = __test__.createGeminiReviewerSessionDir({
      env: { HOME: root },
      sessionParent: parent,
      chmodSyncImpl: (target, mode) => {
        chmodTargets.push({ target, mode });
        if (target === parent) {
          const err = new Error('operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.equal(existsSync(created), true);
    assert.equal(chmodTargets.some((entry) => entry.target === created && entry.mode === 0o700), true);
    assert.match(warnings[0], /cannot chmod shared Gemini reviewer path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkoutGeminiCredentialFromBroker normalizes checkout response and release reports quota signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-broker-'));
  try {
    const secretPath = join(root, 'secret');
    writeFileSync(secretPath, 'shh\n');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith('/checkout')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            lease: { id: 'co_123' },
            credential_id: 'cred_123',
            access_token: 'tok',
            metadata: { subject: 'redacted' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ released: true }) };
    };
    const env = {
      CQP_BROKER_URL: 'http://broker.local',
      CQP_BROKER_SHARED_SECRET_FILE: secretPath,
      CQP_GEMINI_QUOTA_LIMIT_REQUESTS: 'foo',
      CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
    };
    const checkout = await checkoutGeminiCredentialFromBroker({ env, fetchImpl });
    assert.deepEqual(checkout, {
      checkoutId: 'co_123',
      credentialId: 'cred_123',
      oauthCreds: { access_token: 'tok', expires_at: undefined, metadata: { subject: 'redacted' } },
      releaseUrl: null,
      quotaUrl: null,
    });
    await releaseGeminiCredentialCheckout({ checkout, quotaSignal: true, env, fetchImpl });
    assert.equal(calls[0].url, 'http://broker.local/checkout');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer shh');
    assert.deepEqual(calls[0].body.provider, 'gemini');
    assert.equal(calls[1].url, 'http://broker.local/checkout/release');
    assert.equal(calls[1].body.lease_id, 'co_123');
    assert.equal(calls[1].body.kind, 'quota_exhausted');
    assert.equal(calls[1].body.unit, undefined);
    assert.equal(calls[1].body.limit, undefined);

    await releaseGeminiCredentialCheckout({
      checkout,
      env: {
        CQP_BROKER_URL: 'http://broker.local',
        CQP_GEMINI_QUOTA_LIMIT_REQUESTS: '',
        CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
      },
      fetchImpl,
    });
    assert.equal(calls[2].body.kind, 'release');
    assert.equal(calls[2].body.unit, 'requests');
    assert.equal(calls[2].body.limit, 0);

    await releaseGeminiCredentialCheckout({
      checkout,
      env: {
        CQP_BROKER_URL: 'http://broker.local',
        CQP_GEMINI_QUOTA_LIMIT_REQUESTS: '-1',
        CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
      },
      fetchImpl,
    });
    assert.equal(calls[3].body.kind, 'release');
    assert.equal(calls[3].body.unit, 'requests');
    assert.equal(calls[3].body.limit, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reportGeminiCredentialSpend reports request spend for the checked-out credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-spend-'));
  try {
    const secretPath = join(root, 'secret');
    writeFileSync(secretPath, 'shh\n');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ credential: { credential_id: 'cred_123' } }) };
    };
    await reportGeminiCredentialSpend({
      checkout: { checkoutId: 'co_123', credentialId: 'cred_123' },
      env: {
        CQP_BROKER_URL: 'http://broker.local',
        CQP_BROKER_SHARED_SECRET_FILE: secretPath,
        CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
      },
      fetchImpl,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://broker.local/quota/report');
    assert.equal(calls[0].headers.Authorization, 'Bearer shh');
    assert.deepEqual(calls[0].body, {
      provider: 'gemini',
      credential_id: 'cred_123',
      kind: 'spend',
      unit: 'requests',
      amount: 1,
      window: 'weekly',
      limit: 1000,
      reset_at: '2026-07-13T00:00:00.000Z',
    });
    assert.equal(JSON.stringify(calls), JSON.stringify(calls).replace(/tok|refresh|secret-token/g, ''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('geminiSpendReportsForUsage falls back for invalid quota limits and preserves explicit zero', () => {
  assert.deepEqual(
    geminiSpendReportsForUsage({ total: 12 }, {
      CQP_GEMINI_QUOTA_LIMIT_REQUESTS: 'foo',
      CQP_GEMINI_QUOTA_LIMIT_TOKENS: 'bar',
      CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
    }),
    [
      {
        unit: 'requests',
        amount: 1,
        window: 'weekly',
        limit: 1000,
        reset_at: '2026-07-13T00:00:00.000Z',
      },
      {
        unit: 'tokens',
        amount: 12,
        window: 'weekly',
        limit: 1_000_000,
        reset_at: '2026-07-13T00:00:00.000Z',
      },
    ],
  );

  assert.deepEqual(
    geminiSpendReportsForUsage(null, {
      CQP_GEMINI_QUOTA_LIMIT_REQUESTS: '0',
      CQP_GEMINI_QUOTA_RESET_AT: '2026-07-13T00:00:00.000Z',
    }),
    [{
      unit: 'requests',
      amount: 1,
      window: 'weekly',
      limit: 0,
      reset_at: '2026-07-13T00:00:00.000Z',
    }],
  );
});

test('checkoutGeminiCredentialFromBroker releases checkout when validation fails after allocation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/checkout')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          lease: { id: 'co_bad' },
          credential_id: 'cred_bad',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ released: true }) };
  };
  await assert.rejects(
    () => checkoutGeminiCredentialFromBroker({
      env: { CQP_BROKER_URL: 'http://broker.local' },
      fetchImpl,
    }),
    /broker response missing oauth credential JSON/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://broker.local/checkout/release');
  assert.equal(calls[1].body.lease_id, 'co_bad');
  assert.equal(calls[1].body.credential_id, 'cred_bad');
  assert.equal(calls[1].body.kind, 'release');
});

test('checkoutGeminiCredentialFromBroker treats typed no-credit as deferral, not fallback', async () => {
  await assert.rejects(
    () => checkoutGeminiCredentialFromBroker({
      env: { CQP_BROKER_URL: 'http://broker.local' },
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ type: 'no-credit', reason: 'pool-exhausted' }),
      }),
    }),
    (err) => err instanceof GeminiCredentialPoolNoCreditError && err.isGeminiCredentialPoolNoCredit === true,
  );
});

test('checkoutGeminiCredentialFromBroker formats structured no-credit broker errors', async () => {
  await assert.rejects(
    () => checkoutGeminiCredentialFromBroker({
      env: { CQP_BROKER_URL: 'http://broker.local' },
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: 'quota-exhausted', detail: 'empty pool' } }),
      }),
    }),
    (err) => err instanceof GeminiCredentialPoolNoCreditError
      && err.message.includes('"code":"quota-exhausted"')
      && !err.message.includes('[object Object]'),
  );
});

test('reviewWithGemini antigravity checks out distinct credentials into isolated state dirs and releases them', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-concurrent-'));
  try {
    const checkouts = [
      { checkoutId: 'co_1', credentialId: 'cred_1', oauthCreds: { access_token: 'token-1', refresh_token: 'r1' } },
      { checkoutId: 'co_2', credentialId: 'cred_2', oauthCreds: { access_token: 'token-2', refresh_token: 'r2' } },
    ];
    const spawned = [];
    const released = [];
    const result = await withEnvAsync({ HOME: root }, () => Promise.all([
      reviewWithGemini('+diff one\n', '', {
        resolveGeminiRuntimeImpl: () => 'antigravity',
        checkoutGeminiCredentialImpl: async () => checkouts.shift(),
        releaseGeminiCredentialCheckoutImpl: async ({ checkout }) => { released.push(checkout.checkoutId); },
        assertAgyAuthImpl: async () => {},
        spawnAgyReviewImpl: async ({ env }) => {
          const creds = JSON.parse(readFileSync(env.GEMINI_OAUTH_CREDS_PATH, 'utf8'));
          spawned.push({ sessionDir: env.GEMINI_HOME, credsPath: env.GEMINI_OAUTH_CREDS_PATH, token: creds.access_token });
          return { stdout: '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Verdict\nComment only', stderr: '' };
        },
      }),
      reviewWithGemini('+diff two\n', '', {
        resolveGeminiRuntimeImpl: () => 'antigravity',
        checkoutGeminiCredentialImpl: async () => checkouts.shift(),
        releaseGeminiCredentialCheckoutImpl: async ({ checkout }) => { released.push(checkout.checkoutId); },
        assertAgyAuthImpl: async () => {},
        spawnAgyReviewImpl: async ({ env }) => {
          const creds = JSON.parse(readFileSync(env.GEMINI_OAUTH_CREDS_PATH, 'utf8'));
          spawned.push({ sessionDir: env.GEMINI_HOME, credsPath: env.GEMINI_OAUTH_CREDS_PATH, token: creds.access_token });
          return { stdout: '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Verdict\nComment only', stderr: '' };
        },
      }),
    ]));
    assert.equal(result.length, 2);
    assert.deepEqual(new Set(spawned.map((entry) => entry.token)), new Set(['token-1', 'token-2']));
    assert.equal(new Set(spawned.map((entry) => entry.sessionDir)).size, 2);
    for (const entry of spawned) {
      assert.equal(existsSync(entry.sessionDir), false);
      assert.equal(existsSync(entry.credsPath), false);
    }
    assert.deepEqual(new Set(released), new Set(['co_1', 'co_2']));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireGeminiFallbackLock removes lock dir when owner write fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-lock-owner-'));
  try {
    const writeError = new Error('ENOSPC');
    await assert.rejects(
      () => acquireGeminiFallbackLock({
        env: { HOME: root },
        writeFileSyncImpl: () => {
          throw writeError;
        },
      }),
      (err) => err === writeError,
    );
    assert.equal(existsSync(join(root, '.gemini', 'reviewer-sessions', 'legacy-fallback.lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireGeminiFallbackLock reaps orphaned dead-owner lock and reacquires', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-lock-orphan-'));
  try {
    const lockDir = join(root, '.gemini', 'reviewer-sessions', 'legacy-fallback.lock');
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: 999999, hostname: hostname(), acquiredAt: new Date().toISOString() })}\n`);
    const lock = await acquireGeminiFallbackLock({
      env: { HOME: root },
      isProcessAliveImpl: () => false,
      sleepImpl: async () => {
        throw new Error('should not wait after reaping orphaned lock');
      },
    });
    assert.equal(lock.lockDir, lockDir);
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    lock.release();
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireGeminiFallbackLock preserves foreign-host locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-lock-foreign-'));
  try {
    const lockDir = join(root, '.gemini', 'reviewer-sessions', 'legacy-fallback.lock');
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: 999999, hostname: 'other-host', acquiredAt: new Date().toISOString() })}\n`);
    await assert.rejects(
      () => acquireGeminiFallbackLock({
        env: { HOME: root },
        waitMs: 0,
        isProcessAliveImpl: () => false,
        sleepImpl: async () => {
          throw new Error('should not sleep after timeout');
        },
      }),
      /legacy fallback lock wait timed out/,
    );
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.hostname, 'other-host');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewWithGemini broker unavailable uses serialized legacy fallback lock', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-fallback-'));
  try {
    let active = 0;
    let maxActive = 0;
    const runOne = () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => {
        throw new GeminiCredentialPoolUnavailableError('broker returned HTTP 500');
      },
      assertAgyAuthImpl: async () => {},
      spawnAgyReviewImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        return { stdout: '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Verdict\nComment only', stderr: '' };
      },
    });
    await withEnvAsync({ HOME: root }, () => Promise.all([runOne(), runOne()]));
    assert.equal(maxActive, 1);
    assert.equal(existsSync(join(root, '.gemini', 'reviewer-sessions', 'legacy-fallback.lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewWithGemini releases broker checkout when session materialization fails', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const checkout = {
    checkoutId: 'co_materialize_fail',
    credentialId: 'cred_materialize_fail',
    oauthCreds: { access_token: 'token' },
  };
  const released = [];
  const materializeError = new Error('disk full');
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => checkout,
      materializeGeminiCheckoutSessionImpl: () => {
        throw materializeError;
      },
      releaseGeminiCredentialCheckoutImpl: async ({ checkout: releasedCheckout, quotaSignal }) => {
        released.push({ checkoutId: releasedCheckout.checkoutId, quotaSignal });
      },
      assertAgyAuthImpl: async () => {
        throw new Error('auth must not run after materialization failure');
      },
      spawnAgyReviewImpl: async () => {
        throw new Error('spawn must not run after materialization failure');
      },
    }),
    (err) => err === materializeError,
  );
  assert.deepEqual(released, [{ checkoutId: 'co_materialize_fail', quotaSignal: false }]);
});

test('reviewWithGemini releases broker checkout and cleans session when antigravity auth fails', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const released = [];
  let cleaned = false;
  const authError = new Error('not logged in');
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => ({
        checkoutId: 'co_auth_fail',
        credentialId: 'cred_auth_fail',
        oauthCreds: { access_token: 'token' },
      }),
      materializeGeminiCheckoutSessionImpl: ({ env }) => ({
        env,
        cleanup() {
          cleaned = true;
        },
      }),
      releaseGeminiCredentialCheckoutImpl: async ({ checkout: releasedCheckout, quotaSignal }) => {
        released.push({ checkoutId: releasedCheckout.checkoutId, quotaSignal });
      },
      assertAgyAuthImpl: async () => {
        throw authError;
      },
      spawnAgyReviewImpl: async () => {
        throw new Error('spawn must not run after auth failure');
      },
    }),
    (err) => err === authError,
  );
  assert.deepEqual(released, [{ checkoutId: 'co_auth_fail', quotaSignal: false }]);
  assert.equal(cleaned, true);
});

test('reviewWithGemini cleans local session when broker release throws', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  let cleaned = false;
  const warnings = [];
  const authError = new Error('not logged in');
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => ({
        checkoutId: 'co_release_throw',
        credentialId: 'cred_release_throw',
        oauthCreds: { access_token: 'token' },
      }),
      materializeGeminiCheckoutSessionImpl: ({ env }) => ({
        env,
        cleanup() {
          cleaned = true;
        },
      }),
      releaseGeminiCredentialCheckoutImpl: async () => {
        throw new Error('secret file disappeared');
      },
      assertAgyAuthImpl: async () => {
        throw authError;
      },
      spawnAgyReviewImpl: async () => {
        throw new Error('spawn must not run after auth failure');
      },
      log: { warn: (message) => warnings.push(message) },
    }),
    (err) => err === authError,
  );
  assert.equal(cleaned, true);
  assert.match(warnings[0], /failed to release Gemini credential checkout co_release_throw/);
});

test('reviewWithGemini releases checkout when final spend report config lookup throws', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-spend-finally-'));
  let cleaned = false;
  const released = [];
  const warnings = [];
  try {
    await assert.rejects(
      () => withEnvAsync({ CQP_BROKER_SHARED_SECRET_FILE: join(root, 'missing-secret') }, () => reviewWithGemini('+diff\n', '', {
        resolveGeminiRuntimeImpl: () => 'antigravity',
        checkoutGeminiCredentialImpl: async () => ({
          checkoutId: 'co_spend_throw',
          credentialId: 'cred_spend_throw',
          oauthCreds: { access_token: 'token' },
        }),
        materializeGeminiCheckoutSessionImpl: ({ env }) => ({
          env,
          cleanup() {
            cleaned = true;
          },
        }),
        releaseGeminiCredentialCheckoutImpl: async ({ checkout: releasedCheckout, quotaSignal }) => {
          released.push({ checkoutId: releasedCheckout.checkoutId, quotaSignal });
        },
        assertAgyAuthImpl: async () => {},
        spawnAgyReviewImpl: async () => {
          throw new Error('subprocess failed');
        },
        retryDelaysMs: [],
        log: { warn: (message) => warnings.push(message) },
      })),
      /Gemini exec failed: subprocess failed/,
    );

    assert.equal(cleaned, true);
    assert.deepEqual(released, [{ checkoutId: 'co_spend_throw', quotaSignal: false }]);
    assert.match(warnings[0], /failed to report Gemini credential spend cred_spend_throw/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewWithGemini keeps successful antigravity review when spend report lookup throws', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-spend-success-'));
  let cleaned = false;
  const released = [];
  const warnings = [];
  const reviewText = '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Summary\nClean.\n\n## Verdict\nComment only';
  try {
    const result = await withEnvAsync({
      CQP_BROKER_SHARED_SECRET_FILE: join(root, 'missing-secret'),
    }, () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => ({
        checkoutId: 'co_spend_success_throw',
        credentialId: 'cred_spend_success_throw',
        oauthCreds: { access_token: 'token' },
      }),
      materializeGeminiCheckoutSessionImpl: ({ env }) => ({
        env,
        cleanup() {
          cleaned = true;
        },
      }),
      releaseGeminiCredentialCheckoutImpl: async ({ checkout: releasedCheckout, quotaSignal }) => {
        released.push({ checkoutId: releasedCheckout.checkoutId, quotaSignal });
      },
      assertAgyAuthImpl: async () => {},
      spawnAgyReviewImpl: async () => ({
        stdout: reviewText,
        stderr: '',
        tokenUsage: { total: 42 },
      }),
      retryDelaysMs: [],
      log: { warn: (message) => warnings.push(message) },
    }));

    assert.deepEqual(result, { reviewText, tokenUsage: null });
    assert.equal(cleaned, true);
    assert.deepEqual(released, [{ checkoutId: 'co_spend_success_throw', quotaSignal: false }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to report Gemini credential spend cred_spend_success_throw/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewWithGemini no-credit defers without single-credential fallback', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  await assert.rejects(
    () => reviewWithGemini('+diff\n', '', {
      resolveGeminiRuntimeImpl: () => 'antigravity',
      checkoutGeminiCredentialImpl: async () => {
        throw new GeminiCredentialPoolNoCreditError('pool-exhausted');
      },
      acquireGeminiFallbackLockImpl: async () => {
        throw new Error('fallback lock must not be acquired');
      },
      assertAgyAuthImpl: async () => {
        throw new Error('auth must not run without a credential');
      },
      spawnAgyReviewImpl: async () => {
        throw new Error('spawn must not run without a credential');
      },
    }),
    (err) => err?.isGeminiCredentialPoolNoCredit === true,
  );
});

test('reviewWithGemini reports 429 quota signal to broker and removes synthesized credential material', async () => {
  resetGeminiReviewerSessionPreflightForTest();
  const root = mkdtempSync(join(tmpdir(), 'gemini-cqp-quota-'));
  try {
    const released = [];
    let sessionDir = null;
    let credsPath = null;
    await assert.rejects(
      () => withEnvAsync({ HOME: root }, () => reviewWithGemini('+diff\n', '', {
        resolveGeminiRuntimeImpl: () => 'antigravity',
        checkoutGeminiCredentialImpl: async () => ({
          checkoutId: 'co_quota',
          credentialId: 'cred_quota',
          oauthCreds: { access_token: 'quota-token' },
        }),
        releaseGeminiCredentialCheckoutImpl: async ({ checkout, quotaSignal }) => {
          released.push({ checkoutId: checkout.checkoutId, quotaSignal });
        },
        assertAgyAuthImpl: async () => {},
        spawnAgyReviewImpl: async ({ env }) => {
          sessionDir = env.GEMINI_HOME;
          credsPath = env.GEMINI_OAUTH_CREDS_PATH;
          const err = new Error('Command failed');
          err.stderr = 'HTTP 429 quota exceeded';
          throw err;
        },
      })),
      /Gemini exec failed/,
    );
    assert.deepEqual(released, [{ checkoutId: 'co_quota', quotaSignal: true }]);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(credsPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeAgyReviewOutput rejects narration-only captured output', () => {
  const sample = [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    'I will start by listing the files in the workspace ...',
    'I will run `git log` ...',
    'I will search `hq-common.sh` for the definition of `hq_ensure_python3` ...',
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    'I will list the contents of the workspace directory to orient myself.',
  ].join('\n');

  assert.throws(
    () => sanitizeAgyReviewOutput(sample),
    /without a parseable review verdict/,
  );
});

test('sanitizeAgyReviewOutput rejects agy timeout output instead of posting it', () => {
  const sample = [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    'I will run `git log` ...',
    'Error: timed out waiting for response',
  ].join('\n');

  assert.throws(
    () => sanitizeAgyReviewOutput(sample),
    /error output instead of a review/,
  );
});

test('sanitizeAgyReviewOutput accepts a well-formed agy review with inline verdict', () => {
  const result = sanitizeAgyReviewOutput([
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'No blocking findings.',
    '',
    '## Verdict: Comment only',
  ].join('\n'));

  assert.equal(result, [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'No blocking findings.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n'));
});

test('sanitizeAgyReviewOutput accepts a valid review that discusses error sentinels', () => {
  const result = sanitizeAgyReviewOutput([
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'The reviewed code can print this valid diagnostic:',
    'Error: user configuration is missing',
    '',
    '## Blocking issues',
    '- **Crash path**',
    '  - **Problem:** The service may panic:',
    'panic: nil pointer dereference',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n'));

  assert.match(result, /^## Adversarial Review/m);
  assert.match(result, /^Error: user configuration is missing$/m);
  assert.match(result, /^panic: nil pointer dereference$/m);
  assert.match(result, /^Request changes$/m);
});

test('sanitizeAgyReviewOutput strips narration before a valid agy review block', () => {
  const result = sanitizeAgyReviewOutput([
    'I will inspect the workspace first.',
    'I will run `git log`.',
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'The change is safe.',
    '',
    '## Verdict',
    'Approve',
  ].join('\n'));

  assert.equal(result, [
    '## Adversarial Review — Gemini (gemini-reviewer-lacey)',
    '',
    '## Summary',
    'The change is safe.',
    '',
    '## Verdict',
    'Approve',
  ].join('\n'));
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
      checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'co_1', credentialId: 'cred_1', oauthCreds: { access_token: 'token-1' } }),
      materializeGeminiCheckoutSessionImpl: ({ env }) => ({ env, cleanup() {} }),
      releaseGeminiCredentialCheckoutImpl: async () => {},
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
    checkoutGeminiCredentialImpl: async () => ({ checkoutId: 'co_1', credentialId: 'cred_1', oauthCreds: { access_token: 'token-1' } }),
    materializeGeminiCheckoutSessionImpl: ({ env }) => ({ env, cleanup() {} }),
    releaseGeminiCredentialCheckoutImpl: async () => {},
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
      return { stdout: '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Verdict\nComment only', stderr: '' };
    },
  });

  assert.equal(result.reviewText, '## Adversarial Review — Gemini (gemini-reviewer-lacey)\n\n## Verdict\nComment only');
  assert.deepEqual(spawns, ['agy', 'agy']);
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
      resolveGeminiRuntimeImpl: () => 'cli',
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
      resolveGeminiRuntimeImpl: () => 'cli',
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
    resolveGeminiRuntimeImpl: () => 'cli',
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
  assert.equal(AGY_KEYCHAIN_SERVICE, 'gemini');
  assert.equal(AGY_KEYCHAIN_ACCOUNT, 'antigravity');
  assert.equal(result.keychainItem, `${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT}`);
  assert.notEqual(result.keychainItem, 'Gemini Safe Storage');
  assert.equal(result.probe, 'agy models');
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [
    ['security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity']],
    ['/opt/bin/agy', ['models']],
  ]);
  assert.equal(
    calls.some((call) => call.args.includes('Gemini Safe Storage')),
    false,
  );
  assert.deepEqual(calls.map((call) => call.options.timeout), [1234, 1234]);
  assert.match(AGY_KEYCHAIN_REMEDIATION, /launchd-spawned airlock processes/);
  assert.match(AGY_KEYCHAIN_REMEDIATION, /security set-generic-password-partition-list -S apple-tool:,apple: -s gemini -a antigravity/);
  assert.doesNotMatch(AGY_KEYCHAIN_REMEDIATION, /Gemini Safe Storage/);
});

test('safeExecFile enforces maxBuffer for stderr capture', async () => {
  await assert.rejects(
    () => safeExecFile(process.execPath, [
      '-e',
      'process.stderr.write("x".repeat(2048));',
    ], { maxBuffer: 1024 }),
    (err) => {
      assert.match(err.message, /stderr maxBuffer exceeded \(1024 bytes\)/);
      assert.ok(err.stderr.length <= 1024);
      return true;
    },
  );
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
  assert.equal(missing.keychainItem, 'gemini/antigravity');
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
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
  });
  assert.equal(keychainTimeout.reason, 'keychain-probe-timeout');
  assert.equal(keychainAttempts, 2);

  let bareSigtermAttempts = 0;
  const bareSigterm = await checkAgyReviewerAuth({
    maxAttempts: 3,
    retryBackoffMs: 0,
    execFileImpl: async () => {
      bareSigtermAttempts += 1;
      const err = new Error('terminated');
      err.signal = 'SIGTERM';
      throw err;
    },
  });
  assert.equal(bareSigterm.reason, 'keychain-probe-failed');
  assert.equal(bareSigtermAttempts, 1);

  let agyNetworkAttempts = 0;
  const agyNetworkTransient = await checkAgyReviewerAuth({
    maxAttempts: 3,
    retryBackoffMs: 0,
    execFileImpl: async (command) => {
      if (command === 'security') return { stdout: 'ok', stderr: '' };
      agyNetworkAttempts += 1;
      if (agyNetworkAttempts === 1) {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { stdout: 'gemini-2.5-pro\n', stderr: '' };
    },
  });
  assert.equal(agyNetworkTransient.ok, true);
  assert.equal(agyNetworkAttempts, 2);

  const agyNetworkExhausted = await checkAgyReviewerAuth({
    maxAttempts: 1,
    execFileImpl: async (command) => {
      if (command === 'security') return { stdout: 'ok', stderr: '' };
      const err = new Error('TLS handshake failed');
      err.code = 'ECONNRESET';
      throw err;
    },
  });
  assert.equal(agyNetworkExhausted.reason, 'agy-probe-transient');
  assert.doesNotMatch(agyNetworkExhausted.remediation, /partition-list/);

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
  assert.equal(timeout.remediation, AGY_TRANSIENT_REMEDIATION);
  assert.doesNotMatch(timeout.remediation, /partition-list/);
});

test('checkAgyReviewerAuth caches successful preflights for the configured ttl', async () => {
  clearAgyReviewerAuthCache();
  let calls = 0;
  const agyCli = '/opt/homebrew/bin/agy';
  const execFileImpl = async (command) => {
    calls += 1;
    if (command === 'security') return { stdout: 'ok', stderr: '' };
    if (command === agyCli) return { stdout: 'gemini-2.5-pro\n', stderr: '' };
    throw new Error(`unexpected command ${command}`);
  };
  const opts = {
    agyCli,
    env: { HOME: '/Users/airlock', LOGNAME: 'airlock', PATH: '/opt/bin', USER: 'airlock' },
    execFileImpl,
    cacheSuccess: true,
    successTtlMs: 1_000,
  };
  try {
    const first = await checkAgyReviewerAuth({ ...opts, nowMs: 1_000 });
    const second = await checkAgyReviewerAuth({ ...opts, nowMs: 1_500 });
    const third = await checkAgyReviewerAuth({ ...opts, nowMs: 2_001 });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(third.ok, true);
    assert.equal(third.cached, undefined);
    assert.equal(calls, 4);
  } finally {
    clearAgyReviewerAuthCache();
  }
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
