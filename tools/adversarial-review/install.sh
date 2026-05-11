#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/adversarial-review.env"
PREFER_LOCAL_ACPX=0
WITH_HQ_INTEGRATION=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
      shift 2
      ;;
    --prefer-local-acpx)
      PREFER_LOCAL_ACPX=1
      shift
      ;;
    --with-hq-integration)
      WITH_HQ_INTEGRATION=1
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: tools/adversarial-review/install.sh [--env-file PATH] [--with-hq-integration] [--prefer-local-acpx]

Checks the local host for the adversarial-review production runtime contract,
materializes an EnvironmentFile, runs npm ci, rebuilds better-sqlite3, verifies
the native ABI, and runs npm test.
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

failures=()
warnings=()

mark_ok() {
  printf '✓ %s\n' "$1"
}

mark_fail() {
  printf '✗ %s\n' "$1"
  failures+=("$1")
}

mark_warn() {
  printf '! %s\n' "$1"
  warnings+=("$1")
}

resolve_bin() {
  local override="$1"
  local name="$2"
  if [[ -n "$override" && -x "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  command -v "$name" 2>/dev/null || true
}

run_step() {
  local label="$1"
  shift
  if "$@"; then
    mark_ok "$label"
  else
    mark_fail "$label"
  fi
}

check_node_range() {
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const range = pkg.engines && pkg.engines.node;
const major = Number(process.versions.node.split('.')[0]);
if (!range) {
  console.error('package.json is missing engines.node');
  process.exit(1);
}
if (!(major >= 20 && major < 26)) {
  console.error('Node ' + process.version + ' does not satisfy ' + range);
  process.exit(1);
}
"
}

cd "$REPO_ROOT"
echo "adversarial-review install check"
echo "repo: $REPO_ROOT"
echo

if command -v node >/dev/null 2>&1; then
  run_step "Node $(node --version) satisfies package engines" check_node_range
else
  mark_fail "node is not installed or not on PATH"
fi

if command -v npm >/dev/null 2>&1; then
  mark_ok "npm $(npm --version) found"
else
  mark_fail "npm is not installed or not on PATH"
fi

if [[ -f package-lock.json ]]; then
  run_step "npm ci completed" npm ci
else
  mark_fail "package-lock.json missing; npm ci cannot run"
fi

if [[ -d node_modules ]]; then
  run_step "better-sqlite3 rebuilt for this Node ABI" npm rebuild better-sqlite3
  run_step "better-sqlite3 in-memory ABI probe passed" node -e "new (require('better-sqlite3'))(':memory:').close()"
else
  mark_fail "node_modules missing; cannot rebuild or ABI-probe better-sqlite3"
fi

CLAUDE_BIN="$(resolve_bin "${CLAUDE_CLI_PATH:-${CLAUDE_CLI:-}}" claude)"
CODEX_BIN="$(resolve_bin "${CODEX_CLI_PATH:-${CODEX_CLI:-}}" codex)"
GH_BIN="$(resolve_bin "${GH_CLI_PATH:-${GH_CLI:-}}" gh)"
OP_BIN="$(resolve_bin "${OP_CLI_PATH:-${OP_CLI:-}}" op)"
ACPX_BIN="$(resolve_bin "${ACPX_CLI_PATH:-${ACPX_CLI:-}}" acpx)"
if [[ -z "$ACPX_BIN" && "$PREFER_LOCAL_ACPX" == "1" ]]; then
  candidate="$HOME/.openclaw/tools/acpx/node_modules/.bin/acpx"
  if [[ -x "$candidate" ]]; then
    ACPX_BIN="$candidate"
  fi
fi

[[ -n "$CLAUDE_BIN" ]] && mark_ok "claude CLI found at $CLAUDE_BIN" || mark_fail "claude CLI missing; install Claude Code or set CLAUDE_CLI_PATH"
[[ -n "$CODEX_BIN" ]] && mark_ok "codex CLI found at $CODEX_BIN" || mark_fail "codex CLI missing; install Codex CLI or set CODEX_CLI_PATH"
[[ -n "$GH_BIN" ]] && mark_ok "gh CLI found at $GH_BIN" || mark_fail "gh CLI missing; install GitHub CLI or set GH_CLI_PATH"
[[ -n "$OP_BIN" ]] && mark_ok "op CLI found at $OP_BIN" || mark_warn "optional op CLI missing; 1Password secret-source mode will be unavailable"
[[ -n "$ACPX_BIN" ]] && mark_ok "optional acpx CLI found at $ACPX_BIN" || mark_warn "optional acpx CLI missing; native codex path remains available"

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  mark_ok "GITHUB_TOKEN present"
elif [[ -n "$GH_BIN" ]] && "$GH_BIN" auth token >/dev/null 2>&1; then
  mark_ok "GITHUB_TOKEN can be resolved from gh auth token"
else
  mark_fail "GITHUB_TOKEN missing and gh auth token is unavailable"
fi

[[ -n "${GH_CLAUDE_REVIEWER_TOKEN:-}" ]] && mark_ok "GH_CLAUDE_REVIEWER_TOKEN present" || mark_fail "GH_CLAUDE_REVIEWER_TOKEN missing"
[[ -n "${GH_CODEX_REVIEWER_TOKEN:-}" ]] && mark_ok "GH_CODEX_REVIEWER_TOKEN present" || mark_fail "GH_CODEX_REVIEWER_TOKEN missing"
[[ -n "${LINEAR_API_KEY:-}" ]] && mark_ok "optional LINEAR_API_KEY present" || mark_warn "optional LINEAR_API_KEY missing; Linear updates will be skipped"

if [[ -n "${ALERT_TO:-}" || -n "${TELEGRAM_BOT_TOKEN:-}" || -n "${OPENCLAW_HOOKS_TOKEN:-}" || -n "${HOOKS_TOKEN:-}" ]]; then
  mark_ok "optional alert environment has at least one configured value"
else
  mark_warn "optional Telegram/OpenClaw alert vars missing"
fi

CODEX_AUTH="${CODEX_AUTH_PATH:-${CODEX_HOME:-$HOME/.codex}/auth.json}"
if [[ -r "$CODEX_AUTH" ]]; then
  mark_ok "Codex OAuth auth.json readable at $CODEX_AUTH"
else
  mark_fail "Codex OAuth auth.json unreadable at $CODEX_AUTH; run codex login"
fi

mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<EOF
# Generated by tools/adversarial-review/install.sh
ADV_REPO_ROOT=$REPO_ROOT
ADV_SECRETS_ROOT=${ADV_SECRETS_ROOT:-$HOME/.config/adversarial-review/secrets}
ADV_REPLIES_ROOT=${ADV_REPLIES_ROOT:-$REPO_ROOT/data/replies}
ADV_WITH_HQ_INTEGRATION=$WITH_HQ_INTEGRATION
PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}
CLAUDE_CLI_PATH=$CLAUDE_BIN
CODEX_CLI_PATH=$CODEX_BIN
GH_CLI_PATH=$GH_BIN
OP_CLI_PATH=$OP_BIN
ACPX_CLI_PATH=$ACPX_BIN
CODEX_AUTH_PATH=$CODEX_AUTH
EOF
mark_ok "EnvironmentFile materialized at $ENV_FILE"

if [[ -d node_modules ]]; then
  run_step "npm test passed" npm test
else
  mark_fail "npm test skipped because node_modules is missing"
fi

echo
if (( ${#warnings[@]} > 0 )); then
  echo "Optional follow-ups:"
  for item in "${warnings[@]}"; do
    printf '  - %s\n' "$item"
  done
  echo
fi

if (( ${#failures[@]} > 0 )); then
  echo "You still need:"
  for item in "${failures[@]}"; do
    printf '  - %s\n' "$item"
  done
  exit 1
fi

echo "All required checks are green."
