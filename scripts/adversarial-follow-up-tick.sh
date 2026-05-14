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
# - API-key/provider fallback env vars are explicitly unset before exec.
# - The two reviewer-bot PATs are loaded so the comment poster can
#   speak as @claude-reviewer-lacey or @codex-reviewer-lacey on the PR
#   (see src/adapters/comms/github-pr-comments/pr-comments.mjs::WORKER_CLASS_TO_BOT_TOKEN_ENV).
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
# Per-user err-file path. The original `/tmp/adversarial-follow-up-native-check.err`
# was a single shared path across users, which silently broke the airlock-side
# launch when an old placey-owned file existed (cross-user redirect denied,
# masking a healthy ABI as a false mismatch). UID-suffixed paths give every
# user their own scratch file with no cleanup coupling.
FOLLOW_UP_NATIVE_CHECK_ERR="${TMPDIR:-/tmp}/adversarial-follow-up-native-check.${UID}.err"
if ! ( cd "$WATCHER_DIR" && /opt/homebrew/bin/node -e "const Database=require('better-sqlite3'); new Database(':memory:').close();" ) >"$FOLLOW_UP_NATIVE_CHECK_ERR" 2>&1; then
  echo "[follow-up-tick] ERROR: better-sqlite3 failed to load — likely Node ABI mismatch after a node upgrade." >&2
  echo "[follow-up-tick] details:" >&2
  sed 's/^/  /' "$FOLLOW_UP_NATIVE_CHECK_ERR" >&2
  echo "[follow-up-tick] fix: cd $WATCHER_DIR && npm rebuild better-sqlite3" >&2
  echo "[follow-up-tick] sleeping 3600s to suppress launchd respawn storm; bootout the agent and rebuild to recover sooner." >&2
  sleep 3600
  exit 1
fi

# Load 1Password service account token via the canonical secret-source
# contract (tools/adversarial-review/DEPS.md §"OP_SERVICE_ACCOUNT_TOKEN
# resolution"). The resolver checks, in order: process env, ADV_OP_TOKEN_FILE,
# ADV_OP_TOKEN_ENV_FILE, the legacy agents/clio/credentials/local
# op-service-account.env compatibility file, $ADV_SECRETS_ROOT/
# op-service-account.token, then $HOME/.config/adversarial-review/
# secrets/op-service-account.token. On failure it prints a single
# detailed diagnostic with every source it checked plus concrete
# remediation, and exits non-zero. We then sleep 3600 to absorb the
# launchd KeepAlive+ThrottleInterval=30 respawn storm — same fail-once
# shape as the better-sqlite3 ABI gate above.
ADV_OP_TOKEN_TAG="follow-up-tick" \
  OP_SERVICE_ACCOUNT_TOKEN=$(/opt/homebrew/bin/node "$WATCHER_DIR/src/secret-source/resolve-op-token-cli.mjs") || {
    echo "[follow-up-tick] sleeping 3600s to suppress launchd respawn storm; fix the secret-source above and bootout the agent to recover sooner." >&2
    sleep 3600
    exit 78
  }
export OP_SERVICE_ACCOUNT_TOKEN

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
# See src/adapters/comms/github-pr-comments/pr-comments.mjs::WORKER_CLASS_TO_BOT_TOKEN_ENV.
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

# Scrub direct-provider API/provider fallbacks — workers must use OAuth only.
unset ANTHROPIC_API_KEY
unset ANTHROPIC_BASE_URL
unset OPENAI_API_KEY
unset GOOGLE_API_KEY
unset GEMINI_API_KEY
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset AWS_BEARER_TOKEN_BEDROCK
# Preserve ANTHROPIC_AUTH_TOKEN: it may be the OAuth bearer.

cd "$WATCHER_DIR"

# ── TCC reminder banner ────────────────────────────────────────────────────
#
# The daemon's own `node` process is approved at TCC once the operator
# has dragged /opt/homebrew/bin/node into Full Disk Access. Per-spawn
# remediation worker subprocesses (codex, claude) are *separate* TCC
# subjects and need their own approval — the operator handles that
# once via System Settings (see docs/MACOS-TCC.md). We log the
# currently-resolved underlying binary paths so operators can confirm
# the FDA list still matches the live install after a Homebrew bump.
#
# This is intentionally a single log line, not a check — checking
# whether a path is FDA-approved requires private TCC APIs. The
# documented signal that approval has lapsed is "TCC popups start
# firing on remediation worker spawn"; when that happens the operator
# reads docs/MACOS-TCC.md and re-drags the affected binary.
NODE_REAL=$(readlink -f /opt/homebrew/bin/node 2>/dev/null || echo "<missing>")
CLAUDE_REAL=$(readlink -f /opt/homebrew/bin/claude 2>/dev/null || echo "<missing>")
# Codex's real Mach-O binary lives under a platform-specific npm
# sub-package whose path moves on every codex version bump and every
# fnm node-version change. The user-facing `codex` symlink resolves
# to a `codex.js` script that *spawns* the real binary, so TCC keys
# on the spawned binary, not the symlink. Resolve through the same
# env contract the worker uses (src/follow-up-remediation.mjs::
# resolveCodexCliPath): $CODEX_CLI_PATH, then $CODEX_CLI, then
# `command -v codex`. Branch on runtime arch for the vendor triple.
# Fail closed on ambiguous multi-version readlink output so the
# banner doesn't silently point operators at a stale install.
CODEX_REAL=""
codex_resolution_note=""
codex_exe="${CODEX_CLI_PATH:-${CODEX_CLI:-}}"
if [[ -z "$codex_exe" || ! -e "$codex_exe" ]]; then
  codex_exe=$(command -v codex 2>/dev/null || true)
fi
if [[ -z "$codex_exe" || ! -e "$codex_exe" ]]; then
  codex_resolution_note='codex executable not resolvable via $CODEX_CLI_PATH, $CODEX_CLI, or PATH'
else
  codex_real_target=$(readlink -f "$codex_exe" 2>/dev/null || true)
  if [[ -z "$codex_real_target" ]]; then
    codex_resolution_note="readlink -f failed for $codex_exe"
  elif [[ "$codex_real_target" == *$'\n'* ]]; then
    codex_resolution_note="ambiguous readlink result for $codex_exe — resolve $CODEX_CLI_PATH explicitly"
  else
    case "$(/usr/bin/uname -m)" in
      arm64)  codex_triple="aarch64-apple-darwin"; codex_subpkg="codex-darwin-arm64" ;;
      x86_64) codex_triple="x86_64-apple-darwin"; codex_subpkg="codex-darwin-x64" ;;
      *)      codex_triple=""; codex_subpkg="" ;;
    esac
    if [[ -z "$codex_triple" ]]; then
      codex_resolution_note="unsupported macOS arch: $(/usr/bin/uname -m)"
    else
      codex_candidate="$(dirname "$codex_real_target")/../node_modules/@openai/$codex_subpkg/vendor/$codex_triple/codex/codex"
      if [[ -f "$codex_candidate" ]]; then
        CODEX_REAL="$(cd "$(dirname "$codex_candidate")" && pwd)/codex"
      else
        codex_resolution_note="vendor binary not found at expected path: $codex_candidate"
      fi
    fi
  fi
fi
if [[ -z "$CODEX_REAL" ]]; then
  CODEX_REAL="<unresolved: ${codex_resolution_note:-unknown reason} — see docs/MACOS-TCC.md>"
fi
echo "[follow-up-tick] TCC subjects (must be in Full Disk Access — see docs/MACOS-TCC.md):"
echo "[follow-up-tick]   /opt/homebrew/bin/node    -> $NODE_REAL"
echo "[follow-up-tick]   /opt/homebrew/bin/claude  -> $CLAUDE_REAL"
echo "[follow-up-tick]   codex (real Mach-O)       -> $CODEX_REAL"

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
