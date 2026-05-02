#!/bin/zsh
# adversarial-follow-up-tick.sh
#
# Startup gate for the follow-up remediation daemon. Validates the
# native module, resolves secrets ONCE via 1Password / gh, scrubs
# forbidden env, then `exec`s into the in-process node daemon
# (scripts/adversarial-follow-up-daemon.mjs) which owns the tick
# loop.
#
# Why this shape (changed 2026-05-02 round 2): an earlier revision
# ran the tick loop in bash and spawned three fresh `node`
# subprocesses every 120s (consume / reconcile / retry-comments).
# Each fresh node re-touched ~/.codex/auth.json and worker session
# dirs, and macOS TCC re-prompted "node would like to access data
# from other apps" on every tick because launchd-spawned processes
# don't inherit terminal-session TCC trust. Collapsing the three
# steps into a single long-lived node process means TCC trust is
# granted once at startup and reused for the daemon's lifetime.
# (The earlier revision before this had a launchd StartInterval=120
# one-shot that re-resolved secrets on every tick — that's what
# caused the 1Password popup storm; this current shape resolves
# secrets once and never re-prompts.)
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
TICK_INTERVAL_SECONDS="${TICK_INTERVAL_SECONDS:-120}"

# ── Startup gate (runs once) ───────────────────────────────────────────────

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
#
# Resolved ONCE at daemon startup. Subsequent ticks within the same
# daemon process reuse these env vars in-process — no new `op read`
# subprocess, no new popup. Token rotation requires a daemon restart.
#
# DEGRADED MODE: missing PAT does NOT exit. PR comments are documented
# as best-effort, so a 1Password outage at boot or a missing/rotated
# bot token must NOT block consume/reconcile. The comment poster
# records the failure under `commentDelivery.reason='token-env-missing'`
# (NON_RETRYABLE_DELIVERY_REASONS, so the retry pass doesn't burn
# attempts hammering an obviously-broken token); the daemon picks up
# the token on its next start once 1Password is back. R4 review
# blocking #4 on PR #18.
GH_CLAUDE_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential' 2>/dev/null || true)
GH_CODEX_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential' 2>/dev/null || true)
export GH_CLAUDE_REVIEWER_TOKEN
export GH_CODEX_REVIEWER_TOKEN
if [[ -z "${GH_CLAUDE_REVIEWER_TOKEN:-}" ]]; then
  echo "[follow-up-tick] WARN: GH_CLAUDE_REVIEWER_TOKEN not resolved at startup — claude-code comment posts will be deferred to retry; consume/reconcile continue." >&2
fi
if [[ -z "${GH_CODEX_REVIEWER_TOKEN:-}" ]]; then
  echo "[follow-up-tick] WARN: GH_CODEX_REVIEWER_TOKEN not resolved at startup — codex comment posts will be deferred to retry; consume/reconcile continue." >&2
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

# ── Hand off to the in-process node daemon ────────────────────────────────
#
# This bash script's only responsibility is the startup gate — sanity-check
# the native module, resolve secrets via 1Password and gh, scrub forbidden
# env, then exec into the node daemon. The daemon owns the tick loop
# in-process.
#
# Why exec instead of spawn: the previous design ran a `while true` loop
# in bash that spawned three fresh `node` subprocesses every 120s. Each
# new node process re-touched ~/.codex/auth.json and worker session
# dirs, and macOS TCC re-prompted "node would like to access data from
# other apps" on every tick because launchd-spawned processes don't
# inherit a terminal session's TCC trust. Collapsing the three steps
# into a single long-lived node process means TCC trust is granted
# once at startup and reused for the daemon's lifetime.
#
# `exec` replaces this bash process with node, so launchd sees the
# node process directly (cleaner KeepAlive semantics) and signals
# (SIGTERM from `launchctl bootout`) flow straight to node where it
# can shut down its tick loop gracefully — see
# scripts/adversarial-follow-up-daemon.mjs for the SIGTERM trap.
exec /opt/homebrew/bin/node "$WATCHER_DIR/scripts/adversarial-follow-up-daemon.mjs"
