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
  const prNumber = String(1_000_000 + process.pid);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const name of readdirSync('/tmp')) {
      if (name.startsWith(`ham-${prNumber}-`)) rmSync(join('/tmp', name), { force: true });
    }
  });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncase "$*" in\n  "pr view"*) echo \'{"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergeStateStatus":"CLEAN"}\' ;;\n  "api --paginate"*) echo \'{"id":42,"body":"<!-- hq:ham-terminal-remediation:audit --> HAM-Terminal-Remediation-Head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\' ;;\n  "api --method PATCH"*) echo patched > "$TMPDIR/patched" ;;\n  *) echo \'{"strict":false}\' ;;\nesac\n');
  chmodSync(gh, 0o755);
  const leaseNode = join(bin, 'lease-node');
  writeFileSync(leaseNode, '#!/bin/sh\ncase "$1" in\n  */bin/merge-lease.mjs) echo \'{"parked":true,"reason":"max-gate-attempts","closingStatus":"Reset the capped head"}\'; exit 70 ;;\n  */bin/ama-audit.mjs) exit 0 ;;\nesac\nexit 1\n');
  chmodSync(leaseNode, 0o755);
  const wrapper = template.match(/For each phase,[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  assert.ok(wrapper);
  for (const [phase, outcome, diagnostic, status] of [
    ['hammer-verify-head', 'parked:max-gate-attempts', 'AMG-04 parked', 20],
    ['hammer-publish', 'hammer-publish-error', 'terminal-remediation audit must be written', 1],
    ['hammer-merge', 'merge-error', 'no hammer merge without holding', 1],
  ]) {
    const shell = `PHASE=${phase}\n${wrapper}\necho SHELL_SURVIVED\nexit "$HAM_PHASE_STATUS"\n`;
    const result = run('/bin/bash', ['-c', shell], {
      HAM_ROOT_DIR: root, HAM_PR_URL: `https://github.com/acme/repo/pull/${prNumber}`, HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: prNumber, HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
      HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer', HAM_NODE_BIN: leaseNode,
      HAMMER_LACEY_GH_TOKEN: 'fixture',
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
    });
    assert.equal(result.status, status, `${phase}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, new RegExp(diagnostic));
    assert.match(result.stdout, new RegExp(`outcome=${outcome}`));
    assert.match(result.stdout, /SHELL_SURVIVED/);
    if (phase === 'hammer-verify-head') assert.equal(readFileSync(join(dir, 'patched'), 'utf8').trim(), 'patched');
    assert.deepEqual(readdirSync(dir).filter((file) => file.startsWith('ham-phase')), []);
  }
});
test('publish accepts supplied audit content and releases the lease on a failed post', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const bodyPath = join(dir, 'posted-body');
  const detailsPath = join(dir, 'details.md');
  writeFileSync(detailsPath, '## 🔨 Hammer remediation audit\n\n**Findings addressed**\n- **Fix gate** (blocking) — bin/gate.sh: checked verdict\n');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh
case "$*" in
  *"pr view"*) echo ${'a'.repeat(40)} ;;
  *"api --paginate"*) echo '[]' ;;
  *"pr comment"*) if [ "\${FAIL_POST:-0}" = 1 ]; then exit 1; fi; printf '%s' "$5" > "\${POSTED_BODY_PATH}" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(gh, 0o755);
  const env = {
    HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424242', HAM_REPO: 'acme/repo',
    HAM_PR_NUMBER: '424242', HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
    HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
    HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
    HAM_AUDIT_DETAILS_FILE: detailsPath, HAM_AUDIT_REMEDIATED_TOTAL: '1',
    HAM_AUDIT_REMEDIATED_BLOCKING: '1', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
    HAM_FAILING_TESTS_FIXED: 'suite already green', HAMMER_LACEY_GH_TOKEN: 'fixture',
    POSTED_BODY_PATH: bodyPath, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
  };
  const render = run('node', [join(root, 'bin/hammer-procedure.mjs'), 'hammer-publish', '--render'], env);
  assert.equal(render.status, 0, render.stderr);
  const script = join(dir, 'publish.sh');
  writeFileSync(script, render.stdout);
  const shell = `HAM_MERGE_LEASE_HELD=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; echo LEASE_RELEASED; }
ham_is_full_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
source "$1"
status=$?
echo "STATUS=$status HELD=$HAM_MERGE_LEASE_HELD PUBLISHED=\${HAM_PUBLISHED_AUDIT_HEAD:-}"
`;
  const success = run('/bin/bash', ['-c', shell, '_', script], env);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /STATUS=0 HELD=1 PUBLISHED=aaaaaaaa/);
  const body = readFileSync(bodyPath, 'utf8');
  assert.match(body, /Remediated-Findings: 1 addressed \(1 blocking, 0 non-blocking\)/);
  assert.match(body, /\*\*Fix gate\*\*/);
  assert.doesNotMatch(body, /<finding title>/);
  const failure = run('/bin/bash', ['-c', shell, '_', script], { ...env, FAIL_POST: '1' });
  assert.match(failure.stdout, /LEASE_RELEASED/);
  assert.match(failure.stdout, /STATUS=1 HELD=0 PUBLISHED=$/m);
});
test('merge refuses an ineligible predicate before reading the green gate', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-merge-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prNumber = '424243';
  const verdictPath = join(dir, 'verdict.json');
  writeFileSync(verdictPath, JSON.stringify({ eligible: false, trace: { headMatch: { current: 'a'.repeat(40) } } }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho GH_CALLED >&2\nexit 1\n');
  chmodSync(gh, 0o755);
  const nodeStub = join(bin, 'audit-node');
  writeFileSync(nodeStub, '#!/bin/sh\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const env = {
    HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424243', HAM_REPO: 'acme/repo',
    HAM_PR_NUMBER: prNumber, HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
    HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
    HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
    PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
  };
  const render = run('node', [join(root, 'bin/hammer-procedure.mjs'), 'hammer-merge', '--render'], env);
  assert.equal(render.status, 0, render.stderr);
  const script = join(dir, 'merge.sh');
  writeFileSync(script, render.stdout);
  const shell = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=lease POST_REMEDIATION_SHA=${'a'.repeat(40)} HAM_PUBLISHED_AUDIT_HEAD=${'a'.repeat(40)} HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdictPath} HAM_VERDICT_READY_FILE=${verdictPath}
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; echo LEASE_RELEASED; }
source "$1"
echo "STATUS=$? HELD=$HAM_MERGE_LEASE_HELD OUTCOME=$HAM_PHASE_OUTCOME"
`;
  const result = run('/bin/bash', ['-c', shell, '_', script], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LEASE_RELEASED/);
  assert.match(result.stdout, /STATUS=20 HELD=0 OUTCOME=predicate-not-eligible/);
  assert.doesNotMatch(result.stderr, /GH_CALLED/);
  const stale = run('/bin/bash', ['-c', shell.replace(`HAM_VERDICT_READY_FILE=${verdictPath}`, 'HAM_VERDICT_READY_FILE=') , '_', script], env);
  assert.match(stale.stdout, /STATUS=20 HELD=0/);
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
  assert.equal(run(path, ['--timeout', '2', '--', '/bin/sh', '-c', 'exit 142']).status, 142);
  const childPidFile = join(tmpdir(), `bounded-child-${process.pid}.pid`);
  try {
    const children = run(path, ['--timeout', '1', '--', '/bin/sh', '-c', `sleep 30 & echo $! > ${childPidFile}; wait`]);
    assert.equal(children.status, 124);
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { rmSync(childPidFile, { force: true }); }
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
      assert.equal(denied.status, 64, `${phase} must refuse subprocess execution`);
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
    reviews: [{ commit_id: 'abc', state: 'COMMENTED', body: `## Adversarial Review\n${'Fix auth. '.repeat(250)}`, user: { login: 'reviewer' } }],
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
  assert.match(snapshot.review.findings, /Fix auth/);
  assert.equal(snapshot.review.state, 'COMMENTED');
  assert.equal(snapshot.review.findingsTruncated, true);
  assert.ok(snapshot.review.findingsBytes > 1800);
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
