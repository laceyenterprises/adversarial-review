import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
import { composeAmaTrailers } from '../src/ama/audit.mjs';

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
test('merge immediately records structural primary-change refusal and releases the lease', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-merge-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prNumber = '424243';
  const verdictPath = join(dir, 'verdict.json');
  writeFileSync(verdictPath, JSON.stringify({ eligible: true, trace: { headMatch: { current: 'a'.repeat(40) }, branchProtection: { required: false } } }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho GH_CALLED >&2\nexit 1\n');
  chmodSync(gh, 0o755);
  const nodeStub = join(bin, 'audit-node');
  writeFileSync(nodeStub, '#!/bin/sh\nif [ \"$1\" = --input-type=module ]; then cat >/dev/null; echo \'{\"ok\":false,\"headMatches\":true,\"state\":\"OPEN\",\"checksConclusion\":\"SUCCESS\",\"reasons\":[\"primary-change-unknown\"]}\'; fi\nexit 0\n');
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
  const shell = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=lease POST_REMEDIATION_SHA=${'a'.repeat(40)} HAM_PUBLISHED_AUDIT_HEAD=${'a'.repeat(40)} HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdictPath} HAM_VERDICT_READY_FILE=${verdictPath} HAM_REMOTE_CI_WAIT_SECONDS=1 HAM_MERGE_RETRY_CAP=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; echo LEASE_RELEASED; }
source "$1"
echo "STATUS=$? HELD=$HAM_MERGE_LEASE_HELD OUTCOME=$HAM_PHASE_OUTCOME REMOTE=$HAM_REMOTE_CI_STATUS"
`;
  const result = run('/bin/bash', ['-c', shell, '_', script], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LEASE_RELEASED/);
  assert.match(result.stdout, /STATUS=20 HELD=0 OUTCOME=/);
  assert.match(result.stdout, /REMOTE=primary-change-unknown/);
  assert.doesNotMatch(result.stderr, /GH_CALLED|github-gate-timeout/);
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
    pr: { body: 'a'.repeat(799) + '😀end', state: 'open', merged_at: null, draft: false, mergeable: false, mergeable_state: 'dirty', base: { ref: 'main' }, head: { sha: 'abc' }, changed_files: 1, additions: 3, deletions: 2 },
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
  assert.equal(snapshot.statedIntent, 'a'.repeat(799));
  assert.doesNotMatch(result.stdout, /�/);
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

test('context bounds real primary patches and survives a failed compare', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-context-patches-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const head = 'c'.repeat(40), primary = 'b'.repeat(40), base = 'a'.repeat(40);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const a = process.argv.join(' ');
if (a.includes('/compare/')) {
  if (process.env.FAIL_COMPARE) { process.stderr.write('HTTP 502'); process.exit(1); }
  if (a.endsWith('${base}...${head}')) console.log(JSON.stringify({total_commits:1,commits:[{sha:'${head}',parents:[{sha:'${primary}'}],commit:{message:'Worker-Class: hammer'}}], merge_base_commit:{sha:'${base}'},files:[]}));
  else console.log(JSON.stringify({merge_base_commit:{sha:'${base}'},files:Array.from({length:20},(_,i)=>({filename:'file'+i,patch:'@@ -1 +1 @@\\n+'+'x'.repeat(10000)}))}));
} else if (a.includes('/reviews?')) console.log('[]');
else if (a.includes('/protection')) console.log('{}');
else if (a.includes('pr view')) console.log('{"statusCheckRollup":[]}');
else console.log(JSON.stringify({state:'open',head:{sha:'${head}'},base:{sha:'${base}',ref:'main'},body:'intent'}));
`); chmodSync(gh, 0o755);
  for (const failed of [false, true]) {
    const result = run('node', [join(root, 'bin/hammer-context.mjs'), 'acme/repo', '42'], {PATH: `${bin}:${process.env.PATH}`, ...(failed ? {FAIL_COMPARE:'1'} : {})});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) < 8192);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.head, head);
    assert.equal(snapshot.primaryChange.status, failed ? 'read-failed' : 'available');
    assert.doesNotMatch(result.stdout, /x{100}/);
  }
});

for (const scenario of ['accepted confirmation timeout', 'accepted confirmation permanent read error',
  'superseded head', 'gate read failed', 'gate timeout', 'red CI after pending', 'permanent merge rejection']) {
  test(`rendered hammer receipt classification: ${scenario}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-receipt-decision-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const head = 'a'.repeat(40);
    const verdict = join(dir, 'verdict.json');
    writeFileSync(verdict, JSON.stringify({ eligible: true, trace: {
      headMatch: { current: head }, branchProtection: { required: false },
    } }));
    mkdirSync(join(dir, '.hq'));
    writeFileSync(join(dir, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
    const gate = { ok: true, state: 'OPEN', headMatches: true, expectedHead: head,
      liveHead: head, checksConclusion: 'SUCCESS', reasons: [] };
    if (scenario === 'superseded head') gate.headMatches = false;
    if (scenario === 'gate timeout') { gate.ok = false; gate.checksConclusion = 'PENDING'; }
    writeFileSync(join(dir, 'gate.json'), JSON.stringify(gate));
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({ ...gate, ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }));
    writeFileSync(join(dir, 'red.json'), JSON.stringify({ ...gate, ok: false, checksConclusion: 'FAILURE', reasons: ['ci-not-green'] }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh
case "$*" in
  "pr view "*"--json body"*) exit 0 ;;
  "pr view "*"--json title"*) echo 'Fix #7732 regression'; exit 0 ;;
  'pr merge '*)
    echo attempted > "$TMPDIR/merge-attempted"
    while [ "$#" -gt 1 ]; do
      case "$1" in
        --subject) printf '%s' "$2" > "$TMPDIR/merge-subject" ;;
        --body) printf '%s' "$2" > "$TMPDIR/merge-body" ;;
      esac
      shift
    done
    if [ "$RECEIPT_SCENARIO" = 'permanent merge rejection' ]; then echo 'permission denied' >&2; exit 1; fi
    exit 0 ;;
  'pr view '*)
    if [ "$RECEIPT_SCENARIO" = 'accepted confirmation timeout' ]; then echo 'TLS handshake timeout' >&2;
    else echo 'permission denied' >&2; fi
    exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const nodeStub = join(bin, 'audit-node');
    writeFileSync(nodeStub, `#!/bin/sh
case "$1" in
  --input-type=module)
    cat >/dev/null
    if [ "$RECEIPT_SCENARIO" = 'gate read failed' ]; then exit 1; fi
    if [ "$RECEIPT_SCENARIO" = 'red CI after pending' ]; then
      if [ -f "$TMPDIR/polled" ]; then cat "$TMPDIR/red.json";
      else touch "$TMPDIR/polled"; cat "$TMPDIR/pending.json"; fi
    else cat "$TMPDIR/gate.json"; fi ;;
  */bin/merge-action-receipt.mjs|*/bin/merge-commit-body.mjs) exec "$REAL_NODE" "$@" ;;
  */bin/ama-audit.mjs)
    echo "AUDIT $*"
    while [ "$#" -gt 1 ]; do
      if [ "$1" = --attempt-json ]; then cat "$2"; break; fi
      shift
    done ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const trailers = composeAmaTrailers({ workerClass: 'hammer', reviewerFamily: 'claude', riskClass: 'medium',
      eligibilityReason: 'ham-terminal-remediation', auditRef: `ama-audit:acme/repo:pr-424244:head-${head}` });
    const env = {
      HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424244', HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: '424244', HAM_REVIEWED_SHA: head, HAM_TARGET_REMEDIATION_SHA: head,
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: userInfo().username,
      HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
      HAM_AMA_TRAILERS: trailers,
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, RECEIPT_SCENARIO: scenario, REAL_NODE: process.execPath,
    };
    const render = run(process.execPath, [join(root, 'bin/hammer-procedure.mjs'), 'hammer-merge', '--render'], env);
    assert.equal(render.status, 0, render.stderr);
    const script = join(dir, 'merge.sh');
    writeFileSync(script, render.stdout);
    const shell = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=lease POST_REMEDIATION_SHA=${head} HAM_PUBLISHED_AUDIT_HEAD=${head} HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdict} HAM_VERDICT_READY_FILE=${verdict} HAM_REMOTE_CI_WAIT_SECONDS=${scenario === 'red CI after pending' ? 60 : 0} HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT=1 HAM_MERGE_RETRY_CAP=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
ham_mark_merge_lease_retryable_abort() { echo REFUNDED; }
sleep() { :; }
source "$1"
echo "STATUS=$? HELD=$HAM_MERGE_LEASE_HELD OWN=$HAM_OWN_MERGE_EXECUTED EXIT=$HAM_MERGE_EXIT"
`;
    const result = run('/bin/bash', ['-c', shell, '_', script], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HELD=0/);
    if (scenario.startsWith('accepted') || scenario === 'permanent merge rejection') {
      assert.equal(readFileSync(join(dir, 'merge-subject'), 'utf8'), 'Fix PR #7732 regression (#424244)');
      assert.equal(readFileSync(join(dir, 'merge-body'), 'utf8'), trailers);
    }
    if (scenario === 'red CI after pending') {
      assert.match(result.stdout, /github-gate-red/);
      assert.doesNotMatch(result.stdout, /REFUNDED/);
    }
    if (scenario.startsWith('accepted')) {
      assert.equal(readFileSync(join(dir, 'merge-attempted'), 'utf8').trim(), 'attempted');
      assert.match(result.stdout, /OWN=1 EXIT=0/);
      assert.match(result.stdout, /--outcome deferred/);
      assert.match(result.stdout, /merge-confirmation-read-failed-after-merge-accepted/);
    } else if (scenario !== 'permanent merge rejection') {
      assert.equal(readdirSync(dir).includes('merge-attempted'), false);
    }
    const directory = join(dir, 'dispatch/audit/automation-merge-actions');
    const receipts = (() => { try { return readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } })();
    assert.equal(receipts.length, ['permanent merge rejection', 'red CI after pending'].includes(scenario) ? 1 : 0, result.stderr);
    if (receipts.length) {
      const receipt = JSON.parse(readFileSync(join(directory, receipts[0])));
      assert.equal(receipt.merged, false);
      assert.equal(receipt.reason, scenario === 'red CI after pending' ? 'github-gate-red' : 'permanent-merge-rejection');
    }
  });
}

for (const scenario of ['recover', 'exhaust', 'permanent']) {
  test(`post-CI lease reacquire GitHub probe: ${scenario}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-reacquire-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/bin/sh
n=0; [ ! -f "$TMPDIR/calls" ] || n=$(cat "$TMPDIR/calls")
n=$((n + 1)); echo "$n" > "$TMPDIR/calls"
if [ "$SCENARIO" = permanent ]; then echo 'HTTP 403 forbidden' >&2; exit 1; fi
if [ "$SCENARIO" = exhaust ] || [ "$n" = 1 ]; then
  echo 'GitHub read failed' >&2; echo 'TLS handshake timeout' >&2; exit 1
fi
echo '{"headRefOid":"${'a'.repeat(40)}","statusCheckRollup":[]}'
`);
    chmodSync(gh, 0o755);
    // Render the production procedures, then execute the reacquire block with
    // only the lease CLI and audit sink replaced. The gh probe is real shell.
    const env = { HAM_PR_URL: 'https://github.com/acme/repo/pull/424242', HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: '424242', HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
      HAM_ROOT_DIR: root, HAM_AUDIT_PATH: join(dir, 'audit'), HAM_REVIEWER: 'claude',
      PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, SCENARIO: scenario };
    const verify = run(process.execPath, [join(root, 'bin/hammer-procedure.mjs'), 'hammer-verify-head', '--render'], env);
    const merge = run(process.execPath, [join(root, 'bin/hammer-procedure.mjs'), 'hammer-merge', '--render'], env);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(merge.status, 0, merge.stderr);
    const helper = verify.stdout.slice(verify.stdout.indexOf('ham_lease_pr_view() {'), verify.stdout.indexOf('ham_acquire_merge_lease() {'));
    const block = merge.stdout.slice(merge.stdout.indexOf('if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] &&'), merge.stdout.indexOf('HAM_PRE_MERGE_ELIGIBLE=1\n\nHAM_MERGE_ATTEMPTS'));
    const result = run('/bin/bash', ['-c', `${helper}
sleep() { :; }
ham_acquire_merge_lease() { ham_lease_pr_view --json headRefOid,statusCheckRollup >/dev/null; }
ham_base_touches_pr_files() { return 1; }
ham_append_terminal_audit() { echo "AUDIT:$*"; }
HAM_ALREADY_MERGED_VALIDATED_HEAD=0
HAM_MERGE_LEASE_HELD=0
close() { ${block}
 echo REACQUIRED; }
close
`], env);
    assert.equal(result.status, scenario === 'recover' ? 0 : scenario === 'exhaust' ? 20 : 1, result.stderr);
    assert.equal(readFileSync(join(dir, 'calls'), 'utf8').trim(), scenario === 'recover' ? '2' : scenario === 'exhaust' ? '3' : '1');
    if (scenario === 'exhaust') assert.match(result.stdout, /AUDIT:deferred merge-lease-timeout/);
    else assert.doesNotMatch(result.stdout, /AUDIT:/);
  });
}
