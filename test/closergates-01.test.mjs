// CLOSERGATES-01: closure-gate reads retry transient failures in place, a
// closer that already pushed a validated head resumes at closure, and a
// conflict found at closure is repaired rather than terminal. Synthetic,
// offline fixtures only.
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyClosureGateFailure, readClosureGateSync } from '../src/ama/closure-gate-read.mjs';
import { collectPredicateInputs, PREDICATE_PR_FIELDS } from '../src/ama/predicate-inputs.mjs';
import {
  CLOSURE_RESUME_FILE, CLOSURE_RESUME_REASON, closureResumeEvidence, composeClosureResumePrompt, readClosureResume, recordClosureResume,
} from '../src/ama/closure-resume.mjs';
import { appendAmaAuditAttempt, readAmaAuditEntry } from '../src/ama/audit.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES } from '../src/ama/hammer-phase-outcome.mjs';
import { CONFLICT_REPAIR_BUDGET, RepairableConflictError, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { withHammerTokenSync } from '../src/hammer-token.mjs';

const REPO = 'acme/widgets';
const PR = 42;
const HEAD = 'a1'.repeat(20);
const REVIEWED = 'b2'.repeat(20);
const MOVED = 'c3'.repeat(20);
const LRQ = 'lrq_closergates-fixture';
const ROOT = resolve(import.meta.dirname, '..');

function fakeClock() {
  const clock = { at: 0, sleeps: [], reads: [] };
  clock.now = () => clock.at;
  clock.sleep = ms => { clock.sleeps.push(ms); clock.at += ms; };
  return clock;
}

function scratch(t, prefix = 'closergates-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const httpError = message => Object.assign(new Error(message), { stderr: message });
const SNAPSHOT = JSON.stringify({ number: PR, headRefOid: HEAD, baseRefName: 'main', state: 'OPEN' });

// A stub GitHub: each path answers from a queue of scripted failures, then
// its steady answer. Every read is logged with the fake time it started at.
function stubGitHub(clock, { failures = {}, answers = {} } = {}) {
  const queues = Object.fromEntries(Object.entries(failures).map(([key, list]) => [key, [...list]]));
  const answer = key => {
    clock.reads.push({ key, at: clock.at });
    const next = queues[key]?.shift();
    if (next) throw httpError(next);
    const steady = answers[key];
    if (steady instanceof Error) throw steady;
    return steady ?? (key === 'pr' ? SNAPSHOT : key === 'reviews' ? '{"reviews":[]}' : key === 'timeline' ? '[]' : '{}');
  };
  return {
    readPr: args => answer(args[1] === PREDICATE_PR_FIELDS ? 'pr' : 'reviews'),
    readApi: ([path]) => answer(path.endsWith('/protection') ? 'protection'
      : path.endsWith('/branches/main') ? 'branch'
        : path.includes('/timeline') ? 'timeline' : path.includes('/commits/') ? 'commit' : path),
  };
}

function collect(t, clock, github, overrides = {}) {
  const runDir = scratch(t);
  const result = collectPredicateInputs({ repo: REPO, prNumber: PR, headSha: HEAD, runDir, clock, ...github, ...overrides });
  return { result, runDir, files: readdirSync(runDir).sort() };
}

test('CLOSERGATES-01: a gate read that fails twice transiently, then succeeds, finishes in the same run with spaced attempts', t => {
  const clock = fakeClock();
  const github = stubGitHub(clock, { failures: { pr: ['gh: Service Unavailable (HTTP 503)', 'read ETIMEDOUT'] } });
  const { result, files } = collect(t, clock, github);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(clock.reads.filter(read => read.key === 'pr').map(read => read.at), [0, 2_000, 7_000]);
  assert.deepEqual(clock.sleeps, [2_000, 5_000]);
  // Every predicate input is written, so the predicate and merge follow in this run.
  assert.deepEqual(files, ['commit.json', 'pr-after.json', 'protection.json', 'reviews.json', 'timeline.json']);
});

test('CLOSERGATES-01: the shared read policy classifies transient, not-found and definitive failures', () => {
  for (const detail of ['gh: Bad Gateway (HTTP 502)', 'HTTP 503', 'connect ECONNRESET', 'API rate limit exceeded',
    'GitHub credential rejected or unavailable; entitled token refresh failed (timeout or signal)',
    'GitHub credential rejected or unavailable; entitled token refresh failed (command error)']) {
    assert.equal(classifyClosureGateFailure(detail), 'transient', detail);
  }
  assert.equal(classifyClosureGateFailure('gh: Branch not found (HTTP 404)'), 'not-found');
  for (const detail of ['gh: Bad credentials (HTTP 401)', 'gh: Resource not accessible by integration (HTTP 403)',
    'GitHub credential rejected or unavailable; entitled token refresh failed (empty or invalid output)']) {
    assert.equal(classifyClosureGateFailure(detail), 'definitive', detail);
  }
});

test('CLOSERGATES-01: definitive refusals still refuse at once, and write no input', t => {
  for (const [detail, reason] of [
    ['gh: Resource not accessible by integration (HTTP 403)', 'protection-read-failed'],
    ['gh: Bad credentials (HTTP 401)', 'protection-read-failed'],
  ]) {
    const clock = fakeClock();
    const { result, files } = collect(t, clock, stubGitHub(clock, { answers: { protection: httpError(detail) } }));
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'definitive');
    assert.equal(result.reason, reason);
    assert.deepEqual(clock.sleeps, [], 'a definitive answer is never retried');
    assert.deepEqual(files, [], 'nothing unreadable becomes a passing input');
  }
  // A head that moved is authoritative: no input, no retry.
  const clock = fakeClock();
  const moved = JSON.stringify({ number: PR, headRefOid: MOVED, baseRefName: 'main' });
  const { result, files } = collect(t, clock, stubGitHub(clock, { answers: { pr: moved } }));
  assert.equal(result.reason, 'head-changed');
  assert.deepEqual(files, []);
  // A base ref that is not a branch name (a transcribed trailing newline) refuses.
  const bad = fakeClock();
  const newline = JSON.stringify({ number: PR, headRefOid: HEAD, baseRefName: 'main\n' });
  assert.equal(collect(t, bad, stubGitHub(bad, { answers: { pr: newline } })).result.reason, 'predicate-input-malformed');
});

test('CLOSERGATES-01: a protection 404 that a branch read contradicts is retried; a persistent 404 refuses with its own reason', t => {
  let clock = fakeClock();
  let run = collect(t, clock, stubGitHub(clock, {
    failures: { protection: ['gh: Branch not found (HTTP 404)'] },
    answers: { protection: '{"required_status_checks":{"contexts":["ci"]}}', branch: '{"name":"main","protected":true}' },
  }));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.equal(clock.reads.filter(read => read.key === 'protection').length, 2);
  assert.equal(clock.reads.filter(read => read.key === 'branch').length, 1, 'the contradicting re-read');
  assert.deepEqual(JSON.parse(readFileSync(join(run.runDir, 'protection.json'), 'utf8')).required_status_checks.contexts, ['ci']);

  // Persistent, while the branch read keeps contradicting it.
  clock = fakeClock();
  run = collect(t, clock, stubGitHub(clock, { answers: {
    protection: httpError('gh: Branch not found (HTTP 404)'), branch: '{"name":"main","protected":true}' } }));
  assert.equal(run.result.reason, 'protection-branch-not-found');
  assert.equal(run.result.kind, 'definitive');
  assert.ok(clock.reads.filter(read => read.key === 'protection').length > 2);
  assert.ok(clock.at <= 120_000);
  assert.deepEqual(run.files, [], 'a 404 is never written as "no protection"');

  // Confirmed: the base itself is missing.
  clock = fakeClock();
  run = collect(t, clock, stubGitHub(clock, { answers: {
    protection: httpError('gh: Branch not found (HTTP 404)'), branch: httpError('gh: Branch not found (HTTP 404)') } }));
  assert.equal(run.result.reason, 'protection-branch-not-found');
  assert.deepEqual(clock.sleeps, []);

  // "Branch not protected" is a real answer, kept for ama-check to classify.
  clock = fakeClock();
  run = collect(t, clock, stubGitHub(clock, { answers: { protection: httpError('gh: Branch not protected (HTTP 404)') } }));
  assert.equal(run.result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(run.runDir, 'protection.json'), 'utf8')),
    { status: '404', message: 'Branch not protected' });
});

function hammerEnv(hqRoot, runDir, overrides = {}) {
  const body = ['HAM audit', 'HAM-Base-Head: ' + REVIEWED, `HAM-Validated-Head: ${HEAD}`].join('\n');
  return { HAM_HQ_ROOT: hqRoot, HAM_RUN_DIR: runDir, HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_REVIEWED_SHA: REVIEWED, HAM_TARGET_REMEDIATION_SHA: REVIEWED, HAM_BASE_HEAD: REVIEWED,
    POST_REMEDIATION_SHA: HEAD, HAM_PUBLISHED_AUDIT_HEAD: HEAD, HAM_AUDIT_COMMENT_BODY: body,
    HQ_LAUNCH_REQUEST_ID: LRQ, HQ_WORKER_RUN_ID: 'wrun_closergates-fixture', ...overrides };
}

function terminalReceipt(hqRoot) {
  return join(hqRoot, 'dispatch', LRQ, 'hammer-progress', 'wrun_closergates-fixture', 'terminal-stop.json');
}

test('CLOSERGATES-01: definitive predicate CLI refusals emit a final progress receipt and audit', t => {
  const hqRoot = scratch(t);
  const runDir = scratch(t);
  const node = join(runDir, 'node-fixture');
  // Replace only the child reader; run the actual CLI and refusal reporting.
  writeFileSync(node, '#!/bin/sh\nprintf \'%s\\n\' \'{"number":42,"headRefOid":"' + HEAD
    + '","baseRefName":"main\\\\n"}\'\n', { mode: 0o755 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(HQ_|HAM_|AGENT_OS_|LAUNCH_REQUEST_ID$)/.test(key)));
  const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'hammer-predicate-inputs.mjs')], {
    env: { ...inherited, ...hammerEnv(hqRoot, runDir), HAM_NODE_BIN: node },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /predicate-input-malformed/);
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, HEAD).attempts.at(-1).reason, 'predicate-input-malformed');
  assert.equal(JSON.parse(readFileSync(terminalReceipt(hqRoot), 'utf8')).reason, 'predicate-input-malformed');
});

test('CLOSERGATES-01: closure resume compares SHA values without case sensitivity', t => {
  const env = hammerEnv(scratch(t), scratch(t));
  const expected = closureResumeEvidence(env);
  for (const post of [HEAD, HEAD.toUpperCase()]) {
    for (const published of [HEAD, HEAD.toUpperCase()]) {
      for (const comment of [HEAD, HEAD.toUpperCase()]) {
        const evidence = closureResumeEvidence({ ...env, POST_REMEDIATION_SHA: post,
          HAM_PUBLISHED_AUDIT_HEAD: published, HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${comment}` });
        assert.equal(evidence?.validatedHead, HEAD);
        assert.equal(evidence?.validation.auditPublishedHead, HEAD);
      }
    }
  }
  assert.ok(expected);
  for (const overrides of [
    { HAM_PUBLISHED_AUDIT_HEAD: MOVED.toUpperCase() },
    { POST_REMEDIATION_SHA: 'invalid' },
    { HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${MOVED.toUpperCase()}` },
    { HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${HEAD}\nHAM-Validated-Head: ${HEAD.toUpperCase()}` },
    { HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${HEAD} extra` },
  ]) assert.equal(closureResumeEvidence({ ...env, ...overrides }), null);
});

test('CLOSERGATES-01: an exhausted transient gate writes a closure-resume receipt for the validated head', t => {
  const hqRoot = scratch(t);
  const clock = fakeClock();
  const { result, files } = collect(t, clock, stubGitHub(clock, {
    answers: { timeline: httpError('gh: Gateway Timeout (HTTP 504)') } }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'exhausted');
  assert.equal(result.gate, 'timeline');
  assert.equal(result.reason, CLOSURE_RESUME_REASON);
  assert.ok(clock.at >= 120_000 && clock.at <= 120_000 + 1, `budget spent at ${clock.at}`);
  assert.deepEqual(files, []);
  assert.ok(HAMMER_RETRYABLE_READ_OUTCOMES.has(result.reason), 'an infrastructure deferral, never a no-merge verdict');

  assert.ok(recordClosureResume({ env: hammerEnv(hqRoot, scratch(t)), gate: result.gate, detail: result.detail }));
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, HEAD).status, 'deferred');
  const receipt = readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD });
  assert.equal(receipt.validatedHead, HEAD);
  assert.equal(receipt.reviewedHead, REVIEWED);
  assert.equal(receipt.gate, 'timeline');
  assert.equal(receipt.launchRequestId, LRQ);
  assert.match(receipt.validation.auditCommentSha256, /^[a-f0-9]{64}$/);

  // No receipt without a published validation audit for that exact head.
  const unpublished = scratch(t);
  assert.equal(recordClosureResume({ env: hammerEnv(unpublished, scratch(t), { HAM_PUBLISHED_AUDIT_HEAD: '' }), gate: 'timeline' }), null);
  assert.equal(recordClosureResume({ env: hammerEnv(unpublished, scratch(t),
    { HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${MOVED}` }), gate: 'timeline' }), null);
});

test('CLOSERGATES-01: a moved head voids the receipt, and any later settled attempt supersedes it', t => {
  const hqRoot = scratch(t);
  recordClosureResume({ env: hammerEnv(hqRoot, scratch(t)), gate: 'protection' });
  assert.ok(readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD }));
  assert.equal(readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: MOVED }), null);
  // An in-flight marker does not supersede; a later refusal does.
  appendAmaAuditAttempt({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD, attempt: { outcome: 'in_progress' } });
  assert.ok(readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD }));
  appendAmaAuditAttempt({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD,
    attempt: { outcome: 'failed-without-merge', reason: 'github-gate-red', launchRequestId: 'lrq_later' } });
  assert.equal(readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD }), null);
});

function gitRepoAt(t) {
  const dir = scratch(t, 'closergates-git-');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git('add', 'file.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'one');
  return { dir, head: git('rev-parse', 'HEAD').stdout.trim(), git };
}

function runValidate(cwd, runDir, marker) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HQ_|HAM_)/.test(key)));
  return spawnSync(process.execPath, [join(ROOT, 'bin', 'hammer-validate.mjs'), '--',
    process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  { cwd, encoding: 'utf8', env: { ...env, HAM_RUN_DIR: runDir }, timeout: 60_000 });
}

test('CLOSERGATES-01: the next attempt on the same head runs only the closure gates: no remediation or validation step', t => {
  const hqRoot = scratch(t);
  const repo = gitRepoAt(t);
  const env = hammerEnv(hqRoot, scratch(t), { POST_REMEDIATION_SHA: repo.head, HAM_PUBLISHED_AUDIT_HEAD: repo.head,
    HAM_AUDIT_COMMENT_BODY: `HAM-Validated-Head: ${repo.head}` });
  recordClosureResume({ env, gate: 'pr-snapshot' });
  const receipt = readClosureResume({ hqRoot, repo: REPO, prNumber: PR, headSha: repo.head });
  // The closer hands the receipt to the next run directory with a closure-only prompt.
  const runDir = scratch(t);
  writeFileSync(join(runDir, CLOSURE_RESUME_FILE), JSON.stringify(receipt));
  const prompt = composeClosureResumePrompt(receipt);
  assert.match(prompt, /runs ONLY the closure gates and the merge/);
  assert.match(prompt, /Do not remediate, edit, commit or re-run validation/);
  const marker = join(runDir, 'validation-ran');
  const result = runValidate(repo.dir, runDir, marker);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /closure resume: head [a-f0-9]{40} was validated by launch/);
  assert.equal(existsSync(marker), false, 'the validation step was not invoked');
});

test('CLOSERGATES-01: a conflict at verification is rebased and revalidated, never terminal', t => {
  const hqRoot = scratch(t);
  const runDir = scratch(t);
  const repo = gitRepoAt(t);
  const env = hammerEnv(hqRoot, runDir, { POST_REMEDIATION_SHA: repo.head, HAM_TARGET_REMEDIATION_SHA: repo.head });
  writeFileSync(join(runDir, CLOSURE_RESUME_FILE), JSON.stringify({ schemaVersion: 1, validatedHead: repo.head,
    reviewedHead: REVIEWED, gate: 'protection', launchRequestId: LRQ }));
  // verify-head exits 21; the phase wrapper records the conflict (non-final).
  assert.equal(recordHammerEarlyFailure('rebase-conflict', { env, headSha: repo.head }), null);
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, repo.head), null, 'repairable work writes no terminal audit');
  const nonFinalCli = spawnSync(process.execPath, [join(ROOT, 'bin', 'hammer-terminal-audit.mjs'), 'rebase-conflict', repo.head],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(nonFinalCli.status, 0, nonFinalCli.stderr);
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, repo.head), null);
  // Ending the run on it is refused while the repair budget lasts.
  assert.throws(() => recordHammerEarlyFailure('rebase-conflict', { env, headSha: repo.head, final: true }),
    RepairableConflictError);
  const cli = spawnSync(process.execPath, [join(ROOT, 'bin', 'hammer-terminal-audit.mjs'), '--final', 'rebase-conflict', repo.head],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(cli.status, 65, cli.stderr);
  assert.match(cli.stderr, /repairable, not terminal[\s\S]*Run Appendix D/);
  assert.equal(existsSync(terminalReceipt(hqRoot)), false);

  // Appendix D rebases: the head moves, so the resumed run validates it normally.
  writeFileSync(join(repo.dir, 'file.txt'), 'rebased\n');
  repo.git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'rebased');
  const marker = join(runDir, 'revalidated');
  const result = runValidate(repo.dir, runDir, marker);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'the rebased head is revalidated');

  // The budget is per run: conflicts on CONFLICT_REPAIR_BUDGET heads may end it.
  for (let i = 1; i < CONFLICT_REPAIR_BUDGET; i += 1) {
    recordHammerEarlyFailure('rebase-conflict', { env, headSha: String(i).repeat(40) });
  }
  assert.ok(recordHammerEarlyFailure('rebase-conflict', { env, headSha: repo.head, final: true }));
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, repo.head).attempts.at(-1).reason, 'conflict-repair-exhausted');
  assert.equal(JSON.parse(readFileSync(terminalReceipt(hqRoot), 'utf8')).reason, 'conflict-repair-exhausted');
});

test('CLOSERGATES-01: final conflict reports alone count distinct heads and exhaust the repair budget', t => {
  const hqRoot = scratch(t);
  const runDir = scratch(t);
  const env = hammerEnv(hqRoot, runDir);
  const heads = [HEAD, REVIEWED, MOVED];
  for (let i = 0; i < CONFLICT_REPAIR_BUDGET; i += 1) {
    const result = spawnSync(process.execPath,
      [join(ROOT, 'bin', 'hammer-terminal-audit.mjs'), '--final', 'rebase-conflict', heads[i]],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, i < CONFLICT_REPAIR_BUDGET - 1 ? 65 : 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'conflict-repairs.json'), 'utf8')).heads, heads.slice(0, i + 1));
    if (i < CONFLICT_REPAIR_BUDGET - 1) {
      assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, heads[i]), null);
      assert.equal(existsSync(terminalReceipt(hqRoot)), false);
      assert.throws(() => recordHammerEarlyFailure('rebase-conflict', { env, headSha: heads[i], final: true }),
        RepairableConflictError, 'the same head does not consume another repair');
    }
  }
  assert.equal(readAmaAuditEntry(hqRoot, REPO, PR, MOVED).attempts.at(-1).reason, 'conflict-repair-exhausted');
  assert.equal(JSON.parse(readFileSync(terminalReceipt(hqRoot), 'utf8')).reason, 'conflict-repair-exhausted');
});

test('CLOSERGATES-01: a credential mint that timed out or failed to run is a retryable deferral', t => {
  const hqRoot = scratch(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|CREDENTIAL|^HAM_|^HQ_/.test(key)));
  Object.assign(env, { HAM_ROOT_DIR: hqRoot, HAM_HQ_ROOT: hqRoot, HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: LRQ,
    HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND: 'exit 3' });
  assert.throws(() => withHammerTokenSync(() => assert.fail('no call without a credential'), { env, hammerToken: true }),
    /refresh failed \(command error\)/);
  const attempt = readAmaAuditEntry(hqRoot, REPO, PR, HEAD).attempts.at(-1);
  assert.equal(attempt.reason, 'credential-refresh-unavailable');
  assert.equal(attempt.outcome, 'deferred');
});

test('CLOSERGATES-01: the shared read never reads past its budget', () => {
  const clock = fakeClock();
  const result = readClosureGateSync(() => { throw httpError('HTTP 503'); }, { clock, budgetMs: 10_000 });
  assert.equal(result.kind, 'exhausted');
  assert.deepEqual(clock.sleeps, [2_000, 5_000, 3_000]);
});
