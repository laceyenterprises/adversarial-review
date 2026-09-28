import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
function run(command, args, env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAM_')));
  return spawnSync(command, args, { encoding: 'utf8', timeout: 5000, env: { ...cleanEnv, ...env } });
}
test('sourced phase wrapper reports terminal outcomes and keeps its shell alive', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-phase-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncase "$*" in\n  "pr view"*) echo \'{"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergeStateStatus":"CLEAN"}\' ;;\n  *) echo \'{"strict":false}\' ;;\nesac\n');
  chmodSync(gh, 0o755);
  const leaseNode = join(bin, 'lease-node');
  writeFileSync(leaseNode, '#!/bin/sh\necho \'{"parked":true,"reason":"another-closer"}\'\nexit 70\n');
  chmodSync(leaseNode, 0o755);
  const wrapper = template.match(/For each phase,[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  assert.ok(wrapper);
  for (const [phase, outcome, diagnostic, status] of [
    ['hammer-verify-head', 'parked:another-closer', 'AMG-04 parked', 20],
    ['hammer-publish', 'hammer-publish-error', 'terminal-remediation audit must be written', 1],
    ['hammer-merge', 'merge-error', 'no hammer merge without holding', 1],
  ]) {
    const shell = `PHASE=${phase}\n${wrapper}\necho SHELL_SURVIVED\nexit "$HAM_PHASE_STATUS"\n`;
    const result = run('/bin/bash', ['-c', shell], {
      HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/42', HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: '42', HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
      HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer', HAM_NODE_BIN: leaseNode,
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
    });
    assert.equal(result.status, status, `${phase}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, new RegExp(diagnostic));
    assert.match(result.stdout, new RegExp(`outcome=${outcome}`));
    assert.match(result.stdout, /SHELL_SURVIVED/);
    assert.deepEqual(readdirSync(dir).filter((file) => file.startsWith('ham-phase')), []);
  }
});
test('rendered hammer prompt stays under a 60 KiB byte budget', () => {
  const rendered = composeCloserPrompt({
    prUrl: 'https://github.com/acme/repo/pull/42', repo: 'acme/repo', prNumber: 42,
    reviewedSha: 'a'.repeat(40), riskClass: 'medium', mergeMethod: 'squash',
    requiredGateContext: 'adversarial-review', auditPath: '/tmp/hammer-audit.json',
    hqRoot: '/tmp/hq', rootDir: root, hqOwnerUser: 'tester', reviewedBy: 'reviewer',
    reviewer: 'reviewer', dispatchedAt: '2026-09-27T00:00:00Z', amaTrailers: '',
    templateBody: template,
  });
  assert.ok(Buffer.byteLength(rendered) <= 60 * 1024, `prompt is ${Buffer.byteLength(rendered)} bytes`);
  assert.doesNotMatch(rendered, /<<[A-Z_]+>>/);
});
test('hammer and every remediation stage forbid full suites and polling', () => {
  const prompts = [template, ...['first', 'middle', 'last'].map((stage) => readFileSync(join(root, 'prompts/code-pr', `remediator.${stage}.md`), 'utf8'))];
  for (const prompt of prompts) {
    assert.match(prompt, /Never run (a |the )?full test suite locally/i);
    assert.match(prompt, /targeted tests/i);
    assert.match(prompt, /run-bounded\.sh/);
    assert.match(prompt, /Never background a command and poll/i);
    assert.match(prompt, /Codex/i);
  }
});
test('bounded runner preserves exit status and caps combined output', () => {
  const path = join(root, 'bin/run-bounded.sh');
  const failure = run(path, ['--timeout', '2', '--tail-bytes', '40', '--', '/bin/sh', '-c', 'printf "%01000d" 0; exit 7']);
  assert.equal(failure.status, 7);
  assert.ok(Buffer.byteLength(failure.stdout) <= 41);
  const timed = run(path, ['--timeout', '1', '--', '/bin/sh', '-c', 'sleep 3']);
  assert.equal(timed.status, 124);
  assert.equal(run(path, ['--timeout', '0', '--', '/bin/true']).status, 64);
});
test('versioned merge helpers are parseable and reject missing dispatch values', () => {
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    const source = readFileSync(join(root, 'bin', `${phase}.sh`), 'utf8').replace(/<<[A-Z_]+>>/g, 'fixture');
    const parsed = spawnSync('/bin/bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = run('node', [join(root, 'bin/hammer-procedure.mjs'), phase]);
    assert.equal(result.status, 64);
    assert.ok(result.stderr.length < 1024);
    if (phase !== 'hammer-verify-head') {
      const env = Object.fromEntries(['PR_URL', 'REPO', 'PR_NUMBER', 'REVIEWED_SHA', 'TARGET_REMEDIATION_SHA', 'RISK_CLASS', 'MERGE_METHOD', 'ROOT_DIR', 'HQ_ROOT', 'HQ_OWNER', 'AUDIT_PATH', 'REVIEWER'].map((key) => [`HAM_${key}`, 'fixture']));
      const denied = run('node', [join(root, 'bin/hammer-procedure.mjs'), phase], env);
      assert.notEqual(denied.status, 0, `${phase} must refuse an absent lease`);
      assert.ok(Buffer.byteLength(denied.stdout) <= 4200, `${phase} emitted an unbounded tail`);
    }
  }
});
test('one-shot context snapshot is bounded and describes fixture PR head', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fixture = {
    pr: { state: 'open', merged_at: null, draft: false, mergeable: false, mergeable_state: 'dirty', base: { ref: 'main' }, head: { sha: 'abc' }, changed_files: 1, additions: 3, deletions: 2 },
    reviews: [{ commit_id: 'abc', state: 'CHANGES_REQUESTED', body: 'Fix auth', user: { login: 'reviewer' } }],
    files: [{ additions: 3, deletions: 2 }],
    checks: { statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }] },
    protection: { required_status_checks: { contexts: ['CI'] } },
  };
  const fixturePath = join(dir, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node\nconst f=require(${JSON.stringify(fixturePath)}); const a=process.argv.join(' '); console.log(JSON.stringify(a.includes('/reviews?')?f.reviews:a.includes('/files?')?f.files:a.includes('/protection')?f.protection:a.includes('pr view')?f.checks:f.pr));\n`);
  chmodSync(gh, 0o755);
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ activeRemediation: { jobId: 'job-1' }, activeLease: { leaseId: 'lease-1' } }));
  const result = run('node', [join(root, 'bin/hammer-context.mjs'), 'acme/repo', '42', '--state-file', state], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) < 8192);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.head, 'abc');
  assert.equal(snapshot.review.findings, 'Fix auth');
  assert.deepEqual(snapshot.requiredChecks, ['CI']);
  assert.deepEqual(snapshot.diffStat, { files: 1, additions: 3, deletions: 2 });
  assert.equal(snapshot.conflictsVersusBase, true);
  assert.equal(snapshot.activeRemediation.jobId, 'job-1');
  assert.equal(snapshot.activeLease.leaseId, 'lease-1');
  const jobDir = join(dir, 'data', 'follow-up-jobs', 'in-progress');
  const leaseDir = join(dir, 'data', 'merge-leases');
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ repo: 'acme/repo', prNumber: 42, jobId: 'job-local', status: 'in-progress' }));
  writeFileSync(join(leaseDir, 'acme__repo__main.json'), JSON.stringify({ leaseId: 'lease-local', holderPr: 42, holderHead: 'abc' }));
  const local = run('node', [join(root, 'bin/hammer-context.mjs'), 'acme/repo', '42'], { PATH: `${bin}:${process.env.PATH}`, HAM_ROOT_DIR: dir });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).activeRemediation.jobId, 'job-local');
  assert.equal(JSON.parse(local.stdout).activeLease.leaseId, 'lease-local');
});
