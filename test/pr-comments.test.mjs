import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMEDIATION_COMMENT_MARKER_PREFIX,
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  buildRemediationOutcomeCommentBody,
  buildRemediationOutcomeCommentMarker,
  extractRemediationCommentMarker,
  findExistingRemediationComment,
  postRemediationOutcomeComment,
  resolveCommentBotTokenEnv,
} from '../src/pr-comments.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    builderTag: 'claude-code',
    reviewerModel: 'codex',
    remediationPlan: {
      currentRound: 2,
      maxRounds: 6,
    },
    ...overrides,
  };
}

test('resolveCommentBotTokenEnv maps known worker classes to their bot env vars', () => {
  assert.equal(resolveCommentBotTokenEnv('codex'), 'GH_CODEX_REVIEWER_TOKEN');
  assert.equal(resolveCommentBotTokenEnv('claude-code'), 'GH_CLAUDE_REVIEWER_TOKEN');
});

test('resolveCommentBotTokenEnv returns null for unknown worker classes', () => {
  assert.equal(resolveCommentBotTokenEnv('not-a-class'), null);
  assert.equal(resolveCommentBotTokenEnv(undefined), null);
});

test('WORKER_CLASS_TO_BOT_TOKEN_ENV covers every known remediation worker class', () => {
  // Tripwire: keep this in lockstep with REMEDIATION_WORKER_IDENTITY_DEFAULTS
  // in src/follow-up-remediation.mjs. If a new class lands there but no
  // bot-token mapping exists here, comment posting will silently skip for
  // that class — which the test surfaces immediately.
  const knownClasses = new Set(['codex', 'claude-code']);
  for (const cls of knownClasses) {
    assert.ok(
      WORKER_CLASS_TO_BOT_TOKEN_ENV[cls],
      `worker class "${cls}" must have a bot-token env mapping`
    );
  }
});

test('buildRemediationOutcomeCommentBody on completed includes summary, validation, and re-review queued', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Tightened null handling in the API layer.',
      validation: ['npm test', 'manual smoke of /v1/users'],
      blockers: [],
    },
    // Watcher accepted the rereview reset (status reset to pending).
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'Want adversarial confirmation.' },
  });
  assert.match(body, /Remediation Worker \(claude-code\) — round 2 of 6/);
  assert.match(body, /Outcome:.*completed.*re-review queued/);
  // Worker-supplied summary/validation/blockers are now fenced (`text)
  // so injected markdown / mentions / autolinks are inert.
  assert.match(body, /Tightened null handling in the API layer/);
  assert.match(body, /```text\nnpm test\n```/);
  assert.match(body, /```text\nmanual smoke of \/v1\/users\n```/);
  // rereview.reason is rendered inline-safe (backtick-wrapped) so a
  // worker can't smuggle a mention or autolink into the status line.
  assert.match(body, /Re-review status:\*\*\s*queued — `Want adversarial confirmation\.`/);
  assert.match(body, /Job: `lac__demo-pr-7-2026-05-01T20-00-00-000Z`/);
});

test('buildRemediationOutcomeCommentBody on completed reports already-pending when no reset was needed', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Fixed.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: false, status: 'already-pending', reason: 'Worker wants confirmation.' },
  });
  assert.match(body, /re-review already pending — no reset needed/);
  assert.match(body, /Re-review status:\*\*\s*already pending/);
});

test('buildRemediationOutcomeCommentBody on stopped (rereview-blocked) flags the watcher refusal', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'rereview-blocked' } },
    },
    reply: {
      outcome: 'completed',
      summary: 'Worker thought it was done.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: {
      requested: true,
      triggered: false,
      status: 'blocked',
      outcomeReason: 'review-row-missing',
      reason: 'Worker wants confirmation.',
    },
  });
  assert.match(body, /Outcome:.*stopped.*rereview-blocked/);
  assert.match(body, /Human intervention required/);
  assert.match(body, /watcher refused the reset.*review-row-missing/);
  assert.match(body, /Re-review status:\*\*\s*\*\*BLOCKED\*\*\s*\(`review-row-missing`\)/);
});

test('buildRemediationOutcomeCommentBody on stopped (max-rounds-reached) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob({ builderTag: 'codex', reviewerModel: 'claude' }),
      remediationPlan: {
        currentRound: 6,
        maxRounds: 6,
        stop: { code: 'max-rounds-reached' },
      },
    },
    reply: {
      outcome: 'partial',
      summary: 'Addressed two of three findings; the third needs schema migration.',
      validation: [],
      blockers: ['Schema migration requires DBA review'],
    },
  });
  assert.match(body, /round 6 of 6/);
  assert.match(body, /Outcome:.*stopped.*max-rounds-reached/);
  assert.match(body, /Human intervention required/);
  assert.match(body, /exhausted its bounded round cap/);
  assert.match(body, /Blockers/);
  assert.match(body, /```text\nSchema migration requires DBA review\n```/);
  // No re-review requested in this state.
  assert.match(body, /Re-review requested:\*\*\s*no/);
});

test('buildRemediationOutcomeCommentBody on stopped (worker chose blocked) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'Cannot proceed without secrets the worker does not have.',
      validation: [],
      blockers: ['Missing OP_SERVICE_ACCOUNT_TOKEN'],
    },
  });
  assert.match(body, /Human intervention required/);
  assert.match(body, /worker reported blockers it could not resolve/);
});

test('buildRemediationOutcomeCommentBody on failed surfaces the failure code and message', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    failure: { code: 'invalid-remediation-reply', message: 'Remediation reply summary is required' },
  });
  assert.match(body, /Outcome:.*failed/);
  assert.match(body, /Reason: `Remediation reply summary is required`/);
  assert.match(body, /Human intervention required/);
});

test('postRemediationOutcomeComment posts via gh pr comment with the bot token in env', async () => {
  const calls = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: '### Remediation Worker (claude-code) — round 1\n\nSummary',
    env: { GH_CLAUDE_REVIEWER_TOKEN: 'test-pat-claude', PATH: '/usr/bin' },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr', 'comment', '7', '--repo', 'laceyenterprises/demo', '--body',
    '### Remediation Worker (claude-code) — round 1\n\nSummary',
  ]);
  // The bot PAT is exposed to the gh CLI via GH_TOKEN, scoped to this exec.
  assert.equal(calls[0].options.env.GH_TOKEN, 'test-pat-claude');
});

test('postRemediationOutcomeComment passes only an allowlisted env to gh', async () => {
  // The daemon's parent env carries unrelated high-value secrets. The gh
  // subprocess must NOT see them. Only PATH, HOME, and the selected
  // GH_TOKEN should reach the child.
  const calls = [];
  await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: 'x',
    env: {
      GH_CLAUDE_REVIEWER_TOKEN: 'test-pat-claude',
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/test',
      // High-value secrets that must NOT leak into the child:
      OP_SERVICE_ACCOUNT_TOKEN: 'op-secret-XXXXX',
      GITHUB_TOKEN: 'operator-pat-YYYYY',
      GH_CODEX_REVIEWER_TOKEN: 'codex-bot-pat-ZZZZZ',
      ANTHROPIC_AUTH_TOKEN: 'oauth-bearer-WWWWW',
      // Other unrelated env that's also unnecessary:
      LINEAR_API_KEY: 'linear-pat-AAAAA',
      LANG: 'en_US.UTF-8',
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  const childEnv = calls[0].options.env;
  assert.deepEqual(
    Object.keys(childEnv).sort(),
    ['GH_TOKEN', 'HOME', 'PATH'],
    `child env must be exactly the allowlist; got: ${Object.keys(childEnv).join(', ')}`
  );
  assert.equal(childEnv.GH_TOKEN, 'test-pat-claude');
  assert.equal(childEnv.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(childEnv.HOME, '/Users/test');
  assert.equal(childEnv.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.GH_CODEX_REVIEWER_TOKEN, undefined);
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(childEnv.LINEAR_API_KEY, undefined);
});

test('postRemediationOutcomeComment skips with token-env-missing when the env var is absent', async () => {
  // Capture the log call so we know we surfaced it instead of silently swallowing.
  const errors = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: 'whatever',
    env: { PATH: '/usr/bin' }, // no GH_CLAUDE_REVIEWER_TOKEN
    execFileImpl: async () => {
      throw new Error('execFile must not be called when token env is missing');
    },
    log: { error: (msg) => errors.push(msg) },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'token-env-missing');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.ok(errors.length > 0, 'missing token env should be logged');
});

test('postRemediationOutcomeComment skips with no-token-mapping for unknown worker class', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'gemini', // not in WORKER_CLASS_TO_BOT_TOKEN_ENV today
    body: 'whatever',
    env: {},
    execFileImpl: async () => {
      throw new Error('execFile must not be called when no token mapping exists');
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'no-token-mapping');
  assert.equal(result.workerClass, 'gemini');
});

test('postRemediationOutcomeComment swallows gh-cli failures and reports them in the result', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body: 'whatever',
    env: { GH_CODEX_REVIEWER_TOKEN: 'test-pat-codex' },
    execFileImpl: async () => {
      const err = new Error('HTTP 502: bad gateway');
      throw err;
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'gh-cli-failure');
  assert.match(result.error, /HTTP 502/);
});

test('postRemediationOutcomeComment skips when repo or prNumber is missing', async () => {
  const result = await postRemediationOutcomeComment({
    repo: null,
    prNumber: 7,
    workerClass: 'codex',
    body: 'x',
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'missing-pr-coordinates');
});

// ── Worker-supplied content is redacted before posting ───────────────────────

test('buildRemediationOutcomeCommentBody redacts tokens in the worker summary', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      // Worker echoed an OpenAI-shaped key, a GitHub PAT, and a labelled
      // secret from a log line into its summary. None of these may
      // appear verbatim in the public PR comment.
      summary: 'Fixed the env loader. Logs showed sk-test_abcdef1234567 and ghp_aaaabbbbccccdddd1234 — also api_key=ZZZZZZZZZ.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /sk-test_abcdef1234567/);
  assert.doesNotMatch(body, /ghp_aaaabbbbccccdddd1234/);
  assert.doesNotMatch(body, /api_key=ZZZZZZZZZ/i);
  assert.match(body, /\[REDACTED_OPENAI_TOKEN\]/);
  assert.match(body, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(body, /api_key=\[REDACTED\]/);
});

test('buildRemediationOutcomeCommentBody redacts tokens in validation and blockers entries', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Done.',
      validation: ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://example.com/api'],
      blockers: ['Could not verify token sk-ant-test_xxxxxxxxxxxxxxxxxxxx — please rotate'],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /eyJhbGciOiJIUzI1NiJ9\.payload\.sig/);
  assert.doesNotMatch(body, /sk-ant-test_xxxxxxxxxxxxxxxxxxxx/);
  assert.match(body, /Bearer \[REDACTED\]/);
  assert.match(body, /\[REDACTED_ANTHROPIC_TOKEN\]/);
});

test('buildRemediationOutcomeCommentBody caps a runaway summary at the configured length', () => {
  const huge = 'A'.repeat(50_000);
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: huge, validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // The summary section must not contain the entire 50K-char run; the
  // truncation marker (…) must appear instead.
  assert.ok(body.length < 10_000, `body should be capped well below the runaway summary; got ${body.length} chars`);
  assert.match(body, /…/);
});

test('buildRemediationOutcomeCommentBody caps the validation/blockers list size', () => {
  const items = Array.from({ length: 200 }, (_, i) => `step-${i}`);
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: items, blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Cap is 25 entries; step-25 onwards must be truncated. Each entry
  // is rendered as a fenced bullet so the literal step text appears
  // inside `text` blocks.
  assert.match(body, /```text\nstep-0\n```/);
  assert.match(body, /```text\nstep-24\n```/);
  assert.doesNotMatch(body, /```text\nstep-25\n```/);
  assert.doesNotMatch(body, /```text\nstep-100\n```/);
});

test('buildRemediationOutcomeCommentBody redacts tokens in the rereview reason', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'Need to verify ghp_aaaaaaaaaaaaaaaaaaaa works after rotation',
    },
  });
  assert.doesNotMatch(body, /ghp_aaaaaaaaaaaaaaaaaaaa/);
  // Inline-safe rendering: backtick-wrapped so any markdown the worker
  // tries to smuggle stays inert. Token still got redacted before the
  // backtick wrap.
  assert.match(body, /Re-review status:.*queued — `Need to verify \[REDACTED_GITHUB_TOKEN\] works after rotation`/);
});

// ── Markdown injection mitigations ────────────────────────────────────────

test('worker @mentions inside summary do not render as live mentions (rendered inside fenced code block)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Pinging @paul-lacey and @laceyenterprises/security to follow up.',
      validation: ['ran @ci/tests'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // The worker's literal text must be present (so the operator still
  // sees what the worker tried to say) but inside a fenced block, so
  // GitHub renders it as plaintext rather than firing notifications.
  assert.match(body, /```text\nPinging @paul-lacey and @laceyenterprises\/security to follow up\.\n```/);
  assert.match(body, /```text\nran @ci\/tests\n```/);
});

test('worker injection of headings or task lists is inert (rendered inside fenced code block)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: '# Hijacked H1 heading\n- [x] Forged task item\n<img src=x onerror=alert(1)>',
      validation: ['## not actually a heading'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Heading / list / HTML stays inert because it's inside the fence.
  assert.match(body, /```text\n# Hijacked H1 heading\n- \[x\] Forged task item\n<img src=x onerror=alert\(1\)>\n```/);
  assert.match(body, /```text\n## not actually a heading\n```/);
});

test('worker text containing backticks does not break out of the fence (auto-grown fence width)', () => {
  // A worker that drops a "```" run inside its summary would terminate
  // a 3-backtick fence early and re-enable rendering of subsequent
  // content. The fence width must auto-grow to be longer than any
  // backtick run in the content.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Run ```bash\necho hi\n``` to see output',
      validation: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Fence must be at least 4 backticks (one more than the longest run
  // inside the content).
  assert.match(body, /````text\nRun ```bash\necho hi\n``` to see output\n````/);
});

test('rereview.reason with worker-injected mention is wrapped inline-safe (no live mention)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'cc @paul-lacey for visibility',
    },
  });
  // Inline backtick wrap renders the @mention as plain text, not a
  // GitHub notification. The `@` is still visible to humans reading
  // the rendered comment.
  assert.match(body, /Re-review status:.*queued — `cc @paul-lacey for visibility`/);
});

// ── Failure message path redaction (R3 review #3) ─────────────────────────

test('failure.message has absolute /Users/<user>/ paths masked before posting', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'invalid-remediation-reply',
      message: 'Failed to read remediation reply artifact at /Users/airlock/agent-os/tools/adversarial-review/data/follow-up-jobs/workspaces/laceyenterprises__demo-pr-7-2026-05-01T20-00-00-000Z/.adversarial-follow-up/remediation-reply.json',
    },
  });
  // Host filesystem layout must not appear verbatim.
  assert.doesNotMatch(body, /\/Users\/airlock/);
  assert.doesNotMatch(body, /agent-os\/tools\/adversarial-review/);
  // The basename survives so an operator can recognize the artifact.
  assert.match(body, /<path-redacted>\/remediation-reply\.json/);
});

test('failure.message has /private/var/folders/... temp paths masked', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'invalid-output-path',
      message: 'Path escapes follow-up job root: /private/var/folders/k7/xyz123/T/adversarial-review-abc/data/oops.txt',
    },
  });
  assert.doesNotMatch(body, /\/private\/var\/folders/);
  assert.match(body, /<path-redacted>\/oops\.txt/);
});

test('failure.message has tokens redacted (defense in depth — internal exceptions can echo log lines)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'gh-cli-failure',
      message: 'Command failed: GH_TOKEN=ghp_deadbeefcafebabe1234 gh pr comment...',
    },
  });
  assert.doesNotMatch(body, /ghp_deadbeefcafebabe1234/);
  assert.match(body, /\[REDACTED_GITHUB_TOKEN\]/);
});

test('failure.message preserves non-path identifiers (code names like manual-inspection-required)', () => {
  // Non-path failure codes stay intact — they're our own structured
  // identifiers and operators rely on them in runbooks.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: { code: 'manual-inspection-required', message: 'Worker PID 8123 still running past runtime cap' },
  });
  assert.match(body, /Reason: `Worker PID 8123 still running past runtime cap`/);
});

// ── Worker-supplied PUBLIC field path redaction (review #1 of PR #18) ──────
// Worker output crosses the trust boundary into a public PR comment. Beyond
// tokens, it can echo absolute filesystem paths from logs / stack traces —
// /Users/<operator>/..., /private/var/folders/... — which leak operator
// usernames, repo layout, and machine-local filesystem details. The
// public-safe path masking must run on every worker-supplied field that
// reaches the comment body.

test('summary redacts /Users/<user>/... paths echoed by the worker', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Read prompt at /Users/airlock/agent-os/tools/adversarial-review/.adversarial-follow-up/prompt.md and patched it.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/Users\/airlock/);
  assert.doesNotMatch(body, /agent-os\/tools\/adversarial-review/);
  // Basename survives so an operator can still recognize what was referenced.
  assert.match(body, /<path-redacted>\/prompt\.md/);
});

test('validation entries redact /private/var/folders/... temp paths', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'ok',
      validation: [
        'wrote scratch artifact at /private/var/folders/k7/abc123/T/foo/artifact.json then removed it',
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/private\/var\/folders/);
  assert.match(body, /<path-redacted>\/artifact\.json/);
});

test('blockers entries redact /home/<user>/... paths (Linux operator path)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob({ builderTag: 'codex' }),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'cannot proceed',
      validation: [],
      blockers: [
        'Cannot read /home/runner/work/adversarial-review/data/reviews.db — permission denied',
      ],
    },
  });
  assert.doesNotMatch(body, /\/home\/runner/);
  assert.match(body, /<path-redacted>\/reviews\.db/);
});

test('reReview.reason redacts host-local paths inline (in the status line)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'Confirm fix at /Users/placey/agent-os/tools/adversarial-review/src/pr-comments.mjs',
    },
  });
  assert.doesNotMatch(body, /\/Users\/placey/);
  // Basename survives in the inline-wrapped status line.
  assert.match(body, /Re-review status:.*queued — `Confirm fix at <path-redacted>\/pr-comments\.mjs`/);
});

// ── Idempotency marker (review #4 of PR #18) ───────────────────────────────

test('buildRemediationOutcomeCommentMarker derives a stable id from jobId+round+action', () => {
  const a = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  const b = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  assert.equal(a, b, 'same inputs must produce the same marker');
  assert.ok(a.startsWith(REMEDIATION_COMMENT_MARKER_PREFIX + ':'), 'marker carries the well-known prefix');

  const different = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 3,
    action: 'completed',
  });
  assert.notEqual(a, different, 'different round must produce a different marker');
});

test('comment body includes the dedupe marker as an HTML comment', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const expectedMarker = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  assert.ok(
    body.includes(`<!-- ${expectedMarker} -->`),
    `body must embed the marker as an HTML comment; got:\n${body}`
  );
  assert.equal(extractRemediationCommentMarker(body), expectedMarker);
});

test('postRemediationOutcomeComment skips the create when an existing comment carries the marker', async () => {
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const marker = extractRemediationCommentMarker(body);
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async ({ marker: lookupMarker }) => {
      assert.equal(lookupMarker, marker, 'dedup lookup must search by the body marker');
      return { found: true, marker: lookupMarker, commentId: 12345 };
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.deduped, true);
  assert.equal(result.commentId, 12345);
  assert.equal(calls.length, 0, 'must not invoke gh pr comment when a duplicate already exists');
});

test('postRemediationOutcomeComment posts when the dedup lookup finds nothing', async () => {
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async () => ({ found: false }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.deduped, undefined);
  assert.equal(calls.length, 1, 'must invoke gh pr comment exactly once when no duplicate is found');
  assert.equal(calls[0].args[0], 'pr');
  assert.equal(calls[0].args[1], 'comment');
});

test('postRemediationOutcomeComment falls through to post when the dedup lookup itself fails', async () => {
  // A flake in the lookup path must NOT silently suppress the post —
  // we'd rather risk a duplicate than leave the PR with no comment.
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async () => ({ found: false, lookupFailed: true, reason: 'lookup-timeout' }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(calls.length, 1, 'lookup failure must not block the post');
});

test('findExistingRemediationComment finds the marker in a previously-posted comment', async () => {
  const calls = [];
  const result = await findExistingRemediationComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    marker: 'adversarial-review-remediation-marker:job-x:r2:completed',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        stdout:
          '{"id":1,"body":"unrelated comment"}\n' +
          '{"id":2,"body":"<!-- adversarial-review-remediation-marker:job-x:r2:completed -->\\nSome body"}\n',
        stderr: '',
      };
    },
    env: {},
    log: { error: () => {} },
  });
  assert.equal(result.found, true);
  assert.equal(result.commentId, 2);
  assert.equal(calls[0].args[0], 'api');
});

test('findExistingRemediationComment returns lookupFailed=lookup-timeout when gh times out', async () => {
  const result = await findExistingRemediationComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    marker: 'adversarial-review-remediation-marker:job-x:r2:completed',
    execFileImpl: async () => {
      const err = new Error('SIGTERM');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
    env: {},
    log: { error: () => {} },
  });
  assert.equal(result.found, false);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.reason, 'lookup-timeout');
});
