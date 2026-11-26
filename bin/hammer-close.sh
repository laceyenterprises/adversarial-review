#!/usr/bin/env bash
# HAMCONTROLLERSCRIPT-01: the hammer's one close command.
#
#   /bin/bash <deployed-root>/bin/hammer-close.sh <run-dir>/close-plan.json
#
# The closer writes only data (the plan JSON, the audit details file and
# terminal-remediation.json). This shipped launcher sources the run's
# inputs.sh itself, resolves the launch environment, then runs the shipped
# close controller under the launch-bound hammer controller. It never reads a
# terminal or standard input, so it behaves the same in a non-tty sandbox.
exec 0</dev/null

ham_close_usage() {
  echo 'usage: /bin/bash <deployed-root>/bin/hammer-close.sh <run-dir>/close-plan.json' >&2
  exit 64
}
[ "$#" -eq 1 ] && [ -n "$1" ] || ham_close_usage
HAM_CLOSE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
HAM_CLOSE_PLAN_DIR=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || {
  echo 'hammer-close: close-plan-invalid: the plan directory does not exist' >&2
  exit 65
}
HAM_CLOSE_PLAN="$HAM_CLOSE_PLAN_DIR/$(basename "$1")"

# The ordering the closer used to transcribe: inputs first, then everything else.
if [ ! -f "$HAM_CLOSE_PLAN_DIR/inputs.sh" ]; then
  "${HAM_NODE_BIN:-node}" "$HAM_CLOSE_ROOT/bin/hammer-terminal-audit.mjs" dispatch-inputs-missing || true
  echo 'hammer-close: dispatch-inputs-missing: initialize inputs.sh (Appendix A) in the plan directory first' >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$HAM_CLOSE_PLAN_DIR/inputs.sh" || exit 1
# Every helper resolves from this checkout by absolute path, never from PATH.
if [ "$(cd "${HAM_ROOT_DIR:-/nonexistent}" 2>/dev/null && pwd -P)" != "$HAM_CLOSE_ROOT" ] \
  || [ "$(cd "${HAM_RUN_DIR:-/nonexistent}" 2>/dev/null && pwd -P)" != "$HAM_CLOSE_PLAN_DIR" ]; then
  echo 'hammer-close: dispatch-inputs-missing: inputs.sh names another checkout or run directory' >&2
  exit 1
fi
if [ "$(basename "$HAM_CLOSE_PLAN")" = custody-redrive.json ]; then
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" resolve-environment || exit $?
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" run \
    "$HAM_CLOSE_ROOT/bin/hammer-close-controller.sh" "$HAM_CLOSE_PLAN"
  ham_custody_status=$?
  if [ "$ham_custody_status" -ne 0 ]; then
    "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-terminal-audit.mjs" canonical-validation-deferred || true
  fi
  exit "$ham_custody_status"
fi
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-close-plan.mjs" check "$HAM_CLOSE_PLAN" || exit $?
ham_close_rebase_publication() {
  if [ -f "$HAM_RUN_DIR/conflict-repair-publish.env" ]; then
    "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-rebase-publication
  else
    echo none
  fi
}
ham_close_rebase_state=$(ham_close_rebase_publication) || exit $?
ham_close_deferred_status=0
case "$ham_close_rebase_state" in
  ci|redrive) ;; # A completed conflict repair can publish after a drained UNKNOWN.
  blocked)
    printf 'HAM close result: {"status":1,"outcome":"source-publication-refused"}\n'
    exit 1 ;;
  *) "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-deferred || ham_close_deferred_status=$? ;;
esac
if [ "$ham_close_deferred_status" -ne 0 ]; then
  if [ "$ham_close_deferred_status" -eq 75 ]; then
    printf 'HAM close result: {"status":75,"outcome":"canonical-validation-deferred"}\n'
  fi
  exit "$ham_close_deferred_status"
fi
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" resolve-environment || exit $?
ham_close_round=1
while :; do
  rm -f "$HAM_RUN_DIR/close-result.json"
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" run \
    "$HAM_CLOSE_ROOT/bin/hammer-close-controller.sh" "$HAM_CLOSE_PLAN"
  ham_close_status=$?
  # MRQ-20: a validation timeout stops the whole controller round. When its
  # UNKNOWN receipt defers to exact-head CI, one fresh round reuses that receipt
  # (no second battery) and continues to the CI-gated predicate and merge.
  ham_close_head=$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null) || ham_close_head=
  if [ "$ham_close_round" -eq 1 ] && [ -n "$ham_close_head" ] \
    && [ -f "$HAM_RUN_DIR/validation-deferred-$ham_close_head.json" ]; then
    ham_close_retry=0
    case "$ham_close_status" in
      75|124|137|143)
        if [ ! -f "$HAM_RUN_DIR/close-result.json" ] \
          || jq -e '.stage == "local-validation" and .outcome == "canonical-validation-deferred"' \
            "$HAM_RUN_DIR/close-result.json" >/dev/null; then
          # Final-gate repair can create the binding during the stopped round.
          case "$(HAM_CLOSE_VALIDATION_HEAD="$ham_close_head" ham_close_rebase_publication)" in
            ci) ham_close_retry=1 ;;
            redrive)
              # A completed redrive already published and handed off to the watcher.
              if [ ! -f "$HAM_RUN_DIR/close-result.json" ]; then ham_close_retry=1; fi ;;
            none)
              if HAM_CLOSE_VALIDATION_HEAD="$ham_close_head" \
                "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-deferred; then ham_close_retry=1; fi ;;
          esac
        fi ;;
    esac
    if [ "$ham_close_retry" -eq 1 ]; then
      ham_close_round=2
      continue
    fi
  fi
  break
done
if [ -f "$HAM_RUN_DIR/close-result.json" ]; then
  printf 'HAM close result: '
  cat "$HAM_RUN_DIR/close-result.json"
else
  # Teardown can stop the controller shell before it writes close-result.json.
  ham_close_outcome=controller-shell-ended
  case "$(ham_close_rebase_publication)" in
    blocked) ham_close_outcome=source-publication-refused ;;
    *)
      "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-deferred || ham_close_deferred_status=$?
      if [ "$ham_close_deferred_status" -eq 75 ]; then ham_close_outcome=canonical-validation-deferred; fi ;;
  esac
  printf 'HAM close result: {"status":%s,"outcome":"%s"}\n' "$ham_close_status" "$ham_close_outcome"
fi
# The controller has drained. Scratch can already be gone after lease settlement.
# A delivery failure leaves the controller's merge outcome and exit status intact.
if [ "$ham_close_status" -eq 0 ] && [ "${HAM_FINALIZATION_EXECUTOR:-}" = queue-v2 ]; then
  # MRQ-21: nothing merged in this run; the queue executor owns the merge.
  echo 'HAM queue handoff admitted: no closing comment; end the run.'
elif [ "$ham_close_status" -eq 0 ]; then
  if ham_close_comment=$("$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-closing-comment.mjs" \
    "$HAM_REPO" "$HAM_PR_NUMBER" "$HAM_HQ_ROOT"); then
    printf 'HAM closing comment: %s\n' "$ham_close_comment"
  else
    echo 'HAM closing comment: unconfirmed; run the standalone closing-comment command' >&2
  fi
fi
exit "$ham_close_status"
