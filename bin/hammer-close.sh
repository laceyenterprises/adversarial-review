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
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-close-plan.mjs" check "$HAM_CLOSE_PLAN" || exit $?
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" resolve-environment || exit $?
rm -f "$HAM_RUN_DIR/close-result.json"
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" run \
  "$HAM_CLOSE_ROOT/bin/hammer-close-controller.sh" "$HAM_CLOSE_PLAN"
ham_close_status=$?
if [ -f "$HAM_RUN_DIR/close-result.json" ]; then
  printf 'HAM close result: '
  cat "$HAM_RUN_DIR/close-result.json"
else
  printf 'HAM close result: {"status":%s,"outcome":"controller-shell-ended"}\n' "$ham_close_status"
fi
exit "$ham_close_status"
