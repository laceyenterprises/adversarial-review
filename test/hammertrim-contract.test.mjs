import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVerifiedCloserCommit } from '../src/head-closer-commit-suppression.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
import { composeAmaTrailers } from '../src/ama/audit.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const subprocessTimeout = loadAwareTimeoutSeconds(45) * 1000;
function run(command, args, env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAM_')));
  return spawnSync(command, args, { encoding: 'utf8', timeout: subprocessTimeout, env: { ...cleanEnv, ...env } });
}
// Shell behavior fixtures may substitute isolated state roots; location refusal is
// exercised through the real CLI in hammer-scratch.test.mjs.
function renderPhase(phase, env) {
  try {
    const values = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.replace(/^HAM_/, ''), value]));
    return { status: 0, stdout: renderHammerProcedure(phase, values), stderr: '' };
  } catch (error) {
    return { status: error.exitCode || 1, stdout: '', stderr: error.message };
  }
}
test('sourced phase wrapper reports terminal outcomes and keeps its shell alive', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-phase-'));
  const prNumber = String(1_000_000 + process.pid);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncase "$*" in\n  "pr view"*) echo \'{"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergeStateStatus":"CLEAN","state":"OPEN","isDraft":false,"labels":[]}\' ;;\n  "api --paginate"*) echo \'{"id":42,"body":"<!-- hq:ham-terminal-remediation:audit --> HAM-Terminal-Remediation-Head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\' ;;\n  "api --method PATCH"*) echo patched > "$TMPDIR/patched" ;;\n  *) echo \'{"strict":false}\' ;;\nesac\n');
  chmodSync(gh, 0o755);
  const leaseNode = join(bin, 'lease-node');
  writeFileSync(leaseNode, '#!/bin/sh\ncase "$1" in\n  */bin/metered-gh.mjs) shift 2; exec gh "$@" ;;\n  */bin/hammer-pr-read.mjs) repo="$2"; shift 2; number="$1"; shift; exec gh pr view "$number" -R "$repo" "$@" ;;\n  --input-type=module) exec ' + JSON.stringify(process.execPath) + ' "$@" ;;\n  */bin/merge-lease.mjs) echo LEASE_PROGRESS >&2; echo \'{"parked":true,"reason":"max-gate-attempts","closingStatus":"Reset the capped head"}\'; exit 70 ;;\n  */bin/ama-audit.mjs) exit 0 ;;\nesac\nexit 1\n');
  chmodSync(leaseNode, 0o755);
  const wrapper = template.match(/For each phase,[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
  assert.ok(wrapper);
  for (const [phase, outcome, diagnostic, status] of [
    ['hammer-verify-head', 'parked:max-gate-attempts', 'AMG-04 parked', 20],
    ['hammer-publish', 'hammer-publish-error', 'terminal-remediation audit must be written', 1],
    ['hammer-merge', 'merge-error', 'no hammer merge without holding', 1],
  ]) {
    const env = {
      HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_PR_URL: `https://github.com/acme/repo/pull/${prNumber}`, HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: prNumber, HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
      HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer', HAM_NODE_BIN: leaseNode,
      HAMMER_LACEY_GH_TOKEN: 'fixture',
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
    };
    const rendered = renderPhase(phase, env);
    assert.equal(rendered.status, 0, rendered.stderr);
    writeFileSync(join(dir, `${phase}.sh`), rendered.stdout, { mode: 0o600 });
    const shell = `PHASE=${phase}\n${wrapper.replaceAll('<<RUN_DIR>>', dir)}\necho SHELL_SURVIVED\nexit "$HAM_PHASE_STATUS"\n`;
    const result = run('/bin/bash', ['-c', shell], env);
    assert.equal(result.status, status, `${phase}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, new RegExp(diagnostic));
    assert.match(result.stdout, new RegExp(`outcome=${outcome}`));
    assert.match(result.stdout, /SHELL_SURVIVED/);
    if (phase === 'hammer-verify-head') {
      assert.equal(readFileSync(join(dir, 'patched'), 'utf8').trim(), 'patched');
      assert.match(result.stderr, /LEASE_PROGRESS/);
      assert.doesNotMatch(result.stdout, /LEASE_PROGRESS/);
    }
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
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho '+ 'a'.repeat(40) +'\n', { mode: 0o755 });
  const proof = join(bin, 'proof');
  writeFileSync(proof, '#!/bin/sh\ncase "$1" in\n  */bin/metered-gh.mjs) shift 2; exec gh "$@" ;;\n  */bin/hammer-pr-read.mjs) repo="$2"; shift 2; number="$1"; shift; exec gh pr view "$number" -R "$repo" "$@" ;; *hammer-audit-comment-id.mjs) exit 0;; *github-outbound-body.mjs) exec "$REAL_NODE" "$@";; esac\nif [ \"${FAIL_PROOF:-0}\" = 1 ]; then exit 65; fi\necho \"{}\"\n', { mode: 0o755 });
  const env = {
    HAM_NODE_BIN: proof, REAL_NODE: process.execPath, HAM_BASE_HEAD: 'a'.repeat(40),
    HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424242', HAM_REPO: 'acme/repo',
    HAM_PR_NUMBER: '424242', HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
    HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
    HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
    HAM_AUDIT_DETAILS_FILE: detailsPath, HAM_AUDIT_REMEDIATED_TOTAL: '1',
    HAM_AUDIT_REMEDIATED_BLOCKING: '1', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
    HAM_DOC_CURRENCY: 'not applicable', HAM_DOC_CURRENCY_REASON: 'changed files covered: bin/gate.sh',
    HAM_FAILING_TESTS_FIXED: 'suite already green', HAMMER_LACEY_GH_TOKEN: 'fixture',
    POSTED_BODY_PATH: bodyPath, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
  };
  const render = renderPhase('hammer-publish', env);
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
  function assertDocPredicate(body, changedFiles, expectedStatus = 'not_applicable', expectedTitle = 'Fix gate') {
    const head = 'a'.repeat(40), reviewed = 'b'.repeat(40);
    // Bind the rendered body to a synthetic reviewed parent for the predicate.
    body = body.replaceAll(`HAM-Base-Head: ${head}`, `HAM-Base-Head: ${reviewed}`);
    const commit = { ...normalizeVerifiedCloserCommit({ sha: head, parents: [{ sha: reviewed }],
      author: { login: 'hammer-worker' }, committer: { login: 'hammer-worker' },
      commit: { message: `Repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${reviewed}\nClosed-By: hammer (adversarial-pipe-mode)\nRemediated-Findings: 1 addressed (1 blocking, 0 non-blocking)` },
      files: changedFiles.map(filename => ({ filename })) }),
      primaryChange: { headSha: head, hasHammerCommits: false, ciCost: { headSha: head, ok: true } } };
    const auditComment = { body, author: 'hammer-worker' };
    const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({ reviewedHead: reviewed,
      verifiedCommit: commit, verifiedAuditComment: auditComment });
    assert.equal(evidence.auditComment.docCurrency?.status ?? null, expectedStatus);
    assert.deepEqual(evidence.auditComment.findings.map(finding => finding.title), [expectedTitle]);
    const verdict = isEligibleForAmaClosure({ headSha: reviewed, verdict: 'request-changes', riskClass: 'low',
      blockingFindingState: 'known', blockingFindingCount: 1, remediationPending: false,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
    { headSha: head, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] },
    { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
    { hamTerminalRemediation: evidence, hamTerminalRemediationGroundTruth: { commit, auditComment,
      range: { verified: true, reviewedHead: reviewed, currentHead: head, baseSha: reviewed, commits: [head] } } });
    assert.equal(verdict.trace.hamTerminalRemediation.checks.docCurrency, expectedStatus !== null, JSON.stringify(verdict));
    // Missing doc evidence is advisory under the existing HAM contract.
    assert.equal(verdict.eligible, true, JSON.stringify(verdict));
  }
  const body = readFileSync(bodyPath, 'utf8');
  assertDocPredicate(body, ['bin/gate.sh']);
  assert.match(body, /Remediated-Findings: 1 addressed \(1 blocking, 0 non-blocking\)/);
  assert.match(body, /\*\*Fix gate\*\*/);
  assert.doesNotMatch(body, /<finding title>/);
  assert.match(body, /^Doc-currency: not applicable; changed files covered: bin\/gate.sh$/m);
  const applicable = run('/bin/bash', ['-c', shell, '_', script], { ...env,
    HAM_DOC_CURRENCY: 'applicable', HAM_DOC_CURRENCY_REASON: 'updated README.md for changed files bin/gate.sh, README.md; data-model docs not applicable' });
  assert.match(applicable.stdout, /STATUS=0 HELD=1/);
  assert.match(readFileSync(bodyPath, 'utf8'), /^Doc-currency: updated; updated README.md/m);
  assertDocPredicate(readFileSync(bodyPath, 'utf8'), ['bin/gate.sh', 'README.md'], 'updated');
  const skipped = run('/bin/bash', ['-c', shell, '_', script], { ...env,
    HAM_DOC_CURRENCY: 'skipped superproject-doc obligation',
    HAM_DOC_CURRENCY_REASON: 'bin/gate.sh affects superproject walkthrough; local docs not applicable' });
  assert.match(skipped.stdout, /STATUS=0 HELD=1/);
  assertDocPredicate(readFileSync(bodyPath, 'utf8'), ['bin/gate.sh'], 'skipped_superproject');
  const title = 'Doc-currency: missing catalog update';
  const finding = `- **${title}** (blocking): bin/gate.sh: updated catalog.json`;
  writeFileSync(detailsPath, `${finding}\n  Doc-currency: stale claim\n  - dOc-CuRrEnCy: stale bullet claim\n`);
  const docFinding = run('/bin/bash', ['-c', shell, '_', script], env);
  assert.match(docFinding.stdout, /STATUS=0 HELD=1/);
  const docFindingBody = readFileSync(bodyPath, 'utf8');
  assert.ok(docFindingBody.includes(finding), 'finding title must survive publication verbatim');
  assert.doesNotMatch(docFindingBody, /stale (bullet )?claim/);
  assertDocPredicate(docFindingBody, ['bin/gate.sh'], 'not_applicable', title);
  assertDocPredicate(docFindingBody.replace(/^Doc-currency:.*\n/m, ''), ['bin/gate.sh'], null, title);
  for (const classification of ['blocking', 'non-blocking']) {
    const unbolded = `- ${title} (${classification}): bin/gate.sh: updated catalog.json`;
    writeFileSync(detailsPath, `${unbolded}\nDoc-currency: stale claim\n`);
    const published = run('/bin/bash', ['-c', shell, '_', script], env);
    assert.match(published.stdout, /STATUS=0 HELD=1/);
    const publishedBody = readFileSync(bodyPath, 'utf8');
    assert.ok(publishedBody.includes(unbolded), 'unbolded finding must survive publication verbatim');
    assert.doesNotMatch(publishedBody, /stale claim/);
    assertDocPredicate(publishedBody, ['bin/gate.sh'], 'not_applicable', title);
    assertDocPredicate(publishedBody.replace(/^Doc-currency:.*\n/m, ''), ['bin/gate.sh'], null, title);
  }
  for (const missing of [{ HAM_DOC_CURRENCY: '' }, { HAM_DOC_CURRENCY_REASON: '' }]) {
    const refused = run('/bin/bash', ['-c', shell, '_', script], { ...env, ...missing });
    assert.match(refused.stderr, /hammer-publish: supply/);
    assert.match(refused.stdout, /STATUS=1 HELD=0 PUBLISHED=$/m);
  }
  rmSync(bodyPath);
  for (const refusal of [{ FAIL_PROOF: '1' }]) {
    const refused = run('/bin/bash', ['-c', shell, '_', script], { ...env, ...refusal });
    assert.match(refused.stdout, /STATUS=20 HELD=0 PUBLISHED=$/m);
    assert.equal(existsSync(bodyPath), false, 'failed proof must not post a validation audit');
  }
  const gitPublished = run('/bin/bash', ['-c', shell, '_', script], { ...env, HAM_API_PUBLISH_FALLBACK: '1' });
  assert.match(gitPublished.stdout, /STATUS=0 HELD=1 PUBLISHED=aaaaaaaa/);
  const failure = run('/bin/bash', ['-c', shell, '_', script], { ...env, FAIL_POST: '1' });
  assert.match(failure.stdout, /LEASE_RELEASED/);
  assert.match(failure.stdout, /STATUS=1 HELD=0 PUBLISHED=$/m);
});
test('API fallback push rejection releases the lease under set -e for both push routes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-fallback-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'publisher'), '#!/bin/sh\nprintf "%s\\n" "$PUBLISH_RESULT"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$PUSH_ARGS_FILE"\nexit 1\n', { mode: 0o755 });
  const source = readFileSync(join(root, 'bin/hammer-publish.sh'), 'utf8')
    .replaceAll('<<RUN_DIR>>', dir).replaceAll('<<ROOT_DIR>>', root).replaceAll('<<REPO>>', 'fixture/repo').replaceAll('<<PR_URL>>', '1')
    .replaceAll('<<REVIEWED_SHA>>', 'a'.repeat(40)).replaceAll('<<PR_NUMBER>>', '1');
  const script = join(dir, 'publish.sh');
  writeFileSync(script, source);
  for (const result of [
    { route: 're-review', branch: 'worker', fallbackHead: 'a'.repeat(40) },
    { route: 're-review', reason: 'API publication timed out' },
  ]) {
    const env = { HAM_COMMIT_PUBLICATION_ONLY: '1', HAM_NODE_BIN: join(dir, 'publisher'),
      PUBLISH_RESULT: JSON.stringify(result), PUSH_ARGS_FILE: join(dir, 'push-args'), PATH: `${dir}:${process.env.PATH}` };
    const failure = run('/bin/bash', ['-c', `set -e
HAM_MERGE_LEASE_HELD=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; echo LEASE_RELEASED; }
trap 'echo HELD=$HAM_MERGE_LEASE_HELD' EXIT
source "$1"
echo SHOULD_NOT_CONTINUE
`, '_', script], env);
    assert.equal(failure.status, 1, failure.stderr);
    assert.match(failure.stdout, /LEASE_RELEASED\nHELD=0/);
    assert.doesNotMatch(failure.stdout, /SHOULD_NOT_CONTINUE/);
    assert.equal(readFileSync(env.PUSH_ARGS_FILE, 'utf8').trim(), result.branch
      ? `push origin HEAD:refs/heads/worker --force-with-lease=refs/heads/worker:${result.fallbackHead}`
      : 'push --force-with-lease');
  }
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
    HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424243', HAM_REPO: 'acme/repo',
    HAM_PR_NUMBER: prNumber, HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
    HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
    HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
    PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
  };
  const render = renderPhase('hammer-merge', env);
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
test('merge defers unknown primary-change evidence and releases the lease', (t) => {
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
  writeFileSync(nodeStub, '#!/bin/sh\nif [ \"$1\" = --input-type=module ]; then cat >/dev/null; echo \'{\"ok\":false,\"headMatches\":true,\"state\":\"OPEN\",\"checksConclusion\":\"SUCCESS\",\"reasons\":[\"primary-change-unknown\"]}\'; fi\nif [ \"$2\" = append ]; then echo \"AUDIT_ARGS=$*\"; fi\nexit 0\n');
  chmodSync(nodeStub, 0o755);
  const env = {
    HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424243', HAM_REPO: 'acme/repo',
    HAM_PR_NUMBER: prNumber, HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
    HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
    HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
    PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
  };
  const render = renderPhase('hammer-merge', env);
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
  assert.match(result.stderr, /primary-change evidence unknown/);
  assert.match(result.stdout, /AUDIT_ARGS=.*--outcome deferred/);
  assert.doesNotMatch(result.stderr, /GH_CALLED|github-gate-timeout/);
});
test('rendered hammer prompt stays under a 60 KiB byte budget', () => {
  const rendered = composeCloserPrompt({
    prUrl: 'https://github.com/acme/repo/pull/42', repo: 'acme/repo', prNumber: 42,
    reviewedSha: 'a'.repeat(40), riskClass: 'medium', mergeMethod: 'squash',
    requiredGateContext: 'adversarial-review', auditPath: '/tmp/hammer-audit.json',
    // Keep this prompt-size fixture independent of the checkout path length.
    hqRoot: '/tmp/hq', rootDir: '/tmp/adversarial-review', hqOwnerUser: 'tester', reviewedBy: 'reviewer',
    reviewer: 'reviewer', dispatchedAt: '2026-09-27T00:00:00Z', amaTrailers: '',
    templateBody: template, scratchDir: '/fixture/scratch',
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
  const callsPath = join(dir, 'calls.jsonl');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node\nconst f=require(${JSON.stringify(fixturePath)}); const a=process.argv.join(' '); require('node:fs').appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify(a.includes('/reviews?')?f.reviews:a.includes('/files?')?f.files:a.includes('/protection')?f.protection:a.includes('/check-runs?')?{check_runs:[]}:a.includes('/statuses?')?[]:a.includes('pr view')?f.checks:f.pr));\n`);
  chmodSync(gh, 0o755);
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ activeRemediation: { jobId: 'job-1' }, activeLease: { leaseId: 'lease-1' } }));
  const result = run('node', [join(root, 'bin/hammer-context.mjs'), 'acme/repo', '42', '--state-file', state], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const beforeProtection = calls.slice(0, calls.findIndex(args => args[1].endsWith('/protection')));
  assert.equal(beforeProtection.filter(args => args[1] === 'repos/acme/repo/pulls/42').length, 1,
    'check snapshot must reuse the initial PR metadata read');
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
  if (require('node:fs').existsSync('${dir}/fail-compare')) { process.stderr.write('HTTP 502'); process.exit(1); }
  if (a.includes('${base}...${head}')) console.log(JSON.stringify({total_commits:1,commits:[{sha:'${head}',parents:[{sha:'${primary}'}],commit:{message:'Worker-Class: hammer'}}], merge_base_commit:{sha:'${base}'},files:[]}));
  else console.log(JSON.stringify({total_commits:0,commits:[],merge_base_commit:{sha:'${base}'}}));
} else if (a.includes('/git/trees/')) console.log(JSON.stringify({tree:a.includes('${base}')?[]:Array.from({length:20},(_,i)=>({path:'file'+i,type:'blob',mode:'100644',sha:String(i).padStart(40,'0')})),truncated:false}));
else if (a.includes('/git/blobs/')) { const text='x'.repeat(10000)+'\\n'; console.log(JSON.stringify({encoding:'base64',content:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text)})); }
else if (a.includes('/reviews?')) console.log('[]');
else if (a.includes('/protection')) console.log('{}');
else if (a.includes('/check-runs?')) console.log('{"check_runs":[]}');
else if (a.includes('/statuses?')) console.log('[]');
else if (a.includes('pr view')) console.log('{"statusCheckRollup":[]}');
else console.log(JSON.stringify({state:'open',head:{sha:'${head}'},base:{sha:'${base}',ref:'main'},body:'intent'}));
`); chmodSync(gh, 0o755);
  for (const failed of [false, true]) {
    if (failed) writeFileSync(join(dir, 'fail-compare'), '');
    const result = run('node', [join(root, 'bin/hammer-context.mjs'), 'acme/repo', '42'], {PATH: `${bin}:${process.env.PATH}`, ...(failed ? {FAIL_COMPARE:'1'} : {})});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) < 8192);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.head, head);
    assert.equal(snapshot.primaryChange.status, failed ? 'history-read-failed' : 'available');
    assert.doesNotMatch(result.stdout, /x{100}/);
  }
});

for (const scenario of ['no-diff validated merge', 'git-attested merge', 'prior-attested-base merge', 'accepted confirmation timeout', 'accepted confirmation permanent read error',
  'superseded head', 'gate read failed', 'gate timeout', 'red CI after pending', 'permanent merge rejection']) {
  test(`rendered hammer receipt classification: ${scenario}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-receipt-decision-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const head = 'a'.repeat(40);
    const reviewedHead = 'd'.repeat(40);
    const successfulMerge = ['no-diff validated merge', 'git-attested merge', 'prior-attested-base merge'].includes(scenario);
    const verdict = join(dir, 'verdict.json');
    writeFileSync(verdict, JSON.stringify({ eligible: true, trace: {
      headMatch: { current: head }, branchProtection: { required: false },
    } }));
    if (successfulMerge) {
      const startingBase = scenario === 'prior-attested-base merge' ? 'c'.repeat(40) : reviewedHead;
      const body = `HAM-Base-Head: ${startingBase}\nHAM-Validated-Head: ${head}`;
      const comments = [{ author: 'hammer-worker', body },
        { author: 'hammer-worker', body: `HAM-Base-Head: ${reviewedHead}\nHAM-Validated-Head: ${'c'.repeat(40)}` }];
      const range = await fetchHammerHeadRange({ reviewedHead, currentHead: head, comments,
        get() { throw new Error('App proof requires no commit signatures'); } });
      const primaryChange = { headSha: head, hasHammerCommits: false };
      const result = isEligibleForAmaClosure({ headSha: reviewedHead, verdict: 'request-changes', riskClass: 'low',
        remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      { headSha: head, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
        statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }], branchProtection: { requiredContexts: ['CI'] } },
      { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
      { primaryChange, hamTerminalRemediation: { active: true, commit: { sha: head }, auditComment: { body, findings: [] } },
        hamTerminalRemediationGroundTruth: { commit: { sha: head, changedFiles: scenario === 'no-diff validated merge' ? [] : ['src/auth.js'],
            author: 'arbitrary-author', committer: 'arbitrary-committer',
            commit: { verification: { verified: false, reason: 'unsigned' } }, primaryChange },
          auditComment: { body, author: 'hammer-worker' },
          range } });
      assert.equal(result.eligible, true, JSON.stringify(result));
      assert.equal(result.trace.hamTerminalRemediation.checks.nonEmptyCommit, scenario !== 'no-diff validated merge');
      writeFileSync(verdict, JSON.stringify(result));
    }
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
        --match-head-commit) printf '%s' "$2" > "$TMPDIR/merge-head" ;;
        --subject) printf '%s' "$2" > "$TMPDIR/merge-subject" ;;
        --body) printf '%s' "$2" > "$TMPDIR/merge-body" ;;
      esac
      shift
    done
    if [ "$RECEIPT_SCENARIO" = 'permanent merge rejection' ]; then echo 'permission denied' >&2; exit 1; fi
    exit 0 ;;
  'pr view '*)
    if [ '${successfulMerge}' = true ] && [ -f '${dir}/merge-attempted' ]; then
      echo '{"state":"MERGED","mergedAt":"${new Date().toISOString()}","mergeCommit":{"oid":"${'b'.repeat(40)}"},"headRefOid":"${head}"}'
      exit 0
    fi
    if [ "$RECEIPT_SCENARIO" = 'accepted confirmation timeout' ]; then echo 'TLS handshake timeout' >&2;
    else echo 'permission denied' >&2; fi
    exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const nodeStub = join(bin, 'audit-node');
    writeFileSync(nodeStub, `#!/bin/sh
case "$1" in
  */bin/metered-gh.mjs) shift 2; exec gh "$@" ;;
  */bin/hammer-pr-read.mjs) repo="$2"; shift 2; number="$1"; shift; exec gh pr view "$number" -R "$repo" "$@" ;;
  --input-type=module)
    cat >/dev/null
    if [ "$RECEIPT_SCENARIO" = 'gate read failed' ]; then exit 1; fi
    if [ "$RECEIPT_SCENARIO" = 'red CI after pending' ]; then
      if [ -f "$TMPDIR/polled" ]; then cat "$TMPDIR/red.json";
      else touch "$TMPDIR/polled"; cat "$TMPDIR/pending.json"; fi
    else cat "$TMPDIR/gate.json"; fi ;;
  */bin/merge-action-receipt.mjs|*/bin/merge-commit-body.mjs|*/bin/github-outbound-body.mjs) exec "$REAL_NODE" "$@" ;;
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
      HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_PR_URL: 'https://github.com/acme/repo/pull/424244', HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: '424244', HAM_REVIEWED_SHA: successfulMerge ? reviewedHead : head, HAM_TARGET_REMEDIATION_SHA: head,
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: userInfo().username,
      HAM_AUDIT_PATH: join(dir, 'audit.json'), HAM_REVIEWER: 'reviewer',
      HAM_AMA_TRAILERS: trailers,
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, RECEIPT_SCENARIO: scenario, REAL_NODE: process.execPath,
    };
    const render = renderPhase('hammer-merge', env);
    assert.equal(render.status, 0, render.stderr);
    const script = join(dir, 'merge.sh');
    writeFileSync(script, successfulMerge
      ? render.stdout.replace('if ! ham_emit_git_merge_signal; then', 'if ! ham_fixture_emit_git_merge_signal; then')
        .replace('if ! ham_mark_ama_closer_lease_succeeded; then', 'if ! ham_fixture_mark_ama_closer_lease_succeeded; then')
      : render.stdout);
    // Advance the CI deadline with a fake clock, never by lowering procedure waits.
    writeFileSync(join(dir, 'clock'), '1700000000');
    writeFileSync(join(bin, 'date'), `#!/bin/sh
if [ "$1" = +%s ]; then
  value=$(cat "$TMPDIR/clock")
  echo "$value"
  echo $((value + ${scenario === 'red CI after pending' ? 30 : 1000})) > "$TMPDIR/clock"
else exec /bin/date "$@"; fi
`, { mode: 0o755 });
    const shell = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=lease POST_REMEDIATION_SHA=${head} HAM_PUBLISHED_AUDIT_HEAD=${head} HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdict} HAM_VERDICT_READY_FILE=${verdict} HAM_REMOTE_CI_WAIT_SECONDS=${scenario === 'red CI after pending' ? 60 : 0} HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT=1 HAM_MERGE_RETRY_CAP=1
ham_fixture_emit_git_merge_signal() { echo FIXTURE_MERGE_SIGNAL; }
ham_fixture_mark_ama_closer_lease_succeeded() { echo FIXTURE_CLOSER_SUCCEEDED; }
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
    if (successfulMerge) {
      assert.match(result.stdout, /STATUS=0 HELD=0 OWN=1 EXIT=0/);
      assert.equal(readFileSync(join(dir, 'merge-head'), 'utf8'), head);
    } else if (scenario.startsWith('accepted')) {
      assert.equal(readFileSync(join(dir, 'merge-attempted'), 'utf8').trim(), 'attempted');
      assert.match(result.stdout, /OWN=1 EXIT=0/);
      assert.match(result.stdout, /--outcome deferred/);
      assert.match(result.stdout, /merge-confirmation-read-failed-after-merge-accepted/);
    } else if (scenario !== 'permanent merge rejection') {
      assert.equal(readdirSync(dir).includes('merge-attempted'), false);
    }
    const directory = join(dir, 'dispatch/audit/automation-merge-actions');
    const receipts = (() => { try { return readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } })();
    assert.equal(receipts.length, (successfulMerge || ['permanent merge rejection', 'red CI after pending'].includes(scenario)) ? 1 : 0, result.stderr);
    if (receipts.length) {
      const receipt = JSON.parse(readFileSync(join(directory, receipts[0])));
      assert.equal(receipt.merged, successfulMerge);
      if (!successfulMerge) assert.equal(receipt.reason, scenario === 'red CI after pending' ? 'github-gate-red' : 'permanent-merge-rejection');
    }
  });
}

for (const scenario of ['recover', 'exhaust', 'permanent']) {
  test(`post-CI lease reacquire GitHub probe: ${scenario}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-reacquire-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/bin/sh
case "$*" in
  *'/check-runs?'*) echo '{"check_runs":[]}'; exit 0 ;;
  *'/statuses?'*) echo '[]'; exit 0 ;;
esac
n=0; [ ! -f "$TMPDIR/calls" ] || n=$(cat "$TMPDIR/calls")
n=$((n + 1)); echo "$n" > "$TMPDIR/calls"
if [ "$SCENARIO" = permanent ]; then echo 'HTTP 403 forbidden' >&2; exit 1; fi
if [ "$SCENARIO" = exhaust ] || [ "$n" = 1 ]; then
  echo 'GitHub read failed' >&2; echo 'TLS handshake timeout' >&2; exit 1
fi
echo '{"head":{"sha":"${'a'.repeat(40)}"},"labels":[]}'
`);
    chmodSync(gh, 0o755);
    // Render the production procedures, then execute the reacquire block with
    // only the lease CLI and audit sink replaced. The gh probe is real shell.
    const env = { HAM_PR_URL: 'https://github.com/acme/repo/pull/424242', HAM_REPO: 'acme/repo',
      HAM_PR_NUMBER: '424242', HAM_REVIEWED_SHA: 'a'.repeat(40), HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40),
      HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'tester',
      HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_AUDIT_PATH: join(dir, 'audit'), HAM_REVIEWER: 'claude',
      HAM_NODE_BIN: process.execPath, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, SCENARIO: scenario };
    const verify = renderPhase('hammer-verify-head', env);
    const merge = renderPhase('hammer-merge', env);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(merge.status, 0, merge.stderr);
    const helper = verify.stdout.match(/ham_pr\(\) \{[^\n]+/)[0] + '\n' + verify.stdout.slice(verify.stdout.indexOf('ham_lease_pr_view() {'), verify.stdout.indexOf('ham_acquire_merge_lease() {'));
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

test('rendered hammer phases preserve their executable shebang', () => {
  const env = Object.fromEntries([...['hammer-verify-head', 'hammer-publish', 'hammer-merge'].map(phase => readFileSync(join(root, 'bin', `${phase}.sh`), 'utf8')).join('\n').matchAll(/<<([A-Z_]+)>>/g)].map((m) => [`HAM_${m[1]}`, 'fixture']));
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    const rendered = renderPhase(phase, env);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(rendered.stdout.startsWith('#!/usr/bin/env bash\n'), phase);
  }
});

test('HAMLEASE-01 rendered waits have procedure floors and permit increases', () => {
  const env = Object.fromEntries([...['hammer-verify-head', 'hammer-publish', 'hammer-merge'].map(phase => readFileSync(join(root, 'bin', `${phase}.sh`), 'utf8')).join('\n').matchAll(/<<([A-Z_]+)>>/g)].map((m) => [`HAM_${m[1]}`, 'fixture']));
  for (const phase of ['hammer-verify-head', 'hammer-merge']) {
    const rendered = renderPhase(phase, env);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /Waits are fixed by the procedure; do not export or shorten them/);
    const helper = rendered.stdout.match(/ham_procedure_floor\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(helper);
    const assignments = rendered.stdout.match(/^ham_procedure_floor .*$/gm).join('\n');
    for (const given of ['120', '180', '1800', 'invalid', '0', '0001800', '1000000000']) {
      const result = run('bash', ['-c', `${helper}\n${assignments}\necho "$HAM_MERGE_LEASE_WAIT_SECONDS $HAM_REMOTE_CI_WAIT_SECONDS"`], {
        HAM_MERGE_LEASE_WAIT_SECONDS: given, HAM_REMOTE_CI_WAIT_SECONDS: given,
      });
      assert.equal(result.status, 0, result.stderr);
      const name = phase === 'hammer-merge' ? 'HAM_REMOTE_CI_WAIT_SECONDS' : 'HAM_MERGE_LEASE_WAIT_SECONDS';
      assert.match(result.stdout, given === '1000000000' ? /1000000000/ : /1800/.test(given) ? /1800/ : /900/);
      if (!/1800/.test(given) && given !== '1000000000') assert.match(result.stderr, new RegExp(`${name} given=${given} used=900`));
    }
  }
});

test('HAMLEASE-01 lease timeout note and audit retain waited and configured seconds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ham-timeout-'));
  const pr = String(2_000_000 + process.pid);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_HQ_ROOT: dir, HAM_REPO: 'acme/repo', HAM_PR_NUMBER: pr,
    HAM_PR_URL: `https://github.com/acme/repo/pull/${pr}`, HAM_REVIEWED_SHA: 'a'.repeat(40),
    HAM_REVIEWER: 'reviewer', HAM_RISK_CLASS: 'medium' };
  const rendered = renderPhase('hammer-verify-head', env);
  assert.equal(rendered.status, 0, rendered.stderr);
  const start = rendered.stdout.indexOf('  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 75 ]');
  const end = rendered.stdout.indexOf('  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -ne 0 ]', start);
  const stub = join(dir, 'audit-node');
  writeFileSync(stub, '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do\nif [ "$1" = --attempt-json ]; then cat "$2"; exit 0; fi\nshift\ndone\nexit 1\n', { mode: 0o755 });
  for (const evidence of [{ waited_s: 900 }, { waited_s: 0 }, { waited_s: null }, {}]) {
    writeFileSync(join(dir, 'merge-lease-acquire.json'), JSON.stringify({ timedOut: true, configured_s: 900, ...evidence }));
    const result = run('bash', ['-c', `HAM_MERGE_LEASE_ACQUIRE_EXIT=75 HAM_MERGE_LEASE_WAIT_SECONDS=900 HAM_NODE_BIN="$1" POST_REMEDIATION_SHA=${'a'.repeat(40)}
phase() { ${rendered.stdout.slice(start, end)} }
phase
`, '_', stub], { TMPDIR: dir });
    assert.equal(result.status, 20, result.stderr);
    assert.ok(result.stderr.includes(`after ${evidence.waited_s ?? 'null'}s (configured 900s); no merge`));
    assert.deepEqual(JSON.parse(result.stdout), {
      outcome: 'deferred', reason: 'merge-lease-timeout', waited_s: evidence.waited_s ?? null, configured_s: 900,
    });
  }
});
for (const scenario of ['first retry visible', 'already visible', 'two lag polls', 'visibility timeout', 'third head', 'initial third head',
  'transient TLS', 'transient HTTP 503', 'probe alarm', 'transient exhaustion',
  'permanent error', 'permanent numbered URL', 'malformed JSON', 'missing head', 'invalid head']) {
  test(`HAMCLOSE-07 verify-head: ${scenario}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-head-wait-'));
    const prNumber = String(2_000_000 + process.pid);
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
        for (const name of readdirSync('/tmp').filter(name => name.startsWith(`ham-${prNumber}-head-probe.`))) {
        rmSync(join('/tmp', name), { recursive: true, force: true });
      }
    });
    const before = 'a'.repeat(40), pushed = 'b'.repeat(40), third = 'c'.repeat(40);
    writeFileSync(join(dir, 'clock'), '1700000000');
    writeFileSync(join(dir, 'polls'), '0');
    writeFileSync(join(dir, 'date'), '#!/bin/sh\ncat "$TMPDIR/clock"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\necho "$1" >> "$TMPDIR/sleeps"\nn=$(cat "$TMPDIR/clock"); echo $((n + $1)) > "$TMPDIR/clock"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$2" in
  */check-runs\\?*) echo "$2" >> "$TMPDIR/check-api-reads"; printf '{"check_runs":[]}'; exit 0 ;;
  */statuses\\?*) echo "$2" >> "$TMPDIR/check-api-reads"; printf '[]'; exit 0 ;;
esac
n=$(cat "$TMPDIR/polls"); n=$((n + 1)); echo "$n" > "$TMPDIR/polls"
if [ "$n" -eq 3 ]; then cp "$HAM_RUN_DIR/pr-after.json" "$TMPDIR/cache-after-probe"; fi
if [ "$n" -ge 2 ]; then
  case "$HAM_TEST_SCENARIO" in
    'transient TLS'|'transient HTTP 503'|'probe alarm'|'transient exhaustion'|'permanent error'|'permanent numbered URL')
      if [ "$n" -eq 2 ] || [ "$HAM_TEST_SCENARIO" = 'transient exhaustion' ]; then
        printf '{partial'
        case "$HAM_TEST_SCENARIO" in
          'transient TLS') echo 'TLS handshake timeout' >&2 ;;
          'transient HTTP 503'|'transient exhaustion') echo 'HTTP 503 Service Unavailable' >&2 ;;
          'probe alarm') kill -ALRM $$ ;;
          'permanent error') echo 'HTTP 403 Forbidden' >&2 ;;
          'permanent numbered URL') echo 'https://api.github.com/repos/fixture/repo/pulls/1503 HTTP 404 Not Found' >&2 ;;
        esac
        exit 1
      fi ;;
    'malformed JSON') printf '{'; exit 0 ;;
    'missing head') printf '{}'; exit 0 ;;
    'invalid head') printf '{"headRefOid":"not-a-sha"}'; exit 0 ;;
  esac
fi
head=${before}
case "$HAM_TEST_SCENARIO" in
  'first retry visible') [ "$n" -lt 2 ] || head=${pushed} ;;
  'already visible') head=${pushed} ;;
  'two lag polls'|'transient TLS'|'transient HTTP 503'|'probe alarm') [ "$n" -lt 3 ] || head=${pushed} ;;
  'third head') [ "$n" -lt 2 ] || head=${third} ;;
  'initial third head') head=${third} ;;
esac
printf '{"head":{"sha":"%s"},"base":{"ref":"main"}}\\n' "$head"
`, { mode: 0o755 });
    const env = { HAM_PR_URL: 'https://github.com/fixture/repo/pull/1', HAM_PR_NUMBER: prNumber,
      HAM_REVIEWED_SHA: before, HAM_REPO: 'fixture/repo', HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_HQ_ROOT: dir,
      HAM_REVIEWER: 'synthetic-reviewer', HAM_RISK_CLASS: 'low', HAM_MERGE_METHOD: 'squash', HAM_TARGET_REMEDIATION_SHA: before, HAM_PUSHED_HEAD: pushed,
      HAM_PUSHED_FROM_HEAD: before, HAM_TEST_SCENARIO: scenario, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir };
    const rendered = renderPhase('hammer-verify-head', env);
    assert.equal(rendered.status, 0, rendered.stderr);
    // Execute the actual visibility gate and intercept the following phase boundary.
    const prefix = rendered.stdout.slice(0, rendered.stdout.indexOf('BASE_BRANCH='));
    let checksContinuation = '';
    if (scenario === 'two lag polls') {
      const verdict = join(dir, 'verdict.json');
      writeFileSync(verdict, JSON.stringify({ eligible: true, trace: {
        headMatch: { current: pushed }, branchProtection: { required: false },
      } }));
      const gate = { ok: false, state: 'OPEN', headMatches: true, expectedHead: pushed,
        liveHead: pushed, checksConclusion: 'PENDING', reasons: ['ci-not-green'] };
      const nodeStub = join(dir, 'gate-node');
      writeFileSync(nodeStub, `#!/bin/sh
case "$1" in
  --input-type=module)
    cat >/dev/null
    echo "$POST_REMEDIATION_SHA" >> "$TMPDIR/check-reads"
    if [ -f "$TMPDIR/checked" ]; then echo '${JSON.stringify({ ...gate, checksConclusion: 'FAILURE' })}';
    else touch "$TMPDIR/checked"; echo '${JSON.stringify(gate)}'; fi ;;
  */bin/ama-audit.mjs)
    while [ "$#" -gt 1 ]; do
      if [ "$1" = --attempt-json ]; then cat "$2"; break; fi
      shift
    done ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
      const merge = renderPhase('hammer-merge', env);
      assert.equal(merge.status, 0, merge.stderr);
      const mergeScript = join(dir, 'merge.sh');
      writeFileSync(mergeScript, merge.stdout);
      checksContinuation = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=synthetic-lease
HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdict} HAM_VERDICT_READY_FILE=${verdict}
HAM_PUBLISHED_AUDIT_HEAD=$POST_REMEDIATION_SHA
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
source ${mergeScript}
echo "CHECKS_OUTCOME=$HAM_PHASE_OUTCOME STATUS=$?"
echo "$HAM_NO_MERGE_NOTE"
exit 0`;
    }
    const result = run('/bin/bash', ['-c', `unset HAM_HEAD_WAITED_SECONDS HAM_REQUIRED_CHECKS_WAITED_SECONDS
${prefix}
echo "CONTINUE_TO_CHECKS head=$POST_REMEDIATION_SHA waited=$HAM_HEAD_WAITED_SECONDS"
}
ham_verify_head_phase
rc=$?
echo "OUTCOME=$HAM_PHASE_OUTCOME rc=$rc"
/bin/bash -c 'echo "CHILD_HEAD_WAIT=$HAM_HEAD_WAITED_SECONDS CHILD_CHECK_WAIT=$HAM_REQUIRED_CHECKS_WAITED_SECONDS"'
${checksContinuation}
exit "$rc"`], env);
    assert.ifError(result.error);
    assert.deepEqual(readdirSync('/tmp').filter(name => name.startsWith(`ham-${prNumber}-head-probe.`)), [], 'probe files are cleaned up');
    const checkReads = readFileSync(join(dir, 'check-api-reads'), 'utf8').trim().split('\n');
    assert.equal(checkReads.length, 2, 'only the initial full snapshot reads checks; visibility probes read PR metadata');
    if (['visibility timeout', 'transient exhaustion'].includes(scenario)) {
      assert.equal(result.status, 20, result.stderr);
      assert.match(result.stderr, /Waited 300s for the published head and 0s for required checks/);
      assert.match(result.stdout, /OUTCOME=published-head-timeout/);
      assert.match(result.stdout, /CHILD_HEAD_WAIT=300 CHILD_CHECK_WAIT=0/);
      assert.doesNotMatch(result.stdout, /CONTINUE_TO_CHECKS/);
      assert.equal(Number(readFileSync(join(dir, 'polls'), 'utf8')), 21);
      assert.deepEqual(readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n').map(Number),
        [2, ...Array(19).fill(15), 13], 'polling clamps its last delay to the deadline');
      assert.equal(JSON.parse(readFileSync(join(dir, 'pr-after.json'), 'utf8')).headRefOid, before);
    } else if (['permanent error', 'permanent numbered URL', 'malformed JSON', 'missing head', 'invalid head'].includes(scenario)) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /OUTCOME=verify-head-error rc=1/);
      assert.doesNotMatch(result.stdout, /CONTINUE_TO_CHECKS/);
      assert.equal(Number(readFileSync(join(dir, 'polls'), 'utf8')), 2);
      assert.equal(JSON.parse(readFileSync(join(dir, 'pr-after.json'), 'utf8')).headRefOid, before);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const recovered = ['transient TLS', 'transient HTTP 503', 'probe alarm'].includes(scenario);
      const expected = ['first retry visible', 'already visible', 'two lag polls'].includes(scenario) || recovered ? pushed : third;
      assert.match(result.stdout, new RegExp(`CONTINUE_TO_CHECKS head=${expected}`));
      if (recovered) {
        assert.match(result.stdout, /waited=17/);
        assert.equal(JSON.parse(readFileSync(join(dir, 'cache-after-probe'), 'utf8')).headRefOid, before);
        assert.equal(JSON.parse(readFileSync(join(dir, 'pr-after.json'), 'utf8')).headRefOid, pushed);
      }
      if (scenario === 'two lag polls') {
        assert.match(result.stdout, /CHILD_HEAD_WAIT=17 CHILD_CHECK_WAIT=0/);
        assert.match(result.stdout, /CHECKS_OUTCOME=github-gate-red STATUS=20/);
        assert.match(result.stdout, /Waited 17s for the published head and 30s for required checks/);
        const reads = readFileSync(join(dir, 'check-reads'), 'utf8').trim().split('\n');
        assert.equal(reads.length, 2);
        assert.deepEqual(reads, [pushed, pushed]);
      }
      assert.equal(Number(readFileSync(join(dir, 'polls'), 'utf8')), scenario === 'two lag polls' || recovered ? 3 : ['first retry visible', 'third head'].includes(scenario) ? 2 : 1);
      const sleeps = existsSync(join(dir, 'sleeps')) ? readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n').map(Number) : [];
      assert.deepEqual(sleeps, scenario === 'two lag polls' ? [2, 15, 30]
        : recovered ? [2, 15] : ['first retry visible', 'third head'].includes(scenario) ? [2] : []);
      if (scenario === 'first retry visible') assert.match(result.stdout, /CHILD_HEAD_WAIT=2 CHILD_CHECK_WAIT=0/);
      if (['already visible', 'initial third head'].includes(scenario)) assert.match(result.stdout, /CHILD_HEAD_WAIT=0 CHILD_CHECK_WAIT=0/);
    }
  });
}


for (const route of ['API commit', 'git fallback', 'git fallback without API head']) {
  test(`HAMCLOSE-07 publication remembers its exact head: ${route}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-pushed-head-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const before = 'a'.repeat(40), pushed = 'b'.repeat(40);
    writeFileSync(join(dir, 'publisher'), '#!/bin/sh\nprintf "%s\\n" "$PUBLISH_RESULT"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$1" in rev-parse) echo ${pushed};; push) exit 0;; *) exit 1;; esac\n`, { mode: 0o755 });
    const publication = route === 'API commit' ? { route: 'published', head: pushed, previousHead: before }
      : { route: 're-review', ...(route === 'git fallback' ? { previousHead: before, fallbackHead: before, branch: 'repair' } : {}) };
    const env = { HAM_PR_URL: 'https://github.com/fixture/repo/pull/1', HAM_PR_NUMBER: '1',
      HAM_REVIEWED_SHA: before, HAM_REPO: 'fixture/repo', HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_HQ_ROOT: dir,
      HAM_REVIEWER: 'synthetic-reviewer', HAM_RISK_CLASS: 'low',
      HAM_COMMIT_PUBLICATION_ONLY: '1', HAM_NODE_BIN: join(dir, 'publisher'), HAM_BASE_HEAD: before,
      POST_REMEDIATION_SHA: '',
      HAM_REMOTE_CI_STARTED_AT: '1', HAM_NO_MERGE_NOTE: 'stale wait',
      PATH: `${dir}:${process.env.PATH}`, PUBLISH_RESULT: JSON.stringify(publication) };
    const render = renderPhase('hammer-publish', env);
    assert.equal(render.status, 0, render.stderr);
    const script = join(dir, 'publish.sh');
    writeFileSync(script, render.stdout);
    const result = run('/bin/bash', ['-c', `unset HAM_HEAD_WAITED_SECONDS HAM_REQUIRED_CHECKS_WAITED_SECONDS
source "$1" || exit $?
echo "PUSHED=$HAM_PUSHED_HEAD FROM=$HAM_PUSHED_FROM_HEAD CHECK_START=\${HAM_REMOTE_CI_STARTED_AT:-unset} NOTE=$HAM_NO_MERGE_NOTE"
/bin/bash -c 'echo "CHILD_HEAD_WAIT=$HAM_HEAD_WAITED_SECONDS CHILD_CHECK_WAIT=$HAM_REQUIRED_CHECKS_WAITED_SECONDS"'`, '_', script], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`PUSHED=${pushed} FROM=${before} CHECK_START=unset NOTE=$`, 'm'));
    assert.match(result.stdout, /CHILD_HEAD_WAIT=0 CHILD_CHECK_WAIT=0/);
  });
}

test('GHBUDGET-01: rendered pending CI uses at most eleven REST check snapshots in five minutes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const env = {
    HAM_RUN_DIR: dir, HAM_ROOT_DIR: root, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42',
    HAM_PR_URL: 'https://github.com/fixture/repo/pull/42', HAM_REVIEWED_SHA: head,
    HAM_TARGET_REMEDIATION_SHA: head, HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash',
    HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'fixture', HAM_AUDIT_PATH: join(dir, 'audit'), HAM_REVIEWER: 'fixture',
    HAM_NODE_BIN: process.execPath, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json'),
  };
  writeFileSync(join(dir, 'clock'), '1700000000');
  writeFileSync(join(dir, 'date'), '#!/bin/sh\nif [ "$1" = +%s ]; then cat "$TMPDIR/clock"; else exec /bin/date "$@"; fi\n', { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), `#!${process.execPath}
const fs = require('node:fs'); const file = process.env.TMPDIR + '/clock';
fs.writeFileSync(file, String(Number(fs.readFileSync(file)) + Number(process.argv[2])));
`, { mode: 0o755 });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMPDIR + '/calls.jsonl', JSON.stringify({args, at: Number(fs.readFileSync(process.env.TMPDIR + '/clock'))}) + '\\n');
const path = args[1];
if (args[0] !== 'api') process.exit(1);
if (path.includes('/check-runs?')) console.log(JSON.stringify({check_runs:[{name:'fixture-ci',status:'queued',conclusion:null,created_at:'2026-01-01T00:00:00Z'}]}));
else if (path.includes('/statuses?')) console.log('[]');
else if (path.endsWith('/pulls/42')) console.log(JSON.stringify({number:42,state:'open',draft:false,head:{sha:'${head}'},base:{sha:'${'b'.repeat(40)}',ref:'main'},mergeable:true,mergeable_state:'clean',labels:[]}));
else process.exit(1);
`, { mode: 0o755 });
  const rendered = renderPhase('hammer-merge', env);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.doesNotMatch(rendered.stdout, /(?:ham_gh|gh) pr checks[^\n]*--watch/);
  const helperStart = rendered.stdout.indexOf('ham_wait_for_check_poll() {');
  const helperEnd = rendered.stdout.indexOf('ham_merge_error_retryable() {');
  const loopStart = rendered.stdout.indexOf('HAM_LOCAL_CI_STATUS=');
  const loopEnd = rendered.stdout.indexOf('if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] &&');
  const script = `${rendered.stdout.slice(helperStart, helperEnd)}
HAM_NODE_BIN=${process.execPath}
HAM_REMOTE_CI_POLL_SECONDS=30 HAM_REMOTE_CI_WAIT_SECONDS=300 HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT=3
export AMA_CI_COST_MODE=blocking
HAM_BRANCH_PROTECTION_REQUIRED=false HAM_MERGE_RETRY_CAP=1 HAM_MERGE_LEASE_HELD=1
POST_REMEDIATION_SHA=${head} HAM_GATE_JSON="$TMPDIR/gate.json"
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
ham_append_terminal_audit() { :; }
ham_mark_merge_lease_retryable_abort() { :; }
close() { ${rendered.stdout.slice(loopStart, loopEnd)} }
close
`;
  const result = spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 20, result.stderr);
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const checks = calls.filter(call => call.args[1].includes('/check-runs?'));
  assert.equal(checks.length, 11);
  for (let i = 1; i < checks.length; i++) assert.ok(checks[i].at - checks[i - 1].at >= 30);
  assert.equal(calls.filter(call => call.args.includes('graphql')).length, 0);
  assert.equal(calls.filter(call => call.args.includes('--watch')).length, 0);
});

test('GHBUDGET-01: REST hammer checks preserve latest reruns and commit statuses', async () => {
  const { fetchHammerPr } = await import('../src/hammer-pr-read.mjs');
  const { classifyCheckRollup } = await import('../src/checks-summary.mjs');
  const snapshot = await fetchHammerPr('fixture/repo', 42, { read: async path => {
    if (path.includes('/check-runs?')) return { check_runs: [
      { name: 'CI', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z' },
      { name: 'CI', status: 'queued', conclusion: null, created_at: '2026-01-01T00:01:00Z' },
    ] };
    if (path.includes('/statuses?')) return [{ context: 'external', state: 'success' }];
    return { state: 'open', head: { sha: 'a'.repeat(40) }, labels: [], mergeable: true, mergeable_state: 'clean' };
  } });
  assert.equal(classifyCheckRollup(snapshot.checks), 'PENDING');
  assert.equal(snapshot.checks[2].context, 'external');
});

test('GHBUDGET-01: count a rendered common hammer close with fake gh', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-common-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sharedTmp = dir;
  const legacyPath = join(sharedTmp, 'ham-42-pr-after.json');
  writeFileSync(legacyPath, 'foreign read-only evidence', { mode: 0o444 });
  const scratchDir = join(dir, 'private-scratch');
  mkdirSync(scratchDir, { mode: 0o700 });
  const { default: Database } = await import('better-sqlite3');
  // Render against an isolated root while reusing the checked-in procedures.
  for (const name of ['bin', 'src', 'node_modules', 'domains']) {
    symlinkSync(join(root, name), join(dir, name), 'dir');
  }
  symlinkSync(join(root, 'config.yaml'), join(dir, 'config.yaml'), 'file');
  mkdirSync(join(dir, 'data'));
  const db = new Database(join(dir, 'data', 'reviews.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS ham_finding_disputes (identity TEXT, head_sha TEXT,
    finding_reviewed_head TEXT, evidence_sha256 TEXT, resolution TEXT, comment_id TEXT,
    comment_author TEXT, comment_sha256 TEXT, repo TEXT, pr_number INTEGER)`);
  db.close();
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const env = {
    HAM_RUN_DIR: scratchDir, HAM_ROOT_DIR: dir, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42',
    HAM_PR_URL: 'https://github.com/fixture/repo/pull/42', HAM_REVIEWED_SHA: head,
    HAM_TARGET_REMEDIATION_SHA: head, HAM_RISK_CLASS: 'medium', HAM_MERGE_METHOD: 'squash',
    HAM_HQ_ROOT: dir, HAM_HQ_OWNER: 'fixture', HAM_AUDIT_PATH: join(dir, 'audit'), HAM_REVIEWER: 'fixture',
    HAM_BASE_HEAD: head, HAM_VALIDATION_BASE_SHA: base,
    HAM_AUDIT_DETAILS_FILE: join(dir, 'details'), HAMMER_LACEY_GH_TOKEN: 'fixture-token',
    HAM_AUDIT_REMEDIATED_TOTAL: '0', HAM_AUDIT_REMEDIATED_BLOCKING: '0', HAM_AUDIT_REMEDIATED_NON_BLOCKING: '0',
    HAM_DOC_CURRENCY: 'not applicable', HAM_DOC_CURRENCY_REASON: 'synthetic no-diff close',
    HAM_FAILING_TESTS_FIXED: 'fixture CI green', HAM_AMA_TRAILERS: 'Worker-Class: hammer\nTicket: GHBUDGET-01',
    REAL_NODE: process.execPath, HAM_NODE_BIN: join(dir, 'node-stub'),
    PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json'),
  };
  writeFileSync(join(dir, 'details'), 'Synthetic no-diff close.');
  writeFileSync(join(dir, 'clock'), '1700000000');
  writeFileSync(join(dir, 'verdict'), JSON.stringify({ eligible: true, trace: { headMatch: { current: head }, branchProtection: { required: false } } }));
  writeFileSync(join(dir, 'date'), '#!/bin/sh\nif [ "$1" = +%s ]; then cat "$TMPDIR/clock"; else exec /bin/date "$@"; fi\n', { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), `#!${process.execPath}
const fs = require('node:fs'); const file = process.env.TMPDIR + '/clock';
fs.writeFileSync(file, String(Number(fs.readFileSync(file)) + Number(process.argv[2])));
`, { mode: 0o755 });
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$*" in 'rev-parse HEAD') echo '${head}' ;; *) echo '${base}' ;; esac\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'node-stub'), `#!/bin/sh
case "$1" in
  */merge-lease.mjs)
    if [ "$2" = acquire ]; then echo '{"leaseId":"fixture-lease"}';
    elif [ "$2" = needs-revalidation ]; then echo '{"needsRevalidation":false}';
    else echo '{}'; fi ;;
  */ama-audit.mjs|*/merge-action-receipt.mjs|*/watcher-wake.mjs) echo '{}' ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMPDIR + '/calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'merge') { fs.writeFileSync(process.env.TMPDIR + '/merged', '1'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'comment') process.exit(0);
const path = args.find(arg => arg.startsWith('repos/')) || '';
if (path.includes('/check-runs')) console.log(JSON.stringify({total_count:1,check_runs:[{id:1,name:'fixture-ci',status:'completed',conclusion:'success',created_at:'2026-01-01T00:00:00Z'}]}));
else if (path.includes('/statuses')) console.log('[]');
else if (path.includes('/reviews') || path.includes('/files?')) console.log('[]');
else if (path.includes('/comments')) console.log('[[]]');
else if (path.includes('/protection')) console.log('{"strict":false}');
else if (path.includes('/compare/')) console.log(JSON.stringify({status:'ahead',total_commits:0,commits:[],merge_base_commit:{sha:'${base}'},files:[]}));
else if (path.includes('/git/trees/')) console.log('{"tree":[],"truncated":false}');
else if (path.endsWith('/pulls/42')) console.log(JSON.stringify({number:42,title:'Synthetic budget fixture',body:'Synthetic body',state:'open',draft:false,head:{sha:'${head}',ref:'fixture-branch'},base:{sha:'${base}',ref:'main'},mergeable:true,mergeable_state:'clean',labels:[],changed_files:0,merged_at:fs.existsSync(process.env.TMPDIR+'/merged')?'2026-01-01T00:00:00Z':null,merge_commit_sha:'${'c'.repeat(40)}'}));
else { console.error('Unexpected synthetic call: ' + JSON.stringify(args)); process.exit(1); }
`, { mode: 0o755 });
  const phasePaths = [];
  for (const phase of ['hammer-verify-head', 'hammer-publish', 'hammer-merge']) {
    const rendered = renderPhase(phase, env);
    assert.equal(rendered.status, 0, rendered.stderr);
    const path = join(dir, `${phase}.sh`);
    writeFileSync(path, rendered.stdout
      .replace('if ! ham_emit_git_merge_signal; then', 'if ! ham_fixture_success; then')
      .replace('if ! ham_mark_ama_closer_lease_succeeded; then', 'if ! ham_fixture_success; then'));
    phasePaths.push(path);
  }
  const script = `ham_fixture_success() { return 0; }
source "$1" || exit $?
source "$2" || exit $?
HAM_VERDICT_FILE="$TMPDIR/verdict" HAM_VERDICT_READY_FILE="$TMPDIR/verdict"
source "$3" || exit $?
echo COMMON_CLOSE_SUCCEEDED
`;
  const result = spawnSync('/bin/bash', ['-c', script, '_', ...phasePaths], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /COMMON_CLOSE_SUCCEEDED/);
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const graphql = calls.filter(args => args[0] === 'pr' || args.includes('graphql'));
  const rest = calls.filter(args => !graphql.includes(args));
  assert.equal(readFileSync(legacyPath, 'utf8'), 'foreign read-only evidence');
  assert.equal(readFileSync(join(scratchDir, 'pr-after.json'), 'utf8').includes(head), true);
  t.diagnostic(`GHBUDGET common close: GraphQL=${graphql.length} REST=${rest.length} total=${calls.length}`);
  assert.equal(graphql.length, 2, 'the existing gh pr comment and merge commands use GraphQL');
  assert.equal(rest.length, 42);
});

test('GHBUDGET-01: REST prompt snapshots preserve review authors and exact commit heads', async () => {
  const { fetchHammerPr } = await import('../src/hammer-pr-read.mjs');
  const calls = [], head = 'a'.repeat(40);
  const snapshot = await fetchHammerPr('fixture/repo', 42, { withChecks: false, withReviews: true, read: async path => {
    calls.push(path);
    if (path.includes('/reviews?')) return [{ user: { login: 'fixture-reviewer' }, commit_id: head,
      body: 'Synthetic review', state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' }];
    return { state: 'open', head: { sha: head }, labels: [] };
  } });
  assert.equal(snapshot.reviews[0].author.login, 'fixture-reviewer');
  assert.equal(snapshot.reviews[0].commit.oid, head);
  assert.equal(snapshot.reviews[0].submittedAt, '2026-01-01T00:00:00Z');
  assert.equal(calls.length, 2);
  const prompt = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
  for (const block of prompt.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
    const commands = block[1].split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(commands, /(?<![\w-])gh (?:api|pr)/, 'prompt commands must use a metered helper');
  }
});
