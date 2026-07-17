#!/bin/zsh
# adversarial-runtime-canary-start.sh (ARC-09)
# LaunchAgent wrapper for the daily fallback canary. Resolves the alert
# recipient (so a rotted lifeline can page) then execs the canary once.
#
# Unlike the watcher wrapper this is a one-shot: the plist schedules it daily
# via StartCalendarInterval, node runs the canary, writes the status file, pages
# on failure, and exits (0 = PASS, 1 = FAIL). No KeepAlive, no crash-loop risk.

set -euo pipefail

CANARY_DIR="${ADVERSARIAL_REVIEW_DIR:-/Users/airlock/agent-os/tools/adversarial-review}"  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
cd "$CANARY_DIR"

# Resolve ALERT_TO from the standing 1Password ref when present, mirroring the
# watcher's alert contract. A failed secret read is retried and then fails the
# wrapper loudly: running a canary that cannot page would create false safety.
if [[ -z "${ADVERSARIAL_REVIEW_ALERT_TO:-}" && -n "${ADVERSARIAL_REVIEW_ALERT_TO_OP_REF:-}" ]]; then
  if command -v op >/dev/null 2>&1; then
    alert_to=""
    for attempt in 1 2 3; do
      if alert_to="$(op read "$ADVERSARIAL_REVIEW_ALERT_TO_OP_REF")"; then
        export ADVERSARIAL_REVIEW_ALERT_TO="$alert_to"
        break
      fi
      if (( attempt < 3 )); then
        sleep "$attempt"
      else
        print -u2 "runtime-canary: failed to resolve alert recipient after 3 attempts"
        exit 1
      fi
    done
  else
    print -u2 "runtime-canary: op CLI unavailable; cannot resolve alert recipient"
    exit 1
  fi
fi

# `--fixture` (default in the script) proves the local-runtime port + admission
# + verdict-parse + alerting path hermetically. Flip the plist argument to
# `--live` once the real reviewer spawn is production-wired end to end (ARC-08+)
# so the canary detects genuine lifeline rot.
exec node "$CANARY_DIR/scripts/adversarial-runtime-canary.mjs" "$@"
