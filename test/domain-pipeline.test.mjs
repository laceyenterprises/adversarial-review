import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DomainPipelineError,
  domainRoundBudgetByRisk,
  isPipelineEnabled,
  resolveDomainPipeline,
} from '../src/domain-pipeline.mjs';
import { loadDomainConfig } from '../src/domain-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function registry(roles) {
  return { roles, routing: { neverReviewOwnBuilderClass: true } };
}

const REVIEWER_ROLES = registry({
  'code-quality-reviewer': {
    id: 'code-quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only',
  },
  'security-reviewer': {
    id: 'security-reviewer', promptSet: 'code-pr-security', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only',
  },
});

const ENABLED_CONFIG = {
  id: 'code-pr',
  riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 2 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
  pipeline: {
    enabled: true,
    stages: [
      { id: 'code-quality', panel: ['code-quality-reviewer'], aggregation: { kind: 'unanimous-clean' } },
      { id: 'security', panel: ['security-reviewer'], aggregation: { kind: 'unanimous-clean' } },
    ],
  },
};

// ── Gate ─────────────────────────────────────────────────────────────────────

test('committed code-pr domain ships the pipeline gate OFF (v1 single-stage)', () => {
  const config = loadDomainConfig(ROOT, 'code-pr');
  assert.equal(config.pipeline.enabled, false);
  assert.equal(isPipelineEnabled(config), false);
});

test('gate-off resolves to disabled without ever consulting the role registry', () => {
  const config = loadDomainConfig(ROOT, 'code-pr');
  // Pass a registry that would THROW if any role were looked up, proving the
  // resolver short-circuits before touching it when the gate is off.
  const throwingRegistry = { get roles() { throw new Error('registry consulted on the gate-off path'); } };
  const resolved = resolveDomainPipeline(config, { roleRegistry: throwingRegistry });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.pipeline, null);
  assert.deepEqual(resolved.stages, []);
});

test('a domain with no pipeline block is treated as gate-off', () => {
  assert.equal(isPipelineEnabled({ id: 'x' }), false);
  assert.equal(resolveDomainPipeline({ id: 'x' }).enabled, false);
});

// ── Compilation ──────────────────────────────────────────────────────────────

test('enabled pipeline compiles stages, panels, and worker-class model hints', () => {
  const resolved = resolveDomainPipeline(ENABLED_CONFIG, { roleRegistry: REVIEWER_ROLES });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.pipeline.map((s) => s.id), ['code-quality', 'security']);
  assert.deepEqual(resolved.pipeline[0].panel, [{ id: 'code-quality-reviewer', model: 'codex' }]);
  assert.deepEqual(resolved.pipeline[1].panel, [{ id: 'security-reviewer', model: 'codex' }]);
  assert.equal(resolved.pipeline[0].aggregation.kind, 'unanimous-clean');
});

test('per-stage round budget derives from the domain risk classes by default', () => {
  const resolved = resolveDomainPipeline(ENABLED_CONFIG, { roleRegistry: REVIEWER_ROLES });
  assert.deepEqual(resolved.pipeline[0].roundBudgetByRisk, { low: 1, medium: 2, high: 3, critical: 4 });
  assert.deepEqual(resolved.pipeline[1].roundBudgetByRisk, { low: 1, medium: 2, high: 3, critical: 4 });
});

test('a stage may override its round budget per risk class', () => {
  const config = {
    ...ENABLED_CONFIG,
    pipeline: {
      enabled: true,
      stages: [
        { id: 'code-quality', panel: ['code-quality-reviewer'], roundBudgetByRisk: { low: 1, medium: 1, high: 2, critical: 2 } },
        { id: 'security', panel: ['security-reviewer'] },
      ],
    },
  };
  const resolved = resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES });
  assert.deepEqual(resolved.pipeline[0].roundBudgetByRisk, { low: 1, medium: 1, high: 2, critical: 2 });
  // The un-overridden stage still derives from the domain risk classes.
  assert.deepEqual(resolved.pipeline[1].roundBudgetByRisk, { low: 1, medium: 2, high: 3, critical: 4 });
});

test('domainRoundBudgetByRisk falls back to kernel defaults for missing classes', () => {
  assert.deepEqual(domainRoundBudgetByRisk({ riskClasses: { medium: { maxRemediationRounds: 5 } } }),
    { low: 1, medium: 5, high: 3, critical: 4 });
});

// ── Fail-loud validation ─────────────────────────────────────────────────────

test('an enabled pipeline with no role registry fails loud', () => {
  assert.throws(() => resolveDomainPipeline(ENABLED_CONFIG), DomainPipelineError);
});

test('a panel role absent from the registry fails loud', () => {
  const config = { ...ENABLED_CONFIG, pipeline: { enabled: true, stages: [{ id: 's', panel: ['ghost-reviewer'] }] } };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES }),
    /panel role "ghost-reviewer" is not defined/);
});

test('a panel seat pointing at a remediation role fails loud', () => {
  const withRemediator = registry({
    ...REVIEWER_ROLES.roles,
    remediator: { id: 'remediator', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'remediation', completionShape: 'branch-push' },
  });
  const config = { ...ENABLED_CONFIG, pipeline: { enabled: true, stages: [{ id: 's', panel: ['remediator'] }] } };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: withRemediator }),
    /must be a review role/);
});

test('an enabled pipeline with no stages fails loud', () => {
  const config = { ...ENABLED_CONFIG, pipeline: { enabled: true, stages: [] } };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES }), /declared no stages/);
});

test('a repeated stage id fails loud', () => {
  const config = {
    ...ENABLED_CONFIG,
    pipeline: { enabled: true, stages: [
      { id: 'dup', panel: ['code-quality-reviewer'] },
      { id: 'dup', panel: ['security-reviewer'] },
    ] },
  };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES }), /repeats pipeline stage id "dup"/);
});

test('an empty panel fails loud', () => {
  const config = { ...ENABLED_CONFIG, pipeline: { enabled: true, stages: [{ id: 's', panel: [] }] } };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES }), /non-empty panel/);
});

test('an unknown aggregation kind fails loud', () => {
  const config = {
    ...ENABLED_CONFIG,
    pipeline: { enabled: true, stages: [{ id: 's', panel: ['code-quality-reviewer'], aggregation: { kind: 'coin-flip' } }] },
  };
  assert.throws(() => resolveDomainPipeline(config, { roleRegistry: REVIEWER_ROLES }), /aggregation\.kind must be one of/);
});
