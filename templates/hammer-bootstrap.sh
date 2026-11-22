#!/bin/bash
# Rendered by AMA dispatch in the launch's private scratch directory.
exec </dev/null
umask 077
export HAM_RUN_DIR="<<RUN_DIR>>" HAM_ROOT_DIR="<<ROOT_DIR>>" HAM_HQ_ROOT="<<HQ_ROOT>>"
export HAM_REPO="<<REPO>>" HAM_PR_NUMBER="<<PR_NUMBER>>" HAM_TARGET_REMEDIATION_SHA="<<TARGET_REMEDIATION_SHA>>"
export HAM_PR_URL="<<PR_URL>>"
# shellcheck source=/dev/null
source "$HAM_ROOT_DIR/bin/hammer-node-runtime.sh" || exit 1

stop_bootstrap() {
  printf 'HAM bootstrap failed: %s\n' "$1" >&2
  "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-terminal-audit.mjs" "$1"
  exit 1
}

failed_step() {
  printf 'HAM bootstrap step=%s exit=%s\n' "$1" "$2" >&2
  exit "$2"
}

for phase in hammer-verify-head hammer-publish hammer-merge; do
  [ -f "$HAM_RUN_DIR/$phase.sh" ] || stop_bootstrap dispatch-phase-scripts-missing
done
for helper in hammer-bootstrap-lock.mjs hammer-helper-step.mjs hammer-base-head.mjs hammer-controller.mjs hammer-context.mjs hammer-shell-helpers.sh; do
  [ -f "$HAM_ROOT_DIR/bin/$helper" ] || stop_bootstrap dispatch-phase-scripts-missing
done

busy_bootstrap() {
  printf '%s\n' 'HAM bootstrap scratch is busy or ownership is unknown; preserve the existing attempt' >&2
  exit 73
}

# Keep the lock inode for the life of scratch. The kernel releases ownership
# when the last copy closes, including after SIGKILL. Foreground helpers
# inherit FD 9 so a read surviving the shell keeps exclusive custody.
exec 9>>"$HAM_RUN_DIR/.bootstrap.lock" || busy_bootstrap
"$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-bootstrap-lock.mjs" 3<&9 || busy_bootstrap
# A directory lock from an older script has no trustworthy owner evidence.
if [ -e "$HAM_RUN_DIR/.bootstrap" ] || [ -L "$HAM_RUN_DIR/.bootstrap" ]; then
  busy_bootstrap
fi

if [ -e "$HAM_RUN_DIR/inputs.sh" ]; then
  [ -f "$HAM_RUN_DIR/inputs.sh" ] && [ -s "$HAM_RUN_DIR/inputs.sh" ] &&
    [ -s "$HAM_RUN_DIR/context.json" ] && [ -s "$HAM_RUN_DIR/base-head" ] || stop_bootstrap dispatch-inputs-missing
  printf '%s\n' 'HAM bootstrap already initialized: context.json is the initial snapshot; source inputs.sh and run ham_read context for the current context'
  exit 0
fi

pending="$HAM_RUN_DIR/.bootstrap-pending"
mkdir -p "$pending" || stop_bootstrap controller-setup-failed
trap 'rm -f "$pending/base-head" "$pending/inputs.sh" "$pending/context.json"; rmdir "$pending"' EXIT

# Keep the original pin even if environment resolution or context later fails.
if [ ! -e "$HAM_RUN_DIR/base-head" ]; then
  "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-helper-step.mjs" read:report base-head 90 540 \
    "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-base-head.mjs" "$HAM_PR_URL" > "$pending/base-head" || failed_step base-head "$?"
  pending_head="$(cat "$pending/base-head")" || stop_bootstrap controller-setup-failed
  [[ "$pending_head" =~ ^[0-9a-f]{40}$ ]] || stop_bootstrap controller-setup-failed
  mv "$pending/base-head" "$HAM_RUN_DIR/base-head" || stop_bootstrap controller-setup-failed
fi
cat > "$pending/inputs.sh" <<'HAM_INPUTS' || stop_bootstrap controller-setup-failed
source "<<ROOT_DIR>>"/bin/hammer-node-runtime.sh || { return 1 2>/dev/null || exit 1; }
export HAM_RUN_DIR="<<RUN_DIR>>"
HAM_BASE_HEAD="$(cat "$HAM_RUN_DIR/base-head")" || { return 1 2>/dev/null || exit 1; }
[[ "$HAM_BASE_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo 'HAM starting head unavailable' >&2; return 1 2>/dev/null || exit 1; }
export HAM_BASE_HEAD TMPDIR="$HAM_RUN_DIR"
export HAM_PR_URL="<<PR_URL>>" HAM_REPO="<<REPO>>" HAM_PR_NUMBER="<<PR_NUMBER>>"
export HAM_REVIEWED_SHA="<<REVIEWED_SHA>>" HAM_TARGET_REMEDIATION_SHA="<<TARGET_REMEDIATION_SHA>>"
export HAM_RISK_CLASS="<<RISK_CLASS>>" HAM_MERGE_METHOD="<<MERGE_METHOD>>"
export HAM_ROOT_DIR="<<ROOT_DIR>>" HAM_HQ_ROOT="<<HQ_ROOT>>" HAM_HQ_OWNER="<<HQ_OWNER>>"
export HAM_AUDIT_PATH="<<AUDIT_PATH>>" HAM_REVIEWER="<<REVIEWER>>"
export HAM_AMA_TRAILERS=<<AMA_TRAILERS_SHELL>>
<<TENURE_INPUTS>>source "<<ROOT_DIR>>"/bin/hammer-shell-helpers.sh || { return 1 2>/dev/null || exit 1; }
ham_step() { /usr/bin/perl -e 'my $n = shift or exit 1; exec $n, @ARGV; die $!' "$HAM_NODE_BIN" "<<ROOT_DIR>>"/bin/hammer-helper-step.mjs "$@"; }
ham_read() { ham_step read:report "$1" 90 540 "${@:2}"; }
HAM_INPUTS
# shellcheck source=/dev/null
source "$pending/inputs.sh" || stop_bootstrap controller-setup-failed
"$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-controller.mjs" resolve-environment || failed_step resolve-environment "$?"
ham_read context "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-context.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" \
  > "$pending/context.json" || failed_step context "$?"
[ -s "$pending/context.json" ] || stop_bootstrap context-failed
mv "$pending/context.json" "$HAM_RUN_DIR/context.json" || stop_bootstrap controller-setup-failed
mv "$pending/inputs.sh" "$HAM_RUN_DIR/inputs.sh" || stop_bootstrap controller-setup-failed
printf '%s\n' 'HAM bootstrap ready: read the initial context.json snapshot and the full review'
