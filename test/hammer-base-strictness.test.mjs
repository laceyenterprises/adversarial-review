import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
const resolver = source.match(/^ham_resolve_base_strictness\(\) \{\n[\s\S]*?^\}/m)?.[0];
const branch = { name: 'release/test', protected: false, commit: { sha: 'a'.repeat(40) } };

for (const [name, protection, metadata, expected] of [
  ['explicit non-strict', { strict: false }, null, 0],
  ['explicit strict', { strict: true }, branch, 1],
  ['string false is unreadable', { strict: 'false' }, branch, 1],
  ['missing strict is unreadable', {}, branch, 1],
  ['403 plus unprotected branch', null, branch, 0],
  ['404 plus unprotected branch', null, branch, 0],
  ['404 required checks disabled plus protected branch', null, { ...branch, protected: true }, 1],
  ['404 plus protected branch', null, { ...branch, protected: true }, 1],
  ['403 plus protected branch', null, { ...branch, protected: true }, 1],
  ['403 plus missing protected', null, { name: branch.name, commit: branch.commit }, 1],
  ['403 plus wrong branch', null, { ...branch, name: 'other' }, 1],
  ['403 plus string false', null, { ...branch, protected: 'false' }, 1],
  ['403 plus missing head', null, { ...branch, commit: {} }, 1],
  ['403 plus failed branch read', null, null, 1],
]) {
  test(`LAC-2097 strictness: ${name}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'base-strictness-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    assert.ok(resolver);
    const result = spawnSync('/bin/bash', ['-uc', `
${resolver.replaceAll('<<RUN_DIR>>', dir).replaceAll('<<REPO>>', 'fixture/repo')}
BASE_BRANCH=release/test
ham_gh() {
  if [[ "$2" == */required_status_checks ]]; then
    if [ "$PROTECTION" = null ]; then echo "$ERROR" >&2; return 1; fi
    printf '%s' "$PROTECTION"
  else
    [ "$2" = repos/fixture/repo/branches/release%2Ftest ] || return 90
    [ "$METADATA" != null ] || return 1
    printf '%s' "$METADATA"
  fi
}
ham_resolve_base_strictness
echo "$HAM_REQUIRES_UP_TO_DATE"
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env,
      PROTECTION: JSON.stringify(protection), METADATA: JSON.stringify(metadata),
      ERROR: name.startsWith('404 required') ? 'Required status checks not enabled (HTTP 404)' : name.startsWith('404') ? 'Branch not protected (HTTP 404)' : 'Resource not accessible by integration (HTTP 403)',
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), String(expected));
    if (!protection) assert.match(readFileSync(join(dir, 'required-status-checks.stderr'), 'utf8'), /HTTP 40[34]/);
  });
}

const needsRebase = source.match(/^ham_base_touches_pr_files\(\) \{\n[\s\S]*?^\}/m)?.[0];
for (const [state, mergeable, strict, expected] of [
  ['CLEAN', 'MERGEABLE', 0, 1],
  ['CLEAN', 'MERGEABLE', 1, 1],
  ['BEHIND', 'MERGEABLE', 0, 1],
  ['BEHIND', 'MERGEABLE', 1, 0],
  ['CLEAN', 'CONFLICTING', 0, 0],
  ['DIRTY', 'CONFLICTING', 1, 0],
  ['UNKNOWN', 'UNKNOWN', 1, 1],
]) {
  for (const checks of ['SUCCESS', 'PENDING']) test(`HAMRESUMEOWED-01: ${state}/${mergeable}, strict=${strict}, checks=${checks}`, () => {
    // The base advanced across the SAME path as this PR. GitHub's exact-head
    // conflict/up-to-date gate, rather than a local overlap guess, owns rewrite.
    const result = spawnSync('/bin/bash', ['-uc', `
${needsRebase}
BASE_BRANCH=main
HAM_REQUIRES_UP_TO_DATE=${strict}
POST_REMEDIATION_SHA=${'a'.repeat(40)}
ham_bounded_git_sync() { return 0; }
ham_is_full_sha() { return 0; }
git() {
  case "$1" in
    rev-parse) echo ${'b'.repeat(40)} ;;
    merge-base) echo ${'c'.repeat(40)} ;;
    diff) echo shared.txt ;;
    *) return 90 ;;
  esac
}
ham_base_touches_pr_files validated-head ${mergeable} ${state}
exit $?
`], { encoding: 'utf8', timeout: 5000, env: { ...process.env, CHECKS: checks } });
    assert.equal(result.status, expected, result.stdout + result.stderr);
  });
}

const mergeSource = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
const clickBoundary = mergeSource.slice(mergeSource.indexOf('  # Repeat the live GitHub conflict/strict-BEHIND policy'),
  mergeSource.indexOf("  # CI and merge-lease waits do not consume"));
const captureBase = source.match(/^ham_capture_current_base_sha\(\) \{\n[\s\S]*?^\}/m)?.[0];
for (const [state, strict] of [['CLEAN', 1], ['CLEAN', 0], ['BEHIND', 0]]) {
  for (const previous of ['', 'c'.repeat(40)]) {
    for (const fetchOk of [true, false]) test(`merge click captures base: ${state}, strict=${strict}, cached=${!!previous}, fetch=${fetchOk}`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'merge-base-capture-'));
      t.after(() => rmSync(dir, { force: true, recursive: true }));
      assert.ok(clickBoundary && captureBase);
      const result = spawnSync('/bin/bash', ['-uc', `
${needsRebase}
${captureBase.replaceAll('<<RUN_DIR>>', dir)}
BASE_BRANCH=main
HAM_REQUIRES_UP_TO_DATE=${strict}
HAM_CURRENT_BASE_SHA=${previous}
HAM_GATE_JSON=unused
HQ_LAUNCH_REQUEST_ID= AGENT_OS_WORKER_LRQ_ID= LAUNCH_REQUEST_ID=
jq() { if [[ "$2" == *mergeStateStatus* ]]; then echo ${state}; else echo MERGEABLE; fi; }
ham_fetch_base_with_retries() { return ${fetchOk ? 0 : 1}; }
ham_is_full_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
git() { [ "$1" = rev-parse ] && echo ${'b'.repeat(40)}; }
ham_append_terminal_audit() { echo "audit:$*"; }
ham_mark_merge_lease_retryable_abort() { echo "abort:$*"; }
ham_release_merge_lease() { echo released; }
click() {
${clickBoundary}
echo "attempt:$HAM_MERGE_ATTEMPT_BASE_SHA"
}
click
`], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, fetchOk ? 0 : 1, result.stdout + result.stderr);
      if (fetchOk) assert.equal(result.stdout.trim(), `attempt:${'b'.repeat(40)}`);
      else {
        assert.match(result.stdout, /audit:failed-without-merge github-gate-read-failed/);
        assert.match(result.stdout, /abort:github-gate-read-failed\nreleased/);
        assert.doesNotMatch(result.stdout, /attempt:/);
      }
    });
  }
}
