#!/usr/bin/env bash
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
ham_merge_phase() {
HAM_PHASE_OUTCOME=merge-error
HAM_CLOSING_KEYWORD_REWRITES='[]'
HAM_OWN_MERGE_EXECUTED=0
HAM_MERGE_EXIT=1
if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ] || [ -z "${HAM_MERGE_LEASE_ID:-}" ]; then
  echo "AMG-04 hard-blocker: no hammer merge without holding the merge lease" >&2
  return 1
fi

HAM_REMOTE_CI_WAIT_SECONDS="${HAM_REMOTE_CI_WAIT_SECONDS:-900}"
HAM_REMOTE_CI_POLL_SECONDS="${HAM_REMOTE_CI_POLL_SECONDS:-15}"
HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT="${HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT:-3}"
HAM_MERGE_RETRY_CAP="${HAM_MERGE_RETRY_CAP:-4}"
HAM_MERGE_BACKOFF_BASE_SECONDS="${HAM_MERGE_BACKOFF_BASE_SECONDS:-2}"
HAM_MERGE_TMP_PREFIX="${TMPDIR:-/tmp}/ham-<<PR_NUMBER>>-${HAM_MERGE_LEASE_ID:-no-lease}-$$"
HAM_MERGE_STDOUT=$(mktemp "${HAM_MERGE_TMP_PREFIX}.gh-pr-merge.stdout.XXXXXX") || { ham_release_merge_lease; return 1; }
HAM_MERGE_STDERR=$(mktemp "${HAM_MERGE_TMP_PREFIX}.gh-pr-merge.stderr.XXXXXX") || { ham_release_merge_lease; return 1; }
HAM_GATE_JSON=$(mktemp "${HAM_MERGE_TMP_PREFIX}.github-gate.XXXXXX") || { ham_release_merge_lease; return 1; }
HAM_POST_MERGE_JSON=$(mktemp "${HAM_MERGE_TMP_PREFIX}.post-merge.XXXXXX") || { ham_release_merge_lease; return 1; }
HAM_POST_MERGE_STDERR=$(mktemp "${HAM_MERGE_TMP_PREFIX}.post-merge.stderr.XXXXXX") || { ham_release_merge_lease; return 1; }
HAM_PRE_MERGE_ELIGIBLE=0
HAM_REMEDIATED_FINDINGS="${HAM_AUDIT_REMEDIATED_TOTAL:-} addressed (${HAM_AUDIT_REMEDIATED_BLOCKING:-} blocking, ${HAM_AUDIT_REMEDIATED_NON_BLOCKING:-} non-blocking)"

ham_append_terminal_audit() {
  ham_audit_outcome="$1"
  ham_audit_reason="$2"
  # Record confirmed execution or a refusal before other bookkeeping can fail.
  # The CLI filters refusal reasons to known decisions, excluding read failures.
  ham_receipt_outcome=
  if [ "$ham_audit_outcome" = succeeded ]; then
    if [ "$HAM_OWN_MERGE_EXECUTED" -eq 1 ]; then ham_receipt_outcome=merged; fi
  elif [ "$ham_audit_outcome" = failed-without-merge ] && [ "${HAM_MERGE_EXIT:-1}" -ne 0 ] \
    && [ "${HAM_MERGE_ACCEPTED:-0}" -ne 1 ] && [ "$HAM_OWN_MERGE_EXECUTED" -ne 1 ]; then
    ham_receipt_outcome=refused
  fi
  if [ -n "$ham_receipt_outcome" ]; then
    /usr/bin/perl -e 'alarm shift; exec @ARGV' 60 "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-action-receipt.mjs \
      <<HQ_ROOT>> <<REPO>> <<PR_NUMBER>> "$POST_REMEDIATION_SHA" "$ham_receipt_outcome" "$ham_audit_reason" "${HAM_MERGE_EXECUTED_AT:-}" \
      || echo "HAM warning: merge-action receipt unavailable; coverage remains pending" >&2
  fi
  if [ "$ham_audit_outcome" != succeeded ]; then
    HAM_PHASE_OUTCOME="$ham_audit_reason"
  fi
  ham_audit_attempt_json=$(mktemp "${HAM_MERGE_TMP_PREFIX}.terminal-audit-attempt.XXXXXX") || return 1
  jq -n \
    --arg outcome "$ham_audit_outcome" \
    --arg reason "$ham_audit_reason" \
    --arg reviewedHead "<<REVIEWED_SHA>>" \
    --arg validatedHead "$POST_REMEDIATION_SHA" \
    --arg mergeMethod "<<MERGE_METHOD>>" \
    --arg rebasedOntoBase "${HAM_REBASED_ONTO_BASE_SHA:-}" \
    --arg localCiStatus "${HAM_LOCAL_CI_STATUS:-unknown}" \
    --arg remoteCiStatus "${HAM_REMOTE_CI_STATUS:-unknown}" \
    --arg remediatedFindings "$HAM_REMEDIATED_FINDINGS" \
    --arg failingTestsFixed "${HAM_FAILING_TESTS_FIXED:-}" \
    --arg mergeCommit "${HAM_MERGE_COMMIT:-}" \
    --arg mergedAt "${HAM_MERGED_AT:-}" \
    --argjson closingKeywordRewrites "${HAM_CLOSING_KEYWORD_REWRITES:-[]}" \
    --argjson mergeAttempts "${HAM_MERGE_ATTEMPTS:-0}" \
    --argjson rebaseAttempts "${HAM_REBASE_ATTEMPTS:-0}" \
    --argjson preMergeEligible "${HAM_PRE_MERGE_ELIGIBLE:-0}" \
    --argjson eligibilityTrace "$([ -s "$HAM_VERDICT_FILE" ] && cat "$HAM_VERDICT_FILE" || printf '{}')" \
    --argjson githubGate "$([ -s "$HAM_GATE_JSON" ] && cat "$HAM_GATE_JSON" || printf '{}')" \
    '{
      preMergeEligible: ($preMergeEligible == 1),
      attemptPhase: "hammer-gh-pr-merge",
      headMatchEvidence: "ham_terminal_remediation_validated",
      reviewedHead: $reviewedHead,
      validatedHead: $validatedHead,
      mergeMethod: $mergeMethod,
      rebasedOntoBase: $rebasedOntoBase,
      localCiStatus: $localCiStatus,
      remoteCiStatus: $remoteCiStatus,
      remediatedFindings: $remediatedFindings,
      failingTestsFixed: $failingTestsFixed,
      rebaseAttempts: $rebaseAttempts,
      mergeAttempts: $mergeAttempts,
      closingKeywordRewrites: $closingKeywordRewrites,
      mergeCommitSha: $mergeCommit,
      mergedAt: $mergedAt,
      reason: $reason,
      resumeOwed: ($reason == "required-checks-pending"),
      resumeHead: (if $reason == "required-checks-pending" then $validatedHead else null end),
      eligibilityTrace: $eligibilityTrace,
      githubGate: $githubGate
    }' > "$ham_audit_attempt_json"
  "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --outcome "$ham_audit_outcome" \
    --closure-authority ham-terminal-remediation \
    --reviewer <<REVIEWER>> --risk-class <<RISK_CLASS>> \
    --attempt-json "$ham_audit_attempt_json" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ham_audit_append_exit=$?
  rm -f "$ham_audit_attempt_json"
  if [ "$ham_audit_append_exit" -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard; treating as no-op" >&2
    return 0
  fi
  return "$ham_audit_append_exit"
}

# ama-check exits zero for both eligible and ineligible verdicts. Require its
# exact-head decision and the successful in-lease audit publish independently.
if [ -z "${HAM_VERDICT_FILE:-}" ] || [ "${HAM_VERDICT_READY_FILE:-}" != "$HAM_VERDICT_FILE" ] || [ ! -f "$HAM_VERDICT_FILE" ] || [ ! -O "$HAM_VERDICT_FILE" ]; then
  echo 'HAM hard-blocker: current run has no owned predicate verdict' >&2
  HAM_VERDICT_FILE=""
  ham_append_terminal_audit failed-without-merge predicate-verdict-unavailable || true
  ham_release_merge_lease
  return 20
fi
if [ "${HAM_PUBLISHED_AUDIT_HEAD:-}" != "${POST_REMEDIATION_SHA:-}" ] || [ -z "${POST_REMEDIATION_SHA:-}" ]; then
  echo "HAM hard-blocker: audit was not published for the validated head" >&2
  ham_append_terminal_audit failed-without-merge audit-not-published || true
  ham_release_merge_lease
  return 20
fi
if ! jq -e --arg head "$POST_REMEDIATION_SHA" \
  '.eligible == true and .trace.headMatch.current == $head' "$HAM_VERDICT_FILE" >/dev/null 2>&1; then
  echo "HAM hard-blocker: predicate is not eligible for the validated head" >&2
  ham_append_terminal_audit failed-without-merge predicate-not-eligible || true
  ham_release_merge_lease
  return 20
fi
# The terminal predicate has already resolved whether branch protection is
# required for this exact head. Carry that decision into the live GitHub gate;
# omitting it makes an unprotected repository wait forever despite green checks.
HAM_BRANCH_PROTECTION_REQUIRED=$(jq -r '.trace.branchProtection.required | if type == "boolean" then tostring else empty end' "$HAM_VERDICT_FILE")
if [ "$HAM_BRANCH_PROTECTION_REQUIRED" != true ] && [ "$HAM_BRANCH_PROTECTION_REQUIRED" != false ]; then
  echo "HAM hard-blocker: predicate did not resolve branch protection requirement" >&2
  ham_release_merge_lease
  return 20
fi

ham_emit_git_merge_signal() {
  [ -n "${HAM_MERGE_COMMIT:-}" ] || return 1
  HAM_AGENT_OS_ROOT="${AGENT_OS_ROOT:-/Users/airlock/agent-os}"
  [ -d "$HAM_AGENT_OS_ROOT/modules/worker-pool/lib/python" ] || return 1
  [ -d "$HAM_AGENT_OS_ROOT/platform/session-ledger/src" ] || return 1
  HAM_SIGNAL_PYTHON_BIN="${HAM_PYTHON_BIN:-${HQ_PYTHON3:-${AGENT_OS_PY:-}}}"
  if [ -z "$HAM_SIGNAL_PYTHON_BIN" ] && [ -x /opt/homebrew/bin/python3 ]; then
    HAM_SIGNAL_PYTHON_BIN=/opt/homebrew/bin/python3
  fi
  if [ -z "$HAM_SIGNAL_PYTHON_BIN" ]; then
    HAM_SIGNAL_PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
  fi
  [ -n "$HAM_SIGNAL_PYTHON_BIN" ] || return 1
  HAM_SIGNAL_ATTEMPTS=0
  while [ "$HAM_SIGNAL_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
    HAM_SIGNAL_ATTEMPTS=$((HAM_SIGNAL_ATTEMPTS + 1))
    if PYTHONPATH="$HAM_AGENT_OS_ROOT/modules/worker-pool/lib/python:$HAM_AGENT_OS_ROOT/platform/session-ledger/src${PYTHONPATH:+:$PYTHONPATH}" \
      /usr/bin/perl -e 'alarm shift; exec @ARGV' 15 "$HAM_SIGNAL_PYTHON_BIN" - "<<HQ_ROOT>>" "<<PR_NUMBER>>" "$HAM_MERGE_COMMIT" "<<MERGE_METHOD>>" <<'PYEOF' >/dev/null 2>&1
import sys

from cwp_dispatch.git_signal import EVENT_MERGE_SIGNAL, emit_git_event_best_effort, workspace_context

hq_root, pr_number, merge_commit_sha, mode = sys.argv[1:]
ctx = workspace_context()
emit_git_event_best_effort(
    hq_root=hq_root,
    event_type=EVENT_MERGE_SIGNAL,
    worker_run_id=ctx.worker_run_id,
    launch_request_id=ctx.launch_request_id,
    ticket_ref=ctx.ticket_ref,
    pr_number=int(pr_number),
    merge_commit_sha=merge_commit_sha,
    merged_by=ctx.worker_class or "hammer",
    mode=mode,
)
PYEOF
    then
      return 0
    fi
    if [ "$HAM_SIGNAL_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
      return 1
    fi
    HAM_SIGNAL_BACKOFF_MULTIPLIER=$((1 << (HAM_SIGNAL_ATTEMPTS - 1)))
    HAM_SIGNAL_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
    HAM_SIGNAL_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_SIGNAL_BACKOFF_MULTIPLIER + HAM_SIGNAL_JITTER))
    echo "HAM merge signal transient failure; retrying ${HAM_SIGNAL_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_SIGNAL_SLEEP}s" >&2
    sleep "$HAM_SIGNAL_SLEEP"
  done
  return 1
}

ham_mark_ama_closer_lease_succeeded() {
  TARGET_REMEDIATION_SHA="<<TARGET_REMEDIATION_SHA>>" POST_REMEDIATION_SHA="$POST_REMEDIATION_SHA" "$HAM_NODE_BIN" --input-type=module <<'NODE'
import {
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '<<ROOT_DIR>>/src/ama/closer-lease.mjs';

const rootDir = '<<ROOT_DIR>>';
const identity = {
  repo: '<<REPO>>',
  prNumber: Number('<<PR_NUMBER>>'),
  headSha: process.env.POST_REMEDIATION_SHA || process.env.TARGET_REMEDIATION_SHA,
};
let existing = readAmaCloserLease(rootDir, identity);
if (existing && identity.headSha !== process.env.TARGET_REMEDIATION_SHA) {
  const sourceHead = process.env.TARGET_REMEDIATION_SHA;
  const supersedesSource = existing.rekeyedFromHeadSha === sourceHead
    || (Array.isArray(existing.supersededHeads) && existing.supersededHeads.includes(sourceHead));
  if (!supersedesSource) existing = null;
}
if (!existing && identity.headSha !== process.env.TARGET_REMEDIATION_SHA) {
  identity.headSha = process.env.TARGET_REMEDIATION_SHA;
  existing = readAmaCloserLease(rootDir, identity);
}
if (existing?.status === AMA_CLOSER_LEASE_STATUS.TERMINAL) {
  if (existing.terminalOutcome === 'succeeded') process.exit(0);
  throw new Error(
    `AMA closer lease is already terminal with outcome ${existing.terminalOutcome}`,
  );
}
updateAmaCloserLease({
  rootDir,
  ...identity,
  status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
  terminalOutcome: 'succeeded',
});
NODE
}

ham_fire_watcher_merge_wake() {
  if "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/watcher-wake.mjs" \
    --root-dir "<<ROOT_DIR>>" \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head-sha "$POST_REMEDIATION_SHA" \
    --reason hammer-pr-eligible \
    > /tmp/ham-<<PR_NUMBER>>-watcher-wake.json; then
    echo "HAM watcher wake fired for eligible head ${POST_REMEDIATION_SHA}" >&2
    return 0
  fi
  HAM_WATCHER_WAKE_EXIT=$?
  echo "HAM watcher wake hook failed (exit ${HAM_WATCHER_WAKE_EXIT}); continuing with held merge lease" >&2
  cat /tmp/ham-<<PR_NUMBER>>-watcher-wake.json >&2 || true
  return 0
}

ham_refresh_github_gate_once() {
  POST_REMEDIATION_SHA="$POST_REMEDIATION_SHA" \
  HAM_REQUIRES_UP_TO_DATE="${HAM_REQUIRES_UP_TO_DATE:-1}" \
  HAM_BRANCH_PROTECTION_REQUIRED="$HAM_BRANCH_PROTECTION_REQUIRED" \
  "$HAM_NODE_BIN" --input-type=module <<'NODE' > "$HAM_GATE_JSON"
import { fetchPullRequestRollup } from '<<ROOT_DIR>>/src/github-api.mjs';
import { fetchPrimaryChange } from '<<ROOT_DIR>>/src/ama/primary-change.mjs';
import { loadEffectiveMergeAuthorityConfig } from '<<ROOT_DIR>>/src/ama/effective-policy.mjs';
import { execGhWithRetry } from '<<ROOT_DIR>>/src/gh-cli.mjs';
import { evaluateMergeEligibility } from '<<ROOT_DIR>>/src/ama/merge-eligibility.mjs';
import { classifyCheckRollup, latestCheckRollupItems } from '<<ROOT_DIR>>/src/checks-summary.mjs';

const repo = '<<REPO>>';
const prNumber = Number('<<PR_NUMBER>>');
const expectedHead = process.env.POST_REMEDIATION_SHA;
const rollup = await fetchPullRequestRollup(repo, prNumber);
const checks = Array.isArray(rollup.checks)
  ? rollup.checks
  : Array.isArray(rollup.statusCheckRollup)
    ? rollup.statusCheckRollup
    : [];
// Keep diagnostics and the shell's red/pending decision on the same classifier
// used by evaluateMergeEligibility's required-checks gate (CIDEDUPE-01).
const checksConclusion = classifyCheckRollup(checks);
const badChecks = latestCheckRollupItems(checks)
  .filter((check) => classifyCheckRollup([check]) !== 'SUCCESS');
const headMatches = String(rollup.headSha || rollup.headRefOid || '') === expectedHead;
const mergeable = String(rollup.mergeable || '').toUpperCase() === 'MERGEABLE';
const notBehind = String(rollup.mergeStateStatus || '').toUpperCase() !== 'BEHIND';
const state = String(rollup.state || '').toUpperCase();
const open = state === 'OPEN';
// MSM-02: the GitHub-side gate (required checks green + mergeable + head-match)
// is the shared merge-eligibility predicate. Verdict and lease are gated upstream
// for this call site — ama-check emits the verdict into /tmp verdict.json and the
// shell hard-checks HAM_MERGE_LEASE_HELD before reaching here — so they are passed
// as already-satisfied; `ok` stays exactly the pre-MSM-02 GitHub gate.
// A BEHIND head only blocks when the base branch requires the PR to be up to
// date (required_status_checks.strict). When the shell resolved no strict rule
// (HAM_REQUIRES_UP_TO_DATE=0), pass requiresUpToDateBranch:false so a
// BEHIND-but-MERGEABLE validated head is eligible instead of forcing a
// churn-inducing rebase. Fail closed: any value other than '0' keeps the block.
const requiresUpToDateBranch = process.env.HAM_REQUIRES_UP_TO_DATE !== '0';
// Resolve the same effective policy as bin/ama-check.mjs, including its strict default.
const cfg = loadEffectiveMergeAuthorityConfig({ rootDir: '<<ROOT_DIR>>' });
const primaryChange = await fetchPrimaryChange({ repo, prNumber, headSha: expectedHead, rootDir: '<<ROOT_DIR>>',
  get: async (path) => {
    const { stdout } = await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 });
    return JSON.parse(stdout);
  },
});
const eligibility = evaluateMergeEligibility({
  primaryChange,
  requirePrimaryChange: true,
  strictNonBlockingRemediation: cfg?.strictNonBlockingRemediation !== false,
  verdict: 'settled-success',
  leaseHeld: true,
  requiredChecks: checks,
  branchProtectionRequired: process.env.HAM_BRANCH_PROTECTION_REQUIRED === 'true',
  mergeable: rollup.mergeable,
  mergeStateStatus: rollup.mergeStateStatus,
  requiresUpToDateBranch,
  prState: state,
  labels: rollup.labels,
  candidateHead: rollup.headSha || rollup.headRefOid || '',
  validatedHead: expectedHead,
});
console.log(JSON.stringify({
  ok: eligibility.eligible,
  reasons: eligibility.reasons,
  state,
  open,
  headMatches,
  expectedHead,
  liveHead: rollup.headSha || rollup.headRefOid || null,
  mergeable: rollup.mergeable || null,
  mergeStateStatus: rollup.mergeStateStatus || null,
  checksCount: checks.length,
  checksConclusion,
  badChecks,
}, null, 2));
NODE
}

ham_refresh_github_gate() {
  HAM_GATE_ATTEMPTS=0
  while [ "$HAM_GATE_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
    HAM_GATE_ATTEMPTS=$((HAM_GATE_ATTEMPTS + 1))
    if ham_refresh_github_gate_once; then
      return 0
    fi
    if [ "$HAM_GATE_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
      return 1
    fi
    HAM_GATE_BACKOFF_MULTIPLIER=$((1 << (HAM_GATE_ATTEMPTS - 1)))
    HAM_GATE_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
    HAM_GATE_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_GATE_BACKOFF_MULTIPLIER + HAM_GATE_JITTER))
    echo "HAM GitHub gate read transient failure; retrying ${HAM_GATE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_GATE_SLEEP}s" >&2
    sleep "$HAM_GATE_SLEEP"
  done
  return 1
}

ham_required_gate_ok() {
  jq -e '.ok == true' "$HAM_GATE_JSON" >/dev/null
}

ham_required_gate_red() {
  jq -e '.checksConclusion != null and .checksConclusion != "SUCCESS" and .checksConclusion != "PENDING"' "$HAM_GATE_JSON" >/dev/null
}

ham_required_gate_pending_only() {
  jq -e '.checksConclusion == "PENDING" and
    (.reasons | type == "array" and length > 0 and all(.[]; . == "ci-not-green"))' "$HAM_GATE_JSON" >/dev/null
}

ham_live_head_moved() {
  jq -e '.headMatches == false' "$HAM_GATE_JSON" >/dev/null
}

ham_already_merged_validated_head() {
  jq -e '.state == "MERGED" and .liveHead == .expectedHead' "$HAM_GATE_JSON" >/dev/null
}

ham_merge_error_retryable() {
  grep -Eiq 'connection reset|ECONNRESET|TLS handshake timeout|timeout|timed out|ETIMEDOUT|DNS|ENOTFOUND|EAI_AGAIN|socket|HTTP 5[0-9][0-9]|502|503|504|rate limit|secondary rate limit|Retry-After|temporar(y|ily)|try again|service unavailable|gateway' "$1"
}

ham_merge_error_already_merged() {
  grep -Eiq 'already merged' "$1"
}

ham_merge_error_permanent() {
  grep -Eiq 'match-head-commit|head.*(mismatch|changed|does not match)|not authorized|permission|authentication|forbidden|HTTP 401|HTTP 403|branch protection|ruleset|required check|status checks? (not|have not)|not mergeable|merge conflict|closed|pull request.*not open|draft' "$1"
}

# The hammer does NOT run a local test battery or the PPH pre-push CI mirror as a
# merge gate. GitHub required checks are the SOLE CI authority: the poll loop
# below waits (bounded) for the required gate to go green on this exact head and
# never merges a red or not-yet-green gate. Set the audit status once so the
# localCiStatus audit-JSON sites populate an honest value.
HAM_LOCAL_CI_STATUS=local-battery-skipped-github-required-gate-authoritative

HAM_REMOTE_CI_STATUS=waiting
HAM_REMOTE_CI_DEADLINE=$(( $(date +%s) + HAM_REMOTE_CI_WAIT_SECONDS ))
HAM_REMOTE_CI_GATE_READ_FAILURES=0
HAM_ALREADY_MERGED_VALIDATED_HEAD=0
while :; do
  if ! ham_refresh_github_gate; then
    HAM_REMOTE_CI_GATE_READ_FAILURES=$((HAM_REMOTE_CI_GATE_READ_FAILURES + 1))
    HAM_REMOTE_CI_STATUS=gate-read-transient-failure
    if [ "$HAM_REMOTE_CI_GATE_READ_FAILURES" -ge "$HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT" ] || [ "$(date +%s)" -ge "$HAM_REMOTE_CI_DEADLINE" ]; then
      echo "HAM hard-blocker: unable to read GitHub gate through src/github-api.mjs adapter after ${HAM_REMOTE_CI_GATE_READ_FAILURES} consecutive failures" >&2
      ham_append_terminal_audit failed-without-merge github-gate-read-failed || true
      ham_mark_merge_lease_retryable_abort github-gate-read-failed
      ham_release_merge_lease
      return 1
    fi
    echo "HAM remote CI: transient GitHub gate read failure ${HAM_REMOTE_CI_GATE_READ_FAILURES}/${HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT}; retrying within remote CI wait window" >&2
    sleep "$HAM_REMOTE_CI_POLL_SECONDS"
    continue
  fi
  HAM_REMOTE_CI_GATE_READ_FAILURES=0
  if ham_already_merged_validated_head; then
    echo "HAM preflight: PR is already merged at validated head; proceeding to post-merge validation" >&2
    HAM_REMOTE_CI_STATUS=already-merged-at-validated-head
    HAM_ALREADY_MERGED_VALIDATED_HEAD=1
    HAM_PRE_MERGE_ELIGIBLE=1
    break
  fi
  if ham_live_head_moved; then
    echo "HAM race: live PR head moved off validated head; releasing lease without merge or re-dispatch" >&2
    HAM_REMOTE_CI_STATUS=live-head-moved
    ham_append_terminal_audit superseded live-head-moved-before-merge || true
    ham_release_merge_lease
    return 20
  fi
  HAM_PRIMARY_REFUSAL=$(jq -r '[.reasons[]? | select(. == "primary-change-reverted" or . == "primary-change-unknown")][0] // empty' "$HAM_GATE_JSON")
  if [ -n "$HAM_PRIMARY_REFUSAL" ]; then
    HAM_REMOTE_CI_STATUS="$HAM_PRIMARY_REFUSAL"
    ham_append_terminal_audit failed-without-merge "$HAM_PRIMARY_REFUSAL" || true
    ham_release_merge_lease
    return 20
  fi
  if ham_required_gate_ok; then
    HAM_REMOTE_CI_STATUS=remote-ci-green
    break
  fi
  if ham_required_gate_red; then
    echo "HAM hard-blocker: GitHub required gate is red for validated head" >&2
    cat "$HAM_GATE_JSON" >&2
    HAM_REMOTE_CI_STATUS=remote-ci-red
    ham_append_terminal_audit failed-without-merge github-gate-red || true
    ham_release_merge_lease
    return 20
  fi
  if [ "$(date +%s)" -ge "$HAM_REMOTE_CI_DEADLINE" ]; then
    echo "HAM hard-blocker: timed out waiting for GitHub required gate to become green for validated head" >&2
    cat "$HAM_GATE_JSON" >&2
    HAM_REMOTE_CI_STATUS=remote-ci-timeout
    if ham_required_gate_pending_only; then
      ham_append_terminal_audit deferred required-checks-pending || {
        ham_mark_merge_lease_retryable_abort required-checks-pending
        ham_release_merge_lease
        return 20
      }
      echo "hammer-ci-pending-resume-owed head=$POST_REMEDIATION_SHA" >&2
      ham_mark_merge_lease_retryable_abort required-checks-pending
    else
      ham_append_terminal_audit failed-without-merge github-gate-timeout || true
    fi
    ham_release_merge_lease
    return 20
  fi
  # Remote CI does not own the serialized merge lane. Reacquisition below
  # repeats the live exact-head gate before any merge attempt. Keep this
  # attempt charged: a later red CI outcome must retain the gate-cap charge.
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ]; then
    ham_release_merge_lease || return 1
  fi
  echo "HAM remote CI: waiting for required checks on ${POST_REMEDIATION_SHA}" >&2
  sleep "$HAM_REMOTE_CI_POLL_SECONDS"
done
if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] && [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
  if ham_acquire_merge_lease; then
    :
  else
    HAM_REACQUIRE_EXIT=$?
    if [ "${HAM_LEASE_PROBE_TRANSIENT:-0}" -eq 1 ]; then
      ham_append_terminal_audit deferred merge-lease-timeout || return 1
      HAM_PHASE_OUTCOME=parked:merge-lease-timeout
      return 20
    fi
    return "$HAM_REACQUIRE_EXIT"
  fi
  # Only base changes not already contained in the exact CI-validated head can
  # require another rebase; the parallel-phase validation base may be older.
  if ham_base_touches_pr_files validated-head; then
    ham_append_terminal_audit failed-without-merge base-changed-file-overlap || true
    ham_release_merge_lease
    return 20
  fi
fi
HAM_PRE_MERGE_ELIGIBLE=1

HAM_MERGE_ATTEMPTS=0
HAM_MERGE_EXIT=1
if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -eq 1 ]; then
  HAM_MERGE_EXIT=0
else
  HAM_PRE_MERGE_ATTEMPT_FILE=$(mktemp "${HAM_MERGE_TMP_PREFIX}.pre-merge-attempt.XXXXXX") || { ham_release_merge_lease; return 1; }
  jq -n \
    --arg reviewedHead "<<REVIEWED_SHA>>" \
    --arg validatedHead "$POST_REMEDIATION_SHA" \
    --arg mergeMethod "<<MERGE_METHOD>>" \
    --arg rebasedOntoBase "${HAM_REBASED_ONTO_BASE_SHA:-}" \
    --arg localCiStatus "${HAM_LOCAL_CI_STATUS:-unknown}" \
    --arg remoteCiStatus "${HAM_REMOTE_CI_STATUS:-unknown}" \
    --arg remediatedFindings "$HAM_REMEDIATED_FINDINGS" \
    --arg failingTestsFixed "${HAM_FAILING_TESTS_FIXED:-}" \
    --argjson rebaseAttempts "${HAM_REBASE_ATTEMPTS:-0}" \
    --argjson eligibilityTrace "$(cat "$HAM_VERDICT_FILE")" \
    --argjson githubGate "$(cat "$HAM_GATE_JSON")" \
    '{
      preMergeEligible: true,
      attemptPhase: "before-hammer-gh-pr-merge",
      headMatchEvidence: "ham_terminal_remediation_validated",
      reviewedHead: $reviewedHead,
      validatedHead: $validatedHead,
      mergeMethod: $mergeMethod,
      rebasedOntoBase: $rebasedOntoBase,
      localCiStatus: $localCiStatus,
      remoteCiStatus: $remoteCiStatus,
      remediatedFindings: $remediatedFindings,
      failingTestsFixed: $failingTestsFixed,
      rebaseAttempts: $rebaseAttempts,
      eligibilityTrace: $eligibilityTrace,
      githubGate: $githubGate
    }' > "$HAM_PRE_MERGE_ATTEMPT_FILE"
  "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --outcome in_progress \
    --closure-authority ham-terminal-remediation \
    --reviewer <<REVIEWER>> --risk-class <<RISK_CLASS>> \
    --attempt-json "$HAM_PRE_MERGE_ATTEMPT_FILE" || { ham_release_merge_lease; return 1; }
  rm -f "$HAM_PRE_MERGE_ATTEMPT_FILE"
  ham_fire_watcher_merge_wake
fi
while [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] && [ "$HAM_MERGE_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
  HAM_MERGE_ATTEMPTS=$((HAM_MERGE_ATTEMPTS + 1))
  if ! ham_refresh_github_gate; then
    echo "HAM merge retry ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP}: gate read failed after bounded retries" >&2
    ham_append_terminal_audit failed-without-merge github-gate-read-failed || true
    ham_mark_merge_lease_retryable_abort github-gate-read-failed
    ham_release_merge_lease
    return 1
  fi
  if ham_already_merged_validated_head; then
    echo "HAM merge retry ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP}: PR is already merged at validated head; proceeding to post-merge validation" >&2
    HAM_MERGE_EXIT=0
    break
  fi
  if ham_live_head_moved; then
    echo "HAM race: live PR head moved off validated head before merge retry; releasing lease without merge or re-dispatch" >&2
    ham_append_terminal_audit superseded live-head-moved-before-merge || true
    ham_release_merge_lease
    return 20
  fi
  if ! ham_required_gate_ok; then
    echo "HAM hard-blocker: GitHub required gate stopped being green before merge" >&2
    cat "$HAM_GATE_JSON" >&2
    ham_append_terminal_audit failed-without-merge github-gate-not-green || true
    ham_release_merge_lease
    return 20
  fi

  HAM_MERGE_CAPABILITY_ENFORCEMENT="${AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_MERGE_CAPABILITY_ENFORCEMENT:-${MERGE_CAPABILITY_ENFORCEMENT:-observe}}"
  ham_normalize_merge_token_class() {
    printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]_' '[:lower:]-'
  }
  ham_merge_capability_known_provider_class() {
    case "$1" in
      builder|builder-class|codex|claude-code|gemini|clio-agent|codex-agent|claude-agent|gemini-agent|github-app-codex-agent|github-app-claude-agent|github-app-gemini-agent|lacey-codex-agent|lacey-claude-agent|lacey-gemini-agent|merge-agent|hammer|hammer-claude|the-hammer|github-app-merge-agent|lacey-merge-agent|the-hammer-lacey)
        return 0
        ;;
    esac
    return 1
  }
  ham_first_nonempty_merge_token_class() {
    for ham_candidate_value in "$@"; do
      ham_candidate_class="$(ham_normalize_merge_token_class "$ham_candidate_value")"
      if [ -n "$ham_candidate_class" ]; then
        printf '%s\n' "$ham_candidate_class"
        return 0
      fi
    done
    return 1
  }
  ham_first_known_merge_provider_class() {
    for ham_candidate_value in "$@"; do
      ham_candidate_class="$(ham_normalize_merge_token_class "$ham_candidate_value")"
      if [ -n "$ham_candidate_class" ] && ham_merge_capability_known_provider_class "$ham_candidate_class"; then
        printf '%s\n' "$ham_candidate_class"
        return 0
      fi
    done
    return 1
  }
  HAM_MERGE_TOKEN_CLASS="$(ham_first_nonempty_merge_token_class \
    "${AGENT_OS_GITHUB_TOKEN_CLASS:-}" \
    "${AGENT_OS_MERGE_TOKEN_CLASS:-}" \
    "${GITHUB_TOKEN_CLASS:-}" \
    "${GH_TOKEN_CLASS:-}" \
    "${HQ_GITHUB_TOKEN_CLASS:-}" \
    "${OAUTH_BROKER_TOKEN_CLASS:-}" \
    || true)"
  if [ -z "$HAM_MERGE_TOKEN_CLASS" ]; then
    HAM_MERGE_TOKEN_CLASS="$(ham_first_known_merge_provider_class \
      "${OAUTH_BROKER_PROVIDER:-}" \
      "${OAUTH_BROKER_GITHUB_APP_PROVIDER:-}" \
      "${OAUTH_BROKER_MERGE_AGENT_PROVIDER:-}" \
      "${OAUTH_BROKER_HAMMER_PROVIDER:-}" \
      "${OAUTH_BROKER_CODEX_PROVIDER:-}" \
      "${OAUTH_BROKER_CLAUDE_PROVIDER:-}" \
      "${OAUTH_BROKER_GEMINI_PROVIDER:-}" \
      "${OAUTH_BROKER_CODEX_REVIEWER_PROVIDER:-}" \
      "${OAUTH_BROKER_CLAUDE_REVIEWER_PROVIDER:-}" \
      "${OAUTH_BROKER_GEMINI_REVIEWER_PROVIDER:-}" \
      || true)"
  fi
  case "$HAM_MERGE_TOKEN_CLASS" in
    builder|builder-class|codex|claude-code|gemini|clio-agent|codex-agent|claude-agent|gemini-agent|github-app-codex-agent|github-app-claude-agent|github-app-gemini-agent|lacey-codex-agent|lacey-claude-agent|lacey-gemini-agent)
      if [ "$HAM_MERGE_CAPABILITY_ENFORCEMENT" = "enforce" ]; then
        printf '{"schemaVersion":1,"event":"merge_capability_enforcement","mode":"enforce","action":"deny","surface":"hammer","repo":"<<REPO>>","prNumber":<<PR_NUMBER>>,"headSha":"%s","tokenClass":"%s","reason":"builder-token-merge-refused"}\n' "$POST_REMEDIATION_SHA" "$HAM_MERGE_TOKEN_CLASS" >&2
        ham_append_terminal_audit failed-without-merge builder-token-merge-refused || true
        ham_release_merge_lease
        return 20
      fi
      printf '{"schemaVersion":1,"event":"merge_capability_enforcement","mode":"observe","action":"would-deny","surface":"hammer","repo":"<<REPO>>","prNumber":<<PR_NUMBER>>,"headSha":"%s","tokenClass":"%s","reason":"builder-token-merge-refused"}\n' "$POST_REMEDIATION_SHA" "$HAM_MERGE_TOKEN_CLASS" >&2
      ;;
  esac

  ham_read_protective_predecessor_value() {
    local ham_pph_label="$1"
    local ham_pph_out_var="$2"
    shift 2
    local ham_pph_attempts=0
    local ham_pph_stderr="/tmp/ham-<<PR_NUMBER>>-${ham_pph_label}.stderr"
    local ham_pph_output=""
    while [ "$ham_pph_attempts" -lt "$HAM_MERGE_RETRY_CAP" ]; do
      ham_pph_attempts=$((ham_pph_attempts + 1))
      : > "$ham_pph_stderr"
      if ham_pph_output=$("$@" 2> "$ham_pph_stderr"); then
        printf -v "$ham_pph_out_var" '%s' "$ham_pph_output"
        rm -f "$ham_pph_stderr"
        return 0
      fi
      if ! ham_merge_error_retryable "$ham_pph_stderr"; then
        cat "$ham_pph_stderr" >&2 || true
        rm -f "$ham_pph_stderr"
        return 2
      fi
      if [ "$ham_pph_attempts" -ge "$HAM_MERGE_RETRY_CAP" ]; then
        cat "$ham_pph_stderr" >&2 || true
        rm -f "$ham_pph_stderr"
        return 1
      fi
      HAM_PPH_BACKOFF_MULTIPLIER=$((1 << (ham_pph_attempts - 1)))
      HAM_PPH_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
      HAM_PPH_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_PPH_BACKOFF_MULTIPLIER + HAM_PPH_JITTER))
      echo "HAM protective predecessor ${ham_pph_label} transient failure; retrying ${ham_pph_attempts}/${HAM_MERGE_RETRY_CAP} after ${HAM_PPH_SLEEP}s" >&2
      sleep "$HAM_PPH_SLEEP"
    done
    return 1
  }

  HAM_PROTECTIVE_PREDECESSOR_BODY=""
  ham_read_protective_predecessor_value body HAM_PROTECTIVE_PREDECESSOR_BODY \
    gh pr view <<PR_URL>> --json body --jq '.body // ""'
  HAM_PROTECTIVE_PREDECESSOR_READ_STATUS=$?
  if [ "$HAM_PROTECTIVE_PREDECESSOR_READ_STATUS" -ne 0 ]; then
    echo "HAM hard-blocker: protective predecessor body read failed; refusing merge" >&2
    if [ "$HAM_PROTECTIVE_PREDECESSOR_READ_STATUS" -eq 1 ]; then
      ham_append_terminal_audit failed-without-merge protective-predecessor-state-unreadable || true
      ham_mark_merge_lease_retryable_abort protective-predecessor-read-failed
      ham_release_merge_lease
      return 1
    fi
    ham_append_terminal_audit failed-without-merge protective-predecessor-state-unreadable || true
    ham_release_merge_lease
    return 20
  fi
  HAM_PROTECTIVE_PREDECESSORS=$(printf '%s\n' "$HAM_PROTECTIVE_PREDECESSOR_BODY" | awk '/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:/ {print $0}')
  if [ -n "$HAM_PROTECTIVE_PREDECESSORS" ]; then
    while IFS= read -r predecessor_line; do
      HAM_PROTECTOR_PR=$(printf "%s" "$predecessor_line" | sed -nE 's/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:[[:space:]]*#?([1-9][0-9]*)[[:space:]]*$/\1/p')
      if [ -z "$HAM_PROTECTOR_PR" ]; then
        echo "HAM hard-blocker: malformed protective predecessor trailer; refusing merge" >&2
        ham_append_terminal_audit failed-without-merge protective-predecessor-malformed-trailer || true
        ham_release_merge_lease
        return 20
      fi
      if [ "$HAM_PROTECTOR_PR" = "<<PR_NUMBER>>" ]; then
        echo "protective predecessor declaration points at this PR; ignoring malformed self-reference" >&2
        continue
      fi
      HAM_PROTECTOR_STATE=""
      ham_read_protective_predecessor_value "state-${HAM_PROTECTOR_PR}" HAM_PROTECTOR_STATE \
        gh pr view "$HAM_PROTECTOR_PR" --repo "<<REPO>>" --json state --jq '.state // ""'
      HAM_PROTECTOR_STATE_READ_STATUS=$?
      if [ "$HAM_PROTECTOR_STATE_READ_STATUS" -ne 0 ]; then
        echo "HAM hard-blocker: protective predecessor state unreadable for PR #$HAM_PROTECTOR_PR; refusing merge" >&2
        if [ "$HAM_PROTECTOR_STATE_READ_STATUS" -eq 1 ]; then
          ham_append_terminal_audit failed-without-merge protective-predecessor-state-unreadable || true
          ham_mark_merge_lease_retryable_abort protective-predecessor-read-failed
          ham_release_merge_lease
          return 1
        fi
        ham_append_terminal_audit failed-without-merge protective-predecessor-state-unreadable || true
        ham_release_merge_lease
        return 20
      fi
      if [ -z "$HAM_PROTECTOR_STATE" ]; then
        echo "HAM hard-blocker: protective predecessor state empty for PR #$HAM_PROTECTOR_PR; refusing merge" >&2
        ham_append_terminal_audit failed-without-merge protective-predecessor-state-unreadable || true
        ham_mark_merge_lease_retryable_abort protective-predecessor-read-failed
        ham_release_merge_lease
        return 1
      fi
      if [ "$HAM_PROTECTOR_STATE" = "OPEN" ]; then
        echo "HAM hard-blocker: protective predecessor PR #$HAM_PROTECTOR_PR is still open; refusing merge" >&2
        ham_append_terminal_audit failed-without-merge protective-predecessor-open || true
        ham_release_merge_lease
        return 20
      fi
    done <<EOF_HAM_PROTECTIVE_PREDECESSORS
$HAM_PROTECTIVE_PREDECESSORS
EOF_HAM_PROTECTIVE_PREDECESSORS
  fi

  ham_commit_message_abort() {
    ham_append_terminal_audit failed-without-merge "$1" || true
    ham_mark_merge_lease_retryable_abort "$1"
    ham_release_merge_lease
  }
  HAM_PR_TITLE=""
  ham_read_protective_predecessor_value title HAM_PR_TITLE \
    gh pr view <<PR_URL>> --json title --jq '.title // ""'
  HAM_TITLE_READ_STATUS=$?
  if [ "$HAM_TITLE_READ_STATUS" -ne 0 ]; then
    if [ "$HAM_TITLE_READ_STATUS" -eq 1 ]; then
      ham_commit_message_abort commit-title-read-failed
      return 1
    fi
    ham_append_terminal_audit failed-without-merge commit-title-read-failed || true
    ham_release_merge_lease
    return 20
  fi
  if [ -z "${HAM_PR_TITLE//[[:space:]]/}" ]; then
    ham_commit_message_abort merge-title-missing
    return 1
  fi
  export HAM_PR_TITLE
  HAM_COMMIT_BODY_JSON=$(printf '%s' "$HAM_PROTECTIVE_PREDECESSOR_BODY" |
    "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-commit-body.mjs <<REPO>> <<PR_NUMBER>>) || {
    HAM_SANITIZER_STATUS=$?
    if [ "$HAM_SANITIZER_STATUS" -eq 64 ] || [ "$HAM_SANITIZER_STATUS" -eq 78 ]; then
      ham_append_terminal_audit failed-without-merge commit-body-sanitization-failed || true
      ham_release_merge_lease
      return 20
    fi
    ham_commit_message_abort commit-body-sanitization-failed
    return 1
  }
  HAM_COMMIT_BODY=$(printf '%s' "$HAM_COMMIT_BODY_JSON" | jq -er '.text') || {
    ham_commit_message_abort commit-body-decode-failed
    return 1
  }
  HAM_COMMIT_SUBJECT=$(printf '%s' "$HAM_COMMIT_BODY_JSON" | jq -er '.subject') || {
    ham_commit_message_abort commit-subject-decode-failed
    return 1
  }
  HAM_CLOSING_KEYWORD_REWRITES=$(printf '%s' "$HAM_COMMIT_BODY_JSON" | jq -ce '.rewrites | select(type == "array")') || {
    ham_commit_message_abort commit-rewrites-decode-failed
    return 1
  }

  HAM_MERGE_EXECUTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh pr merge <<PR_URL>> \
    --<<MERGE_METHOD>> \
    --match-head-commit "$POST_REMEDIATION_SHA" \
    --subject "$HAM_COMMIT_SUBJECT" \
    --body "$HAM_COMMIT_BODY" \
    > "$HAM_MERGE_STDOUT" \
    2> "$HAM_MERGE_STDERR"
  HAM_MERGE_EXIT=$?
  if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
    if ! ham_merge_error_already_merged "$HAM_MERGE_STDOUT" && ! ham_merge_error_already_merged "$HAM_MERGE_STDERR"; then
      HAM_OWN_MERGE_EXECUTED=1
    fi
    break
  fi
  if ham_merge_error_already_merged "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM merge response says PR is already merged; proceeding to post-merge validation" >&2
    HAM_MERGE_EXIT=0
    break
  fi
  if ham_merge_error_permanent "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: permanent gh pr merge rejection; not retrying" >&2
    ham_append_terminal_audit failed-without-merge permanent-merge-rejection || true
    ham_release_merge_lease
    return 20
  fi
  if ! ham_merge_error_retryable "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: unclassified gh pr merge failure; fail closed without retry" >&2
    ham_append_terminal_audit failed-without-merge unclassified-merge-failure || true
    ham_release_merge_lease
    return 1
  fi
  if [ "$HAM_MERGE_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: retryable gh pr merge failures exhausted bounded budget" >&2
    ham_append_terminal_audit failed-without-merge merge-retry-budget-exhausted || true
    ham_mark_merge_lease_retryable_abort merge-retry-budget-exhausted
    ham_release_merge_lease
    return 1
  fi
  HAM_MERGE_BACKOFF_MULTIPLIER=$((1 << (HAM_MERGE_ATTEMPTS - 1)))
  HAM_MERGE_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
  HAM_MERGE_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_MERGE_BACKOFF_MULTIPLIER + HAM_MERGE_JITTER))
  echo "HAM merge transient failure; retrying ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_MERGE_SLEEP}s" >&2
  sleep "$HAM_MERGE_SLEEP"
done

sleep 2
HAM_POST_VIEW_ATTEMPTS=0
HAM_POST_VIEW_EXIT=1
while [ "$HAM_POST_VIEW_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
  HAM_POST_VIEW_ATTEMPTS=$((HAM_POST_VIEW_ATTEMPTS + 1))
  gh pr view <<PR_URL>> --json state,mergedAt,mergeCommit,headRefOid \
    > "$HAM_POST_MERGE_JSON" \
    2> "$HAM_POST_MERGE_STDERR"
  HAM_POST_VIEW_EXIT=$?
  if [ "$HAM_POST_VIEW_EXIT" -eq 0 ]; then
    break
  fi
  if ! ham_merge_error_retryable "$HAM_POST_MERGE_STDERR"; then
    cat "$HAM_POST_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: unclassified gh pr view confirmation failure; fail closed without retry" >&2
    if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
      ham_append_terminal_audit deferred merge-confirmation-read-failed-after-merge-accepted || true
    else
      ham_append_terminal_audit failed-without-merge merge-confirmation-read-failed || true
    fi
    ham_release_merge_lease
    return 1
  fi
  if [ "$HAM_POST_VIEW_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
    cat "$HAM_POST_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: retryable gh pr view confirmation failures exhausted bounded budget" >&2
    if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
      ham_append_terminal_audit deferred merge-confirmation-read-failed-after-merge-accepted || true
    else
      ham_append_terminal_audit failed-without-merge merge-confirmation-read-failed || true
    fi
    ham_release_merge_lease
    return 1
  fi
  HAM_POST_VIEW_BACKOFF_MULTIPLIER=$((1 << (HAM_POST_VIEW_ATTEMPTS - 1)))
  HAM_POST_VIEW_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
  HAM_POST_VIEW_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_POST_VIEW_BACKOFF_MULTIPLIER + HAM_POST_VIEW_JITTER))
  echo "HAM post-merge confirmation transient failure; retrying ${HAM_POST_VIEW_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_POST_VIEW_SLEEP}s" >&2
  sleep "$HAM_POST_VIEW_SLEEP"
done
HAM_POST_STATE=$(jq -r '.state // ""' "$HAM_POST_MERGE_JSON")
HAM_MERGED_AT=$(jq -r '.mergedAt // ""' "$HAM_POST_MERGE_JSON")
HAM_MERGE_COMMIT=$(jq -r '.mergeCommit?.oid // ""' "$HAM_POST_MERGE_JSON")
HAM_POST_HEAD=$(jq -r '.headRefOid // ""' "$HAM_POST_MERGE_JSON")
if [ "$HAM_POST_STATE" = "MERGED" ] && [ "$HAM_POST_HEAD" = "$POST_REMEDIATION_SHA" ]; then
  ham_append_terminal_audit succeeded merged
  HAM_MERGED_AUDIT_APPEND_EXIT=$?
  if [ "$HAM_MERGED_AUDIT_APPEND_EXIT" -ne 0 ]; then
    ham_release_merge_lease
    return "$HAM_MERGED_AUDIT_APPEND_EXIT"
  fi
  if ! ham_emit_git_merge_signal; then
    echo "HAM hard-blocker: merge signal emission failed after confirmed merge; AMA closer lease remains retryable" >&2
    ham_release_merge_lease
    return 1
  fi
  if ! ham_mark_ama_closer_lease_succeeded; then
    echo "HAM hard-blocker: failed to mark AMA closer lease succeeded after confirmed merge signal" >&2
    ham_release_merge_lease
    return 1
  fi
  trap - EXIT
  ham_release_merge_lease
else
  echo "HAM hard-blocker: gh pr merge did not confirm merged validated head" >&2
  cat "$HAM_POST_MERGE_JSON" >&2
  ham_append_terminal_audit failed-without-merge merge-not-confirmed || true
  ham_release_merge_lease
  return 1
fi
# Read by the wrapper sourcing this procedure.
# shellcheck disable=SC2034
HAM_PHASE_OUTCOME=merged
return 0
}
ham_merge_phase
