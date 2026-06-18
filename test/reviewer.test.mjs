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
  evaluateLocalReviewShadowEligibility,
  recordLocalReviewShadowRequestAfterHostedPost,
  reconcileLocalReviewShadowRequest,
  startLocalReviewShadowReconciliation,
  formatLocalReviewShadowArtifact,
  localReviewShadowPaths,
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

test('local-review-shadow label preserves hosted reviewer choice and records durable request', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-record-'));
  try {
    const env = { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' };
    const beforeHostedReviewer = 'claude';
    const result = recordLocalReviewShadowRequestAfterHostedPost({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 88,
      headSha: 'abc123',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'codex',
      hostedReviewerModel: beforeHostedReviewer,
      hostedPostedAt: '2026-06-18T12:00:00.000Z',
      diff: '+diff',
      hostedReviewBody: 'hosted body',
      env,
      log: { log() {}, warn() {} },
    });

    assert.equal(beforeHostedReviewer, 'claude');
    assert.equal(result.recorded, true);
    assert.equal(result.eligible, true);
    const request = JSON.parse(readFileSync(result.requestPath, 'utf8'));
    assert.equal(request.status, 'pending');
    assert.equal(request.hostedReviewerModel, 'claude');
    assert.equal(request.builderTag, 'codex');
    assert.equal(request.eligibility.localFamily, 'oss');
    assert.equal(existsSync(request.inputPath), true);
    const input = JSON.parse(readFileSync(request.inputPath, 'utf8'));
    assert.equal(input.diff, '+diff');
    assert.equal(input.hostedReviewBody, 'hosted body');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow absent label leaves behavior unchanged and writes no request', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-absent-'));
  try {
    const result = recordLocalReviewShadowRequestAfterHostedPost({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 89,
      headSha: 'abc123',
      labels: [],
      builderTag: 'codex',
      hostedReviewerModel: 'claude',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
    });
    assert.deepEqual(result, { recorded: false, reason: 'label-absent' });
    const paths = localReviewShadowPaths(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 89,
      headSha: 'abc123',
      label: LOCAL_REVIEW_SHADOW_LABEL,
    });
    assert.equal(existsSync(paths.requestPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow family guard fails closed for codex, claude-code, and clio-agent when family is missing or same-family', () => {
  for (const builderTag of ['codex', 'claude-code', 'clio-agent']) {
    const missing = evaluateLocalReviewShadowEligibility({
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag,
      hostedReviewerModel: builderTag === 'claude-code' ? 'codex' : 'claude',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'unlisted-local-model' },
    });
    assert.equal(missing.eligible, false, `${builderTag} missing metadata must fail closed`);
    assert.equal(missing.reason, 'local-shadow-family-unproven');
  }

  const sameCodex = evaluateLocalReviewShadowEligibility({
    labels: [LOCAL_REVIEW_SHADOW_LABEL],
    builderTag: 'clio-agent',
    hostedReviewerModel: 'claude',
    env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-codex-family-reviewer' },
  });
  assert.equal(sameCodex.eligible, false);
  assert.equal(sameCodex.reason, 'local-shadow-family-not-distinct');

  const sameClaude = evaluateLocalReviewShadowEligibility({
    labels: [LOCAL_REVIEW_SHADOW_LABEL],
    builderTag: 'claude-code',
    hostedReviewerModel: 'codex',
    env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-claude-family-reviewer' },
  });
  assert.equal(sameClaude.eligible, false);
  assert.equal(sameClaude.reason, 'local-shadow-family-not-distinct');
});

test('local-review-shadow skipped request does not persist diff or hosted review payload', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-skip-no-input-'));
  try {
    const result = recordLocalReviewShadowRequestAfterHostedPost({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 94,
      headSha: 'abc123',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'codex',
      hostedReviewerModel: 'claude',
      hostedPostedAt: '2026-06-18T12:00:00.000Z',
      diff: '+private source',
      hostedReviewBody: 'hosted body with private context',
      env: {},
      log: { log() {}, warn() {} },
    });

    assert.equal(result.recorded, true);
    assert.equal(result.eligible, false);
    const request = JSON.parse(readFileSync(result.requestPath, 'utf8'));
    assert.equal(request.status, 'skipped');
    assert.equal(request.inputPath, undefined);
    const paths = localReviewShadowPaths(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 94,
      headSha: 'abc123',
      label: LOCAL_REVIEW_SHADOW_LABEL,
    });
    assert.equal(existsSync(paths.inputPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow durable request is written before shadow execution starts', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-sequence-'));
  try {
    const calls = [];
    const result = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 90,
      headSha: 'def456',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'codex',
      hostedReviewerModel: 'claude',
      hostedPostedAt: '2026-06-18T12:00:00.000Z',
      diff: '+change',
      hostedReviewBody: 'hosted review body',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async () => {
        calls.push('fetch');
        const paths = localReviewShadowPaths(rootDir, {
          repo: 'laceyenterprises/adversarial-review',
          prNumber: 90,
          headSha: 'def456',
          label: LOCAL_REVIEW_SHADOW_LABEL,
        });
        assert.equal(existsSync(paths.requestPath), true);
        const request = JSON.parse(readFileSync(paths.requestPath, 'utf8'));
        assert.equal(request.status, 'pending');
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'local model notes' } }] };
          },
        };
      },
    });
    assert.equal(result.action, 'completed');
    assert.deepEqual(calls, ['fetch']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow crash recovery completes missing artifact idempotently without reposting hosted review', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-recover-'));
  try {
    const request = recordLocalReviewShadowRequestAfterHostedPost({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 91,
      headSha: 'feedbeef',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'clio-agent',
      hostedReviewerModel: 'claude',
      diff: '+persisted recovery diff',
      hostedReviewBody: 'persisted hosted review',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
    });
    assert.equal(JSON.parse(readFileSync(request.requestPath, 'utf8')).status, 'pending');

    let fetchCount = 0;
    const completed = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 91,
      headSha: 'feedbeef',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'clio-agent',
      hostedReviewerModel: 'claude',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async (_url, init) => {
        fetchCount += 1;
        const body = JSON.parse(init.body);
        assert.match(body.messages[0].content, /\+persisted recovery diff/);
        assert.match(body.messages[0].content, /persisted hosted review/);
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'recovered shadow review' } }] };
          },
        };
      },
    });
    assert.equal(completed.action, 'completed');
    assert.equal(fetchCount, 1);

    const idempotent = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 91,
      headSha: 'feedbeef',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'clio-agent',
      hostedReviewerModel: 'claude',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error('should not fetch after completion');
      },
    });
    assert.equal(idempotent.action, 'unchanged');
    assert.equal(idempotent.reason, 'already-completed');
    assert.equal(fetchCount, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow timeout or unavailable LiteLLM records retryable warning state', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-timeout-'));
  try {
    const warnings = [];
    const result = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 92,
      headSha: 'badc0de',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'claude-code',
      hostedReviewerModel: 'codex',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn(message) { warnings.push(String(message)); } },
      fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }),
    });
    assert.equal(result.action, 'retryable');
    assert.match(result.reason, /HTTP 503/);
    assert.match(result.nextAttemptAt, /^20/);
    assert.equal(warnings.some((line) => line.includes('"event":"local-review-shadow"') && line.includes('"action":"retryable"')), true);
    const request = JSON.parse(readFileSync(result.requestPath, 'utf8'));
    assert.equal(request.status, 'retryable');
    assert.match(request.lastError, /HTTP 503/);
    assert.equal(request.attemptCount, 1);
    assert.equal(request.nextAttemptAt, result.nextAttemptAt);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow rejects non-loopback LiteLLM endpoints before sending review payload', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-remote-url-'));
  try {
    let fetchCalled = false;
    const result = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 96,
      headSha: 'badhost',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'codex',
      hostedReviewerModel: 'claude',
      diff: '+private source',
      hostedReviewBody: 'hosted review body',
      env: {
        LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer',
        LOCAL_REVIEW_SHADOW_URL: 'https://example.com/v1/chat/completions',
      },
      log: { log() {}, warn() {} },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('remote endpoint must not be called');
      },
    });

    assert.equal(result.action, 'retryable');
    assert.match(result.reason, /loopback host/);
    assert.equal(fetchCalled, false);
    const request = JSON.parse(readFileSync(result.requestPath, 'utf8'));
    assert.equal(request.status, 'retryable');
    assert.match(request.lastError, /loopback host/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow watcher starter respects retry backoff and does not invoke LiteLLM inline', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'local-review-shadow-start-backoff-'));
  try {
    const first = await reconcileLocalReviewShadowRequest({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 95,
      headSha: 'badcafe',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'claude-code',
      hostedReviewerModel: 'codex',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }),
    });
    assert.equal(first.action, 'retryable');

    let fetchStarted = false;
    const deferred = startLocalReviewShadowReconciliation({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 95,
      headSha: 'badcafe',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'claude-code',
      hostedReviewerModel: 'codex',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async () => {
        fetchStarted = true;
        throw new Error('should be deferred by backoff');
      },
      nowMs: Date.parse(first.nextAttemptAt) - 1,
    });
    assert.equal(deferred.action, 'deferred');
    assert.equal(deferred.reason, 'retry-backoff');
    assert.equal(fetchStarted, false);

    const started = startLocalReviewShadowReconciliation({
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 95,
      headSha: 'badcafe',
      labels: [LOCAL_REVIEW_SHADOW_LABEL],
      builderTag: 'claude-code',
      hostedReviewerModel: 'codex',
      env: { LOCAL_REVIEW_SHADOW_MODEL: 'local-oss-reviewer' },
      log: { log() {}, warn() {} },
      fetchImpl: async () => {
        fetchStarted = true;
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'local notes' } }] };
          },
        };
      },
      nowMs: Date.parse(first.nextAttemptAt) + 1,
    });
    assert.equal(started.action, 'started');
    assert.equal(fetchStarted, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchStarted, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local-review-shadow artifact provenance is explicitly non-gating and local-model generated', () => {
  const artifact = formatLocalReviewShadowArtifact({
    request: {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 93,
      headSha: 'cafe',
      label: LOCAL_REVIEW_SHADOW_LABEL,
      hostedReviewerModel: 'claude',
    },
    eligibility: {
      localModel: 'local-oss-reviewer',
      localFamily: 'oss',
    },
    reviewText: 'A local observation.',
    completedAt: '2026-06-18T12:30:00.000Z',
  });
  assert.match(artifact, /Local Review Shadow \(Non-Gating\)/);
  assert.match(artifact, /generated by a local OSS model through LiteLLM/);
  assert.match(artifact, /hosted adversarial reviewer remains the merge-blocking verdict/);
  assert.doesNotMatch(artifact, /^## Adversarial Review/m);
});
