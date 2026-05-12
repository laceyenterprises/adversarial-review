#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE="${1:-}"
TIMEOUT_SECONDS="${BOUNCE_DRAIN_TIMEOUT_SECONDS:-900}"
DRAIN_FILE="$REPO_ROOT/data/watcher-drain.json"

if [[ -z "$SERVICE" ]]; then
  echo "usage: tools/adversarial-review/bounce.sh <launchd-plist|systemd-service>" >&2
  exit 2
fi

write_drain_marker() {
  node -e "
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const timeout = Number(process.argv[2]) || 900;
const file = path.join(root, 'data', 'watcher-drain.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  reason: 'operator bounce',
  requestedBy: process.env.USER || 'unknown',
  expiresAt: new Date(Date.now() + timeout * 1000).toISOString()
}, null, 2) + '\n');
" "$REPO_ROOT" "$TIMEOUT_SECONDS"
}

cleanup_drain_marker() {
  rm -f "$DRAIN_FILE"
}

active_pgids() {
  node -e "
try {
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  const rows = db.prepare(\"SELECT DISTINCT reviewer_pgid AS pgid FROM reviewed_prs WHERE review_status = 'reviewing' AND reviewer_pgid IS NOT NULL\").all();
  for (const row of rows) {
    const pgid = Number(row.pgid);
    if (!Number.isInteger(pgid) || pgid <= 0) continue;
    try {
      process.kill(-pgid, 0);
      console.log(pgid);
    } catch {}
  }
  db.close();
} catch {}
" "$REPO_ROOT/data/reviews.db"
}

wait_for_reviewer_drain() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while true; do
    pgids=()
    while IFS= read -r pgid; do
      [[ -n "$pgid" ]] && pgids+=("$pgid")
    done < <(active_pgids)
    if (( ${#pgids[@]} == 0 )); then
      echo "reviewer subprocess drain complete"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "timed out waiting for reviewer PGIDs to drain: ${pgids[*]}" >&2
      return 1
    fi
    echo "waiting for reviewer PGIDs to drain: ${pgids[*]}"
    sleep 5
  done
}

trap cleanup_drain_marker EXIT

write_drain_marker

drain_status=0

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ ! -f "$SERVICE" ]]; then
    echo "launchd bounce requires a plist path so bootstrap can restart it: $SERVICE" >&2
    exit 2
  fi
  launchctl bootout "gui/$UID" "$SERVICE" 2>/dev/null || true
  if wait_for_reviewer_drain; then
    drain_status=0
  else
    drain_status=$?
    echo "drain timed out; restarting launchd service anyway" >&2
  fi
  launchctl bootstrap "gui/$UID" "$SERVICE"
else
  systemctl --user stop "$SERVICE"
  if wait_for_reviewer_drain; then
    drain_status=0
  else
    drain_status=$?
    echo "drain timed out; restarting systemd service anyway" >&2
  fi
  systemctl --user start "$SERVICE"
fi

exit "$drain_status"
