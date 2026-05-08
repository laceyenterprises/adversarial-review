import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERSARIAL_GATE_CONTEXT,
} from '../src/adversarial-gate-status.mjs';
import {
  createBranchProtectionChecker,
  fetchAdversarialGateBranchProtection,
  formatBranchProtectionWarning,
  normalizeRequiredContexts,
  resolveBaseBranchForRepo,
  warnForMissingAdversarialGateBranchProtection,
} from '../src/branch-protection.mjs';

test('normalizeRequiredContexts includes classic contexts and check contexts', () => {
  assert.deepEqual(
    normalizeRequiredContexts({
      required_status_checks: {
        contexts: ['ci'],
        checks: [{ context: ADVERSARIAL_GATE_CONTEXT }],
      },
    }),
    [ADVERSARIAL_GATE_CONTEXT, 'ci']
  );
});

test('fetchAdversarialGateBranchProtection succeeds when required context is present', async () => {
  const calls = [];
  const result = await fetchAdversarialGateBranchProtection({
    repoPath: 'laceyenterprises/adversarial-review',
    baseBranch: 'main',
    env: {
      GITHUB_TOKEN: 'token-123',
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/test-home',
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          required_status_checks: {
            contexts: [ADVERSARIAL_GATE_CONTEXT],
          },
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'required-context-present');
  assert.equal(calls[0].command, 'gh');
  assert.ok(calls[0].args.includes('repos/laceyenterprises/adversarial-review/branches/main/protection'));
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ['GH_TOKEN', 'HOME', 'PATH']);
});

test('warnForMissingAdversarialGateBranchProtection logs structured warnings for missing context', async () => {
  const warnings = [];
  const result = await warnForMissingAdversarialGateBranchProtection(
    ['laceyenterprises/adversarial-review'],
    {
      checker: async () => ({
        repo: 'laceyenterprises/adversarial-review',
        baseBranch: 'main',
        context: ADVERSARIAL_GATE_CONTEXT,
        ok: false,
        reason: 'required-context-missing',
        requiredContexts: ['ci'],
      }),
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    }
  );

  assert.equal(result.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /branch-protection-warning/);
  assert.match(warnings[0], /context=agent-os\/adversarial-gate/);
  assert.match(warnings[0], /reason=required-context-missing/);
});

test('createBranchProtectionChecker caches protection probes by repo and base branch', async () => {
  let calls = 0;
  let now = 1_000;
  const checker = createBranchProtectionChecker({
    ttlMs: 10_000,
    nowMs: () => now,
    fetchImpl: async ({ repoPath, baseBranch }) => {
      calls += 1;
      return {
        repo: repoPath,
        baseBranch,
        context: ADVERSARIAL_GATE_CONTEXT,
        ok: true,
        reason: 'required-context-present',
        requiredContexts: [ADVERSARIAL_GATE_CONTEXT],
      };
    },
  });

  assert.equal((await checker({ repoPath: 'laceyenterprises/adversarial-review' })).cached, false);
  assert.equal((await checker({ repoPath: 'laceyenterprises/adversarial-review' })).cached, true);
  now += 11_000;
  assert.equal((await checker({ repoPath: 'laceyenterprises/adversarial-review' })).cached, false);
  assert.equal(calls, 2);
});

test('resolveBaseBranchForRepo honors full slug, repo name, and default fallback', () => {
  assert.equal(
    resolveBaseBranchForRepo('laceyenterprises/adversarial-review', {
      baseBranches: { 'laceyenterprises/adversarial-review': 'release' },
      defaultBaseBranch: 'main',
    }),
    'release'
  );
  assert.equal(
    resolveBaseBranchForRepo('laceyenterprises/adversarial-review', {
      baseBranches: { 'adversarial-review': 'trunk' },
      defaultBaseBranch: 'main',
    }),
    'trunk'
  );
  assert.equal(resolveBaseBranchForRepo('laceyenterprises/adversarial-review'), 'main');
});

test('formatBranchProtectionWarning includes empty-context diagnostics', () => {
  const warning = formatBranchProtectionWarning({
    repo: 'laceyenterprises/adversarial-review',
    baseBranch: 'main',
    context: ADVERSARIAL_GATE_CONTEXT,
    ok: false,
    reason: 'branch-protection-missing',
    requiredContexts: [],
  });
  assert.match(warning, /required_contexts=none/);
});
