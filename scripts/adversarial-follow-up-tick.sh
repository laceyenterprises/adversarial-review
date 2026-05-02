#!/bin/zsh
# adversarial-follow-up-tick.sh
#
# Single-tick driver for the follow-up remediation pipeline. Fires from a
# LaunchAgent on a fixed interval (StartInterval=120s). One tick:
#
#   1. claim + spawn the next pending follow-up job (consume mode)
#   2. reconcile any in-progress jobs whose worker has exited
#
# Process exits cleanly between ticks. Long-running daemons that hold
# claim locks across crashes get nasty fast; this is intentionally
# stateless. Whatever launchd next-fires picks up where the last left
# off via the durable JSON queue under data/follow-up-jobs/.
#
# Auth policy mirrors the reviewer watcher:
# - Reviewer/remediator CLIs use OAuth credentials only.
# - ANTHROPIC_API_KEY / OPENAI_API_KEY are explicitly unset before exec.
# - The two reviewer-bot PATs are loaded so the comment poster can
#   speak as @claude-reviewer-lacey or @codex-reviewer-lacey on the PR
#   (see src/pr-comments.mjs::WORKER_CLASS_TO_BOT_TOKEN_ENV).
#
# ── Per-user paths ────────────────────────────────────────────────────────
#
# Most paths are derived at runtime from the principal under whose home
# dir the LaunchAgent runs (HOME / $UID), not hardcoded to /Users/placey.
# This means the same script works for a different operator: install the
# matching plist (e.g. `ai.laceyenterprises.adversarial-follow-up.<user>.plist`)
# pointing at this script; the Codex auth lookup, the 1Password resolution,
# and the `gh` token will all resolve from the running user's environment.
#
# What's still fixed:
# - WATCHER_DIR (`AGENT_OS_ROOT/tools/adversarial-review`) — the repo
#   location is environment-specific by design and matches the watcher
#   plist convention. Override AGENT_OS_ROOT to relocate.
# - The op-service-account.env path under agents/clio/credentials/local
#   — that file pairs a 1Password service-account token with the
#   running machine and is provisioned out-of-band by `restore.sh`.

set -euo pipefail

AGENT_OS_ROOT="${AGENT_OS_ROOT:-/Users/airlock/agent-os}"
WATCHER_DIR="$AGENT_OS_ROOT/tools/adversarial-review"

# Sanity gate: better-sqlite3 is a native module and breaks across Node ABI
# bumps (NODE_MODULE_VERSION mismatch). If the daemon will fail to load
# anyway, sleep instead of crash-looping — same lesson as the watcher's
# popup-storm incident on 2026-04-26. Keep this BEFORE 1Password resolution
# so a broken native module produces zero `op read` popups.
if ! ( cd "$WATCHER_DIR" && /opt/homebrew/bin/node -e "const Database=require('better-sqlite3'); new Database(':memory:').close();" ) >/tmp/adversarial-follow-up-native-check.err 2>&1; then
  echo "[follow-up-tick] ERROR: better-sqlite3 failed to load — likely Node ABI mismatch after a node upgrade." >&2
  echo "[follow-up-tick] details:" >&2
  sed 's/^/  /' /tmp/adversarial-follow-up-native-check.err >&2
  echo "[follow-up-tick] fix: cd $WATCHER_DIR && npm rebuild better-sqlite3" >&2
  echo "[follow-up-tick] sleeping 3600s to suppress launchd respawn storm; bootout the agent and rebuild to recover sooner." >&2
  sleep 3600
  exit 1
fi

# Load 1Password service account token (not in LaunchAgent env by default).
source "$AGENT_OS_ROOT/agents/clio/credentials/local/op-service-account.env"
export OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"
if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  echo "[follow-up-tick] ERROR: OP_SERVICE_ACCOUNT_TOKEN not loaded" >&2
  exit 1
fi

# Operator gh token for repo clone / pr checkout / pr metadata. The
# remediation worker uses this to clone the PR's repo, switch to its
# branch, and push its remediation commits back. Note: this is the
# operator's identity, distinct from the reviewer-bot PATs the comment
# poster uses (see below).
export GITHUB_TOKEN=$(/opt/homebrew/bin/gh auth token 2>/dev/null)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[follow-up-tick] ERROR: could not resolve GITHUB_TOKEN from gh keychain" >&2
  exit 1
fi

# Reviewer-bot PATs for the comment poster. Worker class → bot mapping
# (canonical): codex → GH_CODEX_REVIEWER_TOKEN, claude-code → GH_CLAUDE_REVIEWER_TOKEN.
# See src/pr-comments.mjs::WORKER_CLASS_TO_BOT_TOKEN_ENV.
export GH_CLAUDE_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential')
export GH_CODEX_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential')
if [[ -z "${GH_CLAUDE_REVIEWER_TOKEN:-}" ]]; then
  echo "[follow-up-tick] ERROR: failed to resolve GH_CLAUDE_REVIEWER_TOKEN from 1Password" >&2
  exit 1
fi
if [[ -z "${GH_CODEX_REVIEWER_TOKEN:-}" ]]; then
  echo "[follow-up-tick] ERROR: failed to resolve GH_CODEX_REVIEWER_TOKEN from 1Password" >&2
  exit 1
fi

# Codex auth file lives in the running user's home; let the env
# pre-set CODEX_AUTH_PATH override (e.g. via the LaunchAgent plist or
# a developer shell), otherwise default to "$HOME/.codex/auth.json".
# The watcher and this daemon must agree on the auth file when run as
# the same user — the LaunchAgent plist sets HOME explicitly so this
# resolves to the operator's path even when launchd doesn't carry HOME.
export CODEX_AUTH_PATH="${CODEX_AUTH_PATH:-$HOME/.codex/auth.json}"

# Scrub direct-provider API keys — remediation workers must use OAuth only.
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY

cd "$WATCHER_DIR"

# Tick step 1: consume one pending job (no-op if queue is empty).
# We don't fail the tick on a non-zero exit because consume failures
# (e.g., OAuth pre-flight) move the offending job to failed/ via the
# in-process catch — the queue keeps moving on the next tick.
TICK_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[follow-up-tick $TICK_TS] consume: starting"
/opt/homebrew/bin/node "$WATCHER_DIR/src/follow-up-remediation.mjs" || \
  echo "[follow-up-tick $TICK_TS] consume: exited non-zero (job moved to failed/ — see logs)"

# Tick step 2: reconcile in-progress jobs (workers may have exited).
# Uses src/follow-up-reconcile.mjs (the canonical entry point exposed by
# `npm run follow-up:reconcile`) rather than the `reconcile` arg of
# follow-up-remediation.mjs, so output formatting matches what an
# operator would see when running the reconcile npm script by hand.
echo "[follow-up-tick $TICK_TS] reconcile: starting"
/opt/homebrew/bin/node "$WATCHER_DIR/src/follow-up-reconcile.mjs" || \
  echo "[follow-up-tick $TICK_TS] reconcile: exited non-zero"

echo "[follow-up-tick $TICK_TS] tick complete"
