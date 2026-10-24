import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { withHammerTokenSync } from '../src/hammer-token.mjs';
import { buildLegacyHqRemediationDispatchArgs } from '../src/remediation-dispatch-mode.mjs';
import { buildMergeAgentPrompt, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER } from '../src/merge-agent-prompt.mjs';
import { hasDeployIncidentMarker } from '../src/deploy-incident.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const head = 'a'.repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'no-op-outcomes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|CREDENTIAL|^HAM_|^HQ_/.test(key)));
  Object.assign(env, { HAM_ROOT_DIR: root, HAM_HQ_ROOT: dir, HAM_REPO: 'owner/repo',
    HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: head, HAM_NODE_BIN: process.execPath,
    HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic', HQ_ROOT: dir });
  const audit = () => {
    const auditDir = join(dir, 'dispatch/audit/adversarial-merge-authority');
    return JSON.parse(readFileSync(join(auditDir, readdirSync(auditDir).find(name => name.endsWith('.json'))), 'utf8'));
  };
  return { dir, env, audit };
}

test('LVR-02: failed refresh before any GitHub call writes a redacted launch-bound audit', t => {
  const { env, audit } = fixture(t);
  env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND = "printf 'SECRET_SYNTHETIC_VALUE invalid output'";
  let calls = 0;
  assert.throws(() => withHammerTokenSync(() => { calls++; }, { env, hammerToken: true }), /refresh/);
  assert.equal(calls, 0);
  const doc = audit();
  assert.equal(doc.status, 'failed-without-merge');
  assert.equal(doc.attempts[0].reason, 'credential-refresh-failed');
  assert.equal(doc.attempts[0].launchRequestId, env.HQ_LAUNCH_REQUEST_ID);
  assert.doesNotMatch(JSON.stringify(doc), /SECRET_SYNTHETIC_VALUE/);
});

test('LVR-02: failed optional refresh with a held credential writes no terminal failure', t => {
  const { env, dir } = fixture(t);
  env.MERGE_AGENT_GH_TOKEN = 'synthetic-held-value';
  env.MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND = 'exit 1';
  assert.equal(withHammerTokenSync(() => 'ok', { env, hammerToken: true }), 'ok');
  assert.deepEqual(readdirSync(dir), []);
});

for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
  test(`LVR-02: ${phase} early refusal writes its terminal audit before returning`, t => {
    const { env, dir, audit } = fixture(t);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Empty successful response is missing PR state; all transport is synthetic.
    env.GH_CALL_LOG = join(dir, 'gh-calls');
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf call >> "$GH_CALL_LOG"\nprintf "{}\\n"\n', { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const source = readFileSync(join(root, `bin/${phase}.sh`), 'utf8');
    const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)]
      .map(([, key]) => [key, 'synthetic']));
    Object.assign(values, { ROOT_DIR: root, HQ_ROOT: dir, RUN_DIR: dir, REPO: 'owner/repo',
      PR_NUMBER: '42', REVIEWED_SHA: head, TARGET_REMEDIATION_SHA: head });
    const path = join(dir, `${phase}.sh`);
    writeFileSync(path, renderHammerProcedure(phase, values));
    const result = spawnSync('bash', ['-c', 'source "$1"; code=$?; echo "settled:$code"; exit "$code"', 'fixture', path],
      { env, encoding: 'utf8', timeout: 30_000 });
    assert.ok(result.status > 0, result.stderr);
    assert.match(result.stdout, /settled:/);
    if (phase === 'hammer-merge') assert.equal(existsSync(env.GH_CALL_LOG), false);
    const doc = audit();
    assert.equal(doc.status, 'failed-without-merge');
    assert.equal(doc.attempts[0].reason, {
      'hammer-verify-head': 'missing-pr-state', 'hammer-publish': 'hammer-publish-error',
      'hammer-merge': 'merge-lease-not-held',
    }[phase]);
    assert.equal(doc.attempts[0].launchRequestId, 'lrq_synthetic');
  });
}

for (const helper of ['hammer-context.mjs', 'hammer-base-head.mjs']) {
  test(`LVR-02: missing PR state in ${helper} writes an audit before exit`, t => {
    const { env, dir, audit } = fixture(t);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const args = helper === 'hammer-context.mjs' ? ['owner/repo', '42'] : ['https://github.com/owner/repo/pull/42'];
    const result = spawnSync(process.execPath, [join(root, 'bin', helper), ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(audit().status, 'failed-without-merge');
    assert.equal(audit().attempts[0].launchRequestId, 'lrq_synthetic');
  });
}

test('LVR-02: manual refusal is terminal and repeated reporting preserves the first reason', t => {
  const { env, audit } = fixture(t);
  reportHammerEarlyFailure('early-refusal', { env });
  reportHammerEarlyFailure('later-wrapper-failure', { env });
  assert.equal(audit().attempts.length, 1);
  assert.equal(audit().attempts[0].reason, 'early-refusal');
});

test('LVR-02: only a versioned incident comment with an id supplies the scheduling hint', () => {
  for (const body of ['', 'deploy-incident:v1', '<!-- deploy-incident:v2 id=incident-1 -->', '<!-- deploy-incident:v1 -->']) {
    assert.equal(hasDeployIncidentMarker(body), false);
  }
  assert.equal(hasDeployIncidentMarker('text\n<!-- deploy-incident:v1 id=incident-1 -->'), true);
});


test('LVR-02 remediation launches require push evidence', () => {
  const args = buildLegacyHqRemediationDispatchArgs({ repo: 'owner/repo', prNumber: 42 });
  assert.equal(args[args.indexOf('--required-outcome') + 1], 'push');
});

test('LVR-02 closer prompt carries terminal evidence and the incident snapshot through lease admission', () => {
  const prompt = buildMergeAgentPrompt({ repo: 'owner/repo', prNumber: 42, headSha: head,
    baseBranch: 'main', lastVerdict: 'comment-only', blockingFindingCount: 0,
    blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known',
    labels: [], mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS' },
  { trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER });
  assert.match(prompt, /terminal AMA audit tied to HQ_LAUNCH_REQUEST_ID/);
  assert.match(prompt, /--json headRefName,body > "\$MERGE_PR_STATE_JSON"/);
  assert.match(prompt, /--pr-state-file "\$MERGE_PR_STATE_JSON"/);
});

test('LVR-02 normal terminal audit CLI binds its own launch, overriding stale attempt identity', t => {
  const { dir, env, audit } = fixture(t);
  const attempt = join(dir, 'attempt.json');
  writeFileSync(attempt, JSON.stringify({ launchRequestId: 'lrq_previous', reason: 'synthetic-refusal' }));
  const result = spawnSync(process.execPath, [join(root, 'bin/ama-audit.mjs'), 'append',
    '--hq-root', dir, '--repo', 'owner/repo', '--pr', '42', '--head', head,
    '--outcome', 'failed-without-merge', '--attempt-json', attempt], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(audit().attempts[0].launchRequestId, 'lrq_synthetic');
});
