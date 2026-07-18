import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubPRCommentsAdapter } from '../../src/adapters/comms/github-pr-comments/index.mjs';
import {
  DeliveryIdentityError,
  normalizeDeliveryIdentityEntry,
  resolveDeliveryIdentity,
  validateDeliveryIdentityMap,
} from '../../src/adapters/comms/github-pr-comments/delivery-identity.mjs';

// The v2 per-role delivery config (ARC-12): role id → the bot identity that
// posts its comments. Only ENV VAR NAMES live here — never token values.
const IDENTITY_BY_ROLE = {
  'code-quality-reviewer': { botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' },
  'security-reviewer': { workerClass: 'claude-code' }, // bridges the v1 worker-class map
  'codex-reviewer': { botLogin: 'codex-reviewer-lacey' },
};

function makeKey(overrides = {}) {
  return {
    domainId: 'code-pr',
    subjectExternalId: 'laceyenterprises/demo#7',
    revisionRef: 'sha-current',
    round: 1,
    kind: 'review-verdict',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure delivery-identity resolution
// ---------------------------------------------------------------------------

test('normalizeDeliveryIdentityEntry derives both sides from any declared side', () => {
  assert.deepEqual(
    normalizeDeliveryIdentityEntry('r', { botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN' }),
    { roleId: 'r', botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN', botLogin: 'gemini-reviewer-lacey' },
  );
  assert.deepEqual(
    normalizeDeliveryIdentityEntry('r', { botLogin: 'codex-reviewer-lacey' }),
    { roleId: 'r', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', botLogin: 'codex-reviewer-lacey' },
  );
  assert.deepEqual(
    normalizeDeliveryIdentityEntry('r', { workerClass: 'claude-code' }),
    { roleId: 'r', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN', botLogin: 'claude-reviewer-lacey' },
  );
  // A bare string is treated as a token env.
  assert.equal(normalizeDeliveryIdentityEntry('r', 'GH_CODEX_REVIEWER_TOKEN').botTokenEnv, 'GH_CODEX_REVIEWER_TOKEN');
});

test('normalizeDeliveryIdentityEntry throws when no token env can be resolved', () => {
  assert.throws(() => normalizeDeliveryIdentityEntry('r', { botLogin: 'unknown-login' }), DeliveryIdentityError);
  assert.throws(() => normalizeDeliveryIdentityEntry('r', {}), DeliveryIdentityError);
});

test('resolveDeliveryIdentity selects identity by role id and rejects unknown roles', () => {
  assert.equal(
    resolveDeliveryIdentity('code-quality-reviewer', IDENTITY_BY_ROLE).botTokenEnv,
    'GH_GEMINI_REVIEWER_TOKEN',
  );
  assert.equal(
    resolveDeliveryIdentity('security-reviewer', IDENTITY_BY_ROLE).botTokenEnv,
    'GH_CLAUDE_REVIEWER_TOKEN',
  );
  assert.throws(
    () => resolveDeliveryIdentity('no-such-role', IDENTITY_BY_ROLE),
    (err) => err instanceof DeliveryIdentityError && /no comms delivery identity/.test(err.message),
  );
});

test('validateDeliveryIdentityMap requires an identity for each named role', () => {
  const normalized = validateDeliveryIdentityMap(IDENTITY_BY_ROLE, {
    requireRoleIds: ['code-quality-reviewer', 'security-reviewer', 'codex-reviewer'],
  });
  assert.equal(normalized['security-reviewer'].botLogin, 'claude-reviewer-lacey');
  assert.throws(
    () => validateDeliveryIdentityMap(IDENTITY_BY_ROLE, { requireRoleIds: ['unbound-reviewer'] }),
    (err) => err instanceof DeliveryIdentityError && /no comms delivery identity binding/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Adapter: per-role identity selection at post time
// ---------------------------------------------------------------------------

function makeAdapter(calls, overrides = {}) {
  return createGitHubPRCommentsAdapter({
    deliveryIdentityByRole: IDENTITY_BY_ROLE,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GH_GEMINI_REVIEWER_TOKEN: 'gemini-bot-token',
      GH_CLAUDE_REVIEWER_TOKEN: 'claude-bot-token',
      GH_CODEX_REVIEWER_TOKEN: 'codex-bot-token',
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-1\n' };
    },
    ...overrides,
  });
}

test('deliverReviewComment posts under the bot identity bound to the verdict role', async () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  await adapter.deliverReviewComment(
    { body: 'security finding', reviewerRoleId: 'security-reviewer' },
    makeKey({ revisionRef: 'sha-a' }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GH_TOKEN, 'claude-bot-token');
});

test('a different role selects a different bot identity for the same subject', async () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  await adapter.deliverReviewComment(
    { body: 'quality note', reviewerRoleId: 'code-quality-reviewer' },
    makeKey({ revisionRef: 'sha-b' }),
  );
  assert.equal(calls[0].options.env.GH_TOKEN, 'gemini-bot-token');
  // The comms env is allowlisted: only PATH/HOME/GH_TOKEN survive.
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ['GH_TOKEN', 'HOME', 'PATH']);
});

test('role identity takes precedence over the adapter-level worker class', async () => {
  const calls = [];
  // Even with a codex worker-class default, the role id wins.
  const adapter = makeAdapter(calls, { workerClass: 'codex' });
  await adapter.deliverReviewComment(
    { body: 'quality note', reviewerRoleId: 'code-quality-reviewer' },
    makeKey({ revisionRef: 'sha-c' }),
  );
  assert.equal(calls[0].options.env.GH_TOKEN, 'gemini-bot-token');
});

test('an unbound verdict role fails delivery rather than posting under a default identity', async () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  await assert.rejects(
    () => adapter.deliverReviewComment(
      { body: 'x', reviewerRoleId: 'ghost-reviewer' },
      makeKey({ revisionRef: 'sha-d' }),
    ),
    (err) => err instanceof DeliveryIdentityError,
  );
  assert.equal(calls.length, 0);
});

test('an unbound verdict role fails before entering delivery claim waiting', async () => {
  const calls = [];
  const adapter = makeAdapter(calls, { rootDir: '/dev/null/not-a-delivery-root' });

  await assert.rejects(
    () => adapter.deliverReviewComment(
      { body: 'x', reviewerRoleId: 'ghost-reviewer' },
      makeKey({ revisionRef: 'sha-fail-fast' }),
    ),
    (err) => err instanceof DeliveryIdentityError,
  );
  assert.equal(calls.length, 0);
});

test('remediation replies validate the role identity before failing closed', async () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  await assert.rejects(
    () => adapter.deliverRemediationReply(
      {
        kind: 'adversarial-review-remediation-reply',
        schemaVersion: 1,
        jobId: 'job-1',
        outcome: 'completed',
        summary: 'ready',
        validation: [],
        blockers: [],
        reReview: { requested: true, reason: 'ready' },
      },
      makeKey({ kind: 'remediation-reply', roleId: 'ghost-reviewer' }),
    ),
    (err) => err instanceof DeliveryIdentityError,
  );
  assert.equal(calls.length, 0);
});

test('without a role id or identity map the legacy worker-class routing is unchanged', async () => {
  const calls = [];
  const adapter = createGitHubPRCommentsAdapter({
    workerClass: 'codex',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/airlock',
      GH_CODEX_REVIEWER_TOKEN: 'codex-bot-token',
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: 'https://github.com/laceyenterprises/demo/pull/7#issuecomment-9\n' };
    },
  });
  await adapter.deliverReviewComment({ body: 'no role' }, makeKey({ revisionRef: 'sha-legacy' }));
  assert.equal(calls[0].options.env.GH_TOKEN, 'codex-bot-token');
});
