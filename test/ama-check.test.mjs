import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AMA_CHECK = join(REPO_ROOT, 'bin', 'ama-check.mjs');
const HEAD_SHA = 'abc12345abc12345abc12345abc12345abc12345';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixtureFiles(tmp, { protectionBody = '{}' } = {}) {
  const paths = {
    pr: join(tmp, 'pr.json'),
    reviews: join(tmp, 'reviews.json'),
    protection: join(tmp, 'protection.json'),
    timeline: join(tmp, 'timeline.json'),
  };
  writeJson(paths.pr, {
    number: 1234,
    headRefOid: HEAD_SHA,
    state: 'OPEN',
    isDraft: false,
    mergeStateStatus: 'MERGEABLE',
    labels: ['operator-approved'],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
    ],
    author: { login: 'codex-worker-bot' },
    baseRefName: 'main',
  });
  writeJson(paths.reviews, {
    reviews: [
      {
        state: 'APPROVED',
        submittedAt: '2026-06-13T12:00:00Z',
        commit: { oid: HEAD_SHA },
      },
    ],
  });
  writeFileSync(paths.protection, protectionBody);
  writeJson(paths.timeline, [
    {
      event: 'labeled',
      label: { name: 'operator-approved' },
      commit_id: HEAD_SHA,
      actor: { login: 'paul-the-operator' },
      node_id: 'LE_operator_approved',
      created_at: '2026-06-13T12:01:00Z',
    },
  ]);
  return paths;
}

function writeConfig(tmp, { branchProtectionRequired }) {
  const configPath = join(tmp, 'config.yaml');
  writeFileSync(configPath, `\
version: 1
roles:
  adversarial:
    merge_authority:
      enabled: true
      eligibility:
        risk_classes: ["low"]
      branch_protection:
        required: ${branchProtectionRequired ? 'true' : 'false'}
        required_gate_context_source: resolveGateStatusContext
`);
  return configPath;
}

function runAmaCheck(tmp, { branchProtectionRequired, protectionBody }) {
  const paths = writeFixtureFiles(tmp, { protectionBody });
  const configPath = writeConfig(tmp, { branchProtectionRequired });
  return spawnSync(
    process.execPath,
    [
      AMA_CHECK,
      '--pr', paths.pr,
      '--reviews', paths.reviews,
      '--protection', paths.protection,
      '--timeline', paths.timeline,
      '--reviewed-sha', HEAD_SHA,
      '--risk-class', 'low',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_OS_CONFIG_PATH: configPath,
      },
    },
  );
}

test('ama-check treats unreadable protection JSON as empty only when branch protection is waived', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-waived-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: false,
      protectionBody: '',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.trace.branchProtection.required, false);
    assert.equal(verdict.trace.branchProtection.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ama-check fails closed on empty protection snapshot when branch protection is required', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ama-check-required-protection-'));
  try {
    const result = runAmaCheck(tmp, {
      branchProtectionRequired: true,
      protectionBody: '{}\n',
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.eligible, false);
    assert.ok(verdict.reasons.includes('branch-protection-missing-gate'));
    assert.equal(verdict.trace.branchProtection.required, true);
    assert.equal(verdict.trace.branchProtection.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
