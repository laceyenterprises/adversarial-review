import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDomainConfig } from '../src/domain-config.mjs';
import {
  resolveLegacyReviewerRouteByRoleId,
  resolveMergeAuthorityConfigFromDomain,
  resolveRemediatorWorkerClassFromDomain,
  resolveReviewerRouteTableFromDomain,
  resolveRoleRegistryFromDomain,
} from '../src/domain-policy.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('code-pr reviewer routing is sourced from the domain config', () => {
  const domainConfig = loadDomainConfig(ROOT, 'code-pr');
  const routes = resolveReviewerRouteTableFromDomain(domainConfig);
  assert.deepEqual(routes.codex, {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  });
  assert.deepEqual(routes['claude-code'], {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });
  assert.equal(resolveLegacyReviewerRouteByRoleId('codex-reviewer-lacey').reviewerModel, 'codex');
});

test('domain reviewer routing preserves un-overridden fallback routes', () => {
  const routes = resolveReviewerRouteTableFromDomain({
    id: 'partial-domain',
    reviewerRouting: {
      codex: 'gemini-reviewer-lacey',
    },
  }, {
    fallbackRouteByBuilderClass: {
      codex: {
        reviewerModel: 'claude',
        botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      },
      hammer: {
        reviewerModel: 'codex',
        botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      },
    },
  });
  assert.deepEqual(routes.codex, {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  });
  assert.deepEqual(routes.hammer, {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });
});

test('code-pr remediator default is declared in the domain role registry', () => {
  const domainConfig = loadDomainConfig(ROOT, 'code-pr');
  assert.equal(resolveRemediatorWorkerClassFromDomain(domainConfig), 'codex');
  const registry = resolveRoleRegistryFromDomain(domainConfig, {
    workerClasses: ['codex', 'gemini', 'claude-code'],
  });
  assert.equal(registry.roles.remediator.workerClass, 'codex');
  assert.equal(registry.roles['security-reviewer'].promptSet, 'code-pr-security');
});

test('domain role registry overrides merge over fallback roles', () => {
  const registry = resolveRoleRegistryFromDomain({
    id: 'partial-domain',
    roleRegistry: {
      remediator: {
        promptSet: 'partial-domain',
      },
    },
  }, {
    fallbackRoleRegistry: {
      roles: {
        remediator: {
          promptSet: 'code-pr',
          workerClass: 'codex',
          taskKind: 'remediation',
          completionShape: 'branch-push',
        },
        'merge-reviewer': {
          promptSet: 'code-pr',
          workerClass: 'gemini',
          taskKind: 'review',
          completionShape: 'decision-only',
        },
      },
      routing: { neverReviewOwnBuilderClass: true },
    },
    workerClasses: ['codex', 'gemini', 'claude-code'],
  });

  assert.equal(registry.roles.remediator.promptSet, 'partial-domain');
  assert.equal(registry.roles.remediator.workerClass, 'codex');
  assert.equal(registry.roles['merge-reviewer'].workerClass, 'gemini');
});

test('domain merge-authority policy overrides fallback defaults', () => {
  const domainConfig = loadDomainConfig(ROOT, 'code-pr');
  const cfg = resolveMergeAuthorityConfigFromDomain(domainConfig, {
    enabled: true,
    workerClass: 'hammer',
    workerClassFallback: ['claude-code'],
    mergeMethod: 'squash',
    strictNonBlockingRemediation: false,
    autonomousMergeExecutionEnabled: false,
    strictMode: false,
    lha: { consumeAttestations: false },
    autoHammerOnEligibilityMiss: false,
    hammerLifetimeDispatchCeiling: 9,
    dispatchTimeoutMs: 123,
    eligibility: {
      riskClasses: ['medium'],
      fastMergeLabels: ['fast-merge:custom'],
      highRiskRequiresTwoKey: false,
    },
    branchProtection: { required: false },
  });
  assert.equal(cfg.autonomousMergeExecutionEnabled, true);
  assert.equal(cfg.lha.consumeAttestations, true);
  assert.equal(cfg.strictMode, true);
  assert.deepEqual(cfg.workerClassFallback, ['claude-code']);
  assert.deepEqual(cfg.eligibility.riskClasses, ['low']);
  assert.deepEqual(cfg.eligibility.fastMergeLabels, ['fast-merge:test-fixtures', 'fast-merge:docs']);
  assert.equal(cfg.branchProtection.required, true);

  const sparse = resolveMergeAuthorityConfigFromDomain(domainConfig, {
    eligibility: {},
    branchProtection: {},
    lha: {},
  });
  assert.deepEqual(sparse.eligibility.riskClasses, ['low']);
  assert.deepEqual(sparse.eligibility.fastMergeLabels, ['fast-merge:test-fixtures', 'fast-merge:docs']);
  assert.equal(sparse.branchProtection.required, true);
});
