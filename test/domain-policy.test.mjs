import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { HAMMER_WORKER_CLASSES } from '../src/ama/hammer-worker-class.mjs';
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
  assert.deepEqual(cfg.workerClassFallback, ['hammer-claude']);
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

test('every domain merge-authority fallback is a merge-capable hammer class', () => {
  const domainIds = readdirSync(new URL('../domains/', import.meta.url))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  let checked = 0;
  for (const domainId of domainIds) {
    const fallback = loadDomainConfig(ROOT, domainId).mergeAuthority?.workerClassFallback;
    if (fallback === undefined) continue;
    checked += 1;
    for (const workerClass of fallback) {
      assert.ok(
        HAMMER_WORKER_CLASSES.includes(workerClass),
        `${domainId} mergeAuthority.workerClassFallback lists ${workerClass}, which cannot accept task kind merge`,
      );
    }
  }
  assert.ok(checked > 0, 'expected at least one domain to declare a merge-authority fallback');
});

test('domain merge-authority policy preserves explicit operator overrides', () => {
  const domainConfig = loadDomainConfig(ROOT, 'code-pr');
  const cfg = resolveMergeAuthorityConfigFromDomain(domainConfig, {
    enabled: true,
    workerClass: 'hammer',
    workerClassFallback: ['claude-code'],
    mergeMethod: 'squash',
    strictNonBlockingRemediation: true,
    autonomousMergeExecutionEnabled: true,
    strictMode: false,
    lha: { consumeAttestations: false },
    autoHammerOnEligibilityMiss: true,
    hammerLifetimeDispatchCeiling: 6,
    dispatchTimeoutMs: 123,
    eligibility: {
      riskClasses: ['low', 'medium', 'high', 'critical'],
      fastMergeLabels: ['fast-merge:custom'],
      highRiskRequiresTwoKey: false,
    },
    branchProtection: { required: false },
  }, {
    fallbackSources: {
      'roles.adversarial.merge_authority.lha.consume_attestations':
        'local:/Users/airlock/agent-os/config.local.yaml',
      'roles.adversarial.merge_authority.auto_hammer_on_eligibility_miss':
        'local:/Users/airlock/agent-os/config.local.yaml',
      'roles.adversarial.merge_authority.eligibility.risk_classes':
        'local:/Users/airlock/agent-os/config.local.yaml',
      'roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key':
        'env:AGENT_OS_CFG_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ELIGIBILITY_HIGH_RISK_REQUIRES_TWO_KEY',
      'roles.adversarial.merge_authority.branch_protection.required':
        'local:/Users/airlock/agent-os/config.local.yaml',
      'roles.adversarial.merge_authority.worker_class_fallback':
        'local:/Users/airlock/agent-os/config.local.yaml',
    },
  });

  assert.deepEqual(
    cfg.workerClassFallback,
    ['claude-code'],
    'an operator worker_class_fallback override beats the domain fallback',
  );
  assert.equal(cfg.lha.consumeAttestations, false);
  assert.equal(cfg.autoHammerOnEligibilityMiss, true);
  assert.deepEqual(cfg.eligibility.riskClasses, ['low', 'medium', 'high', 'critical']);
  assert.equal(cfg.eligibility.highRiskRequiresTwoKey, false);
  assert.equal(cfg.branchProtection.required, false);
  assert.equal(cfg.strictMode, true, 'domain value still wins without an operator override source');
  assert.deepEqual(
    cfg.eligibility.fastMergeLabels,
    ['fast-merge:test-fixtures', 'fast-merge:docs'],
    'domain arrays still win without an operator override source',
  );
});

test('domain merge policy preserves the operator no-CI repository list', () => {
  const fallback = { noCiRepositories: ['acme/no-ci'] };
  const cfg = resolveMergeAuthorityConfigFromDomain(loadDomainConfig(ROOT, 'code-pr'), fallback);
  assert.deepEqual(cfg.noCiRepositories, ['acme/no-ci']);
  assert.equal(cfg.branchProtection.required, true, 'no-CI opt-in never changes branch policy');
});
