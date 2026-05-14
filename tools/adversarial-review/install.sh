#!/usr/bin/env bash
# tools/adversarial-review/install.sh
#
# Portable macOS installer for the adversarial-review watcher + follow-up
# daemon. Renders the templates under deploy/launchd/ into the running
# operator's ~/Library/LaunchAgents/ and $REPO_ROOT/scripts/render/, then
# runs a postflight validator that surfaces the most likely first-run
# failures.
#
# Contract: see tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md.
# Inputs (env wins over prompt, prompt only fires for an unset variable
# in an interactive terminal):
#
#   REPO_ROOT            (default: git rev-parse --show-toplevel)
#   OPERATOR_HOME        (default: $HOME)
#   SECRETS_ROOT         (default: $OPERATOR_HOME/.config/adversarial-review/secrets)
#   LOG_ROOT             (default: $OPERATOR_HOME/Library/Logs/adversarial-review)
#   REVIEWER_AUTH_ROOT   (default: empty — operator may set explicitly)
#   WATCHER_USER_LABEL   (default: "local")
#
# Flags:
#   --dry-run            Render to a temp dir, skip postflight, print the
#                        rendered file list. Never touches
#                        ~/Library/LaunchAgents.
#   --output-dir PATH    Override the launchd-agents output directory.
#                        Combined with --dry-run by the test harness.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/deploy/launchd"
RENDER_LIB="$SCRIPT_DIR/lib/render-template.mjs"

DRY_RUN=0
OUTPUT_DIR_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR_OVERRIDE="${2:?--output-dir requires a path}"
      shift 2
      ;;
    --output-dir=*)
      OUTPUT_DIR_OVERRIDE="${1#--output-dir=}"
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: tools/adversarial-review/install.sh [--dry-run] [--output-dir PATH]

Renders the parameterized launchd templates under
tools/adversarial-review/deploy/launchd/ into the running operator's
LaunchAgents directory and the repo's scripts/render/ directory, then
runs a postflight validator.

Read DEPLOYMENT-FROM-FRESH-MAC.md for the full five-step path.
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────

failures=()
warnings=()

mark_ok()   { printf '  ✓ %s\n' "$1"; }
mark_fail() { printf '  ✗ %s\n' "$1"; failures+=("$1"); }
mark_warn() { printf '  ! %s\n' "$1"; warnings+=("$1"); }

prompt_with_default() {
  local var_name="$1"
  local default="$2"
  local prompt_label="$3"
  local current
  current="${!var_name:-}"
  if [[ -n "$current" ]]; then
    printf '%s' "$current"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    # No TTY — non-interactive run, take the default.
    printf '%s' "$default"
    return 0
  fi
  local entered
  printf '%s [%s]: ' "$prompt_label" "$default" >&2
  IFS= read -r entered || entered=""
  if [[ -z "$entered" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$entered"
  fi
}

# ── Resolve bindings ───────────────────────────────────────────────────

cd "$SCRIPT_DIR"

DEFAULT_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$DEFAULT_REPO_ROOT" ]]; then
  DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

REPO_ROOT="$(prompt_with_default REPO_ROOT "$DEFAULT_REPO_ROOT" "REPO_ROOT")"
OPERATOR_HOME="$(prompt_with_default OPERATOR_HOME "${HOME:-/root}" "OPERATOR_HOME")"
SECRETS_ROOT="$(prompt_with_default SECRETS_ROOT "$OPERATOR_HOME/.config/adversarial-review/secrets" "SECRETS_ROOT")"
LOG_ROOT="$(prompt_with_default LOG_ROOT "$OPERATOR_HOME/Library/Logs/adversarial-review" "LOG_ROOT")"
REVIEWER_AUTH_ROOT="$(prompt_with_default REVIEWER_AUTH_ROOT "" "REVIEWER_AUTH_ROOT (optional, blank to skip)")"
WATCHER_USER_LABEL="$(prompt_with_default WATCHER_USER_LABEL "local" "WATCHER_USER_LABEL")"

case "$WATCHER_USER_LABEL" in
  *[!A-Za-z0-9._-]*)
    echo "WATCHER_USER_LABEL must match [A-Za-z0-9._-]+ (got: $WATCHER_USER_LABEL)" >&2
    exit 2
    ;;
esac

# ── Pick output paths ──────────────────────────────────────────────────

DEFAULT_LAUNCH_AGENTS_DIR="$OPERATOR_HOME/Library/LaunchAgents"
if [[ $DRY_RUN -eq 1 && -z "$OUTPUT_DIR_OVERRIDE" ]]; then
  OUTPUT_DIR_OVERRIDE="$(mktemp -d -t adversarial-review-dry-run.XXXXXX)/LaunchAgents"
fi
LAUNCH_AGENTS_DIR="${OUTPUT_DIR_OVERRIDE:-$DEFAULT_LAUNCH_AGENTS_DIR}"
RENDER_SCRIPTS_DIR="$REPO_ROOT/scripts/render"

if [[ $DRY_RUN -eq 1 ]]; then
  RENDER_SCRIPTS_DIR="$(dirname "$LAUNCH_AGENTS_DIR")/scripts-render"
fi

WATCHER_PLIST="$LAUNCH_AGENTS_DIR/ai.${WATCHER_USER_LABEL}.adversarial-watcher.plist"
FOLLOW_UP_PLIST="$LAUNCH_AGENTS_DIR/ai.${WATCHER_USER_LABEL}.adversarial-follow-up.plist"
WATCHER_SCRIPT="$RENDER_SCRIPTS_DIR/adversarial-watcher-start.sh"
FOLLOW_UP_SCRIPT="$RENDER_SCRIPTS_DIR/adversarial-follow-up-tick.sh"

# ── Render ─────────────────────────────────────────────────────────────

echo "adversarial-review installer"
echo
echo "Bindings:"
printf '  %-22s %s\n' "REPO_ROOT"           "$REPO_ROOT"
printf '  %-22s %s\n' "OPERATOR_HOME"       "$OPERATOR_HOME"
printf '  %-22s %s\n' "SECRETS_ROOT"        "$SECRETS_ROOT"
printf '  %-22s %s\n' "LOG_ROOT"            "$LOG_ROOT"
printf '  %-22s %s\n' "REVIEWER_AUTH_ROOT"  "${REVIEWER_AUTH_ROOT:-(unset)}"
printf '  %-22s %s\n' "WATCHER_USER_LABEL"  "$WATCHER_USER_LABEL"
echo

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Mode: --dry-run (no files written to ~/Library/LaunchAgents)"
else
  echo "Mode: install"
fi
echo

render_one() {
  local in_path="$1"
  local out_path="$2"
  mkdir -p "$(dirname "$out_path")"
  node "$RENDER_LIB" \
    --in "$in_path" \
    --out "$out_path" \
    --var "REPO_ROOT=$REPO_ROOT" \
    --var "OPERATOR_HOME=$OPERATOR_HOME" \
    --var "SECRETS_ROOT=$SECRETS_ROOT" \
    --var "LOG_ROOT=$LOG_ROOT" \
    --var "REVIEWER_AUTH_ROOT=$REVIEWER_AUTH_ROOT" \
    --var "WATCHER_USER_LABEL=$WATCHER_USER_LABEL"
}

if [[ $DRY_RUN -ne 1 ]]; then
  mkdir -p "$LOG_ROOT"
  chmod 0755 "$LOG_ROOT" 2>/dev/null || true
  if [[ ! -d "$SECRETS_ROOT" ]]; then
    mkdir -p "$SECRETS_ROOT"
    chmod 0700 "$SECRETS_ROOT" 2>/dev/null || true
  fi
fi

echo "Rendering templates:"
render_one "$TEMPLATE_DIR/adversarial-watcher.plist.template" "$WATCHER_PLIST"
mark_ok "wrote $WATCHER_PLIST"
render_one "$TEMPLATE_DIR/adversarial-follow-up.plist.template" "$FOLLOW_UP_PLIST"
mark_ok "wrote $FOLLOW_UP_PLIST"
render_one "$TEMPLATE_DIR/adversarial-watcher-start.sh.template" "$WATCHER_SCRIPT"
chmod +x "$WATCHER_SCRIPT"
mark_ok "wrote $WATCHER_SCRIPT"
render_one "$TEMPLATE_DIR/adversarial-follow-up-tick.sh.template" "$FOLLOW_UP_SCRIPT"
chmod +x "$FOLLOW_UP_SCRIPT"
mark_ok "wrote $FOLLOW_UP_SCRIPT"
echo

# Best-effort plist lint when plutil is present.
if command -v plutil >/dev/null 2>&1; then
  if plutil -lint "$WATCHER_PLIST" >/dev/null && plutil -lint "$FOLLOW_UP_PLIST" >/dev/null; then
    mark_ok "plutil -lint accepted both rendered plists"
  else
    mark_fail "plutil -lint rejected a rendered plist; check the template"
  fi
fi

# ── Postflight ─────────────────────────────────────────────────────────

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry-run complete. Files were written under:"
  echo "  $LAUNCH_AGENTS_DIR"
  echo "  $RENDER_SCRIPTS_DIR"
  echo
  echo "Remove the dry-run flag to install for real."
  exit 0
fi

echo
echo "Postflight:"

# Node engines range check.
if command -v node >/dev/null 2>&1; then
  if (cd "$REPO_ROOT" && node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const range = (pkg.engines && pkg.engines.node) || '';
const major = Number(process.versions.node.split('.')[0]);
if (!range) { console.error('package.json missing engines.node'); process.exit(1); }
if (!(major >= 20 && major < 26)) {
  console.error('Node ' + process.version + ' does not satisfy ' + range);
  process.exit(1);
}
"); then
    mark_ok "Node $(node --version) satisfies package.json engines"
  else
    mark_fail "Node $(node --version) does not satisfy package.json engines (>=20 <26)"
  fi
else
  mark_fail "node not found on PATH; install Node 20+ before bootstrapping the agents"
fi

# gh auth status.
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    mark_ok "gh auth status succeeded"
  else
    mark_fail "gh auth status failed; run 'gh auth login' and retry"
  fi
else
  mark_fail "gh CLI not found on PATH; install GitHub CLI"
fi

# git status --porcelain — warn only.
if command -v git >/dev/null 2>&1; then
  if [[ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
    mark_ok "git working tree clean at $REPO_ROOT"
  else
    mark_warn "git working tree at $REPO_ROOT has uncommitted changes (warning, not blocker)"
  fi
else
  mark_warn "git not on PATH; could not verify working tree state"
fi

# Secret-source token discovery. LAC-597 introduces a formal helper; until
# it lands we degrade by probing $SECRETS_ROOT/adversarial-review.env and
# the legacy op-service-account.env path.
SECRET_SOURCE_HELPER="$REPO_ROOT/src/secret-source/op.mjs"
if [[ -f "$SECRET_SOURCE_HELPER" ]]; then
  mark_ok "secret-source helper present at $SECRET_SOURCE_HELPER"
else
  mark_warn "secret-source helper not found at $SECRET_SOURCE_HELPER (expected after LAC-597 lands)"
fi
if [[ -r "$SECRETS_ROOT/adversarial-review.env" ]]; then
  mark_ok "operator dotenv present at $SECRETS_ROOT/adversarial-review.env"
else
  mark_warn "operator dotenv not present at $SECRETS_ROOT/adversarial-review.env — wrapper will rely on inherited GITHUB_TOKEN / gh auth token"
fi

# Optional REVIEWER_AUTH_ROOT readability.
if [[ -n "$REVIEWER_AUTH_ROOT" ]]; then
  if [[ -r "$REVIEWER_AUTH_ROOT" ]]; then
    mark_ok "REVIEWER_AUTH_ROOT readable at $REVIEWER_AUTH_ROOT"
  else
    mark_fail "REVIEWER_AUTH_ROOT set to $REVIEWER_AUTH_ROOT but not readable"
  fi
fi

echo

if (( ${#warnings[@]} > 0 )); then
  echo "Warnings (not blockers):"
  for item in "${warnings[@]}"; do printf '  - %s\n' "$item"; done
  echo
fi

if (( ${#failures[@]} > 0 )); then
  echo "Postflight failed — resolve the items below before bootstrapping:"
  for item in "${failures[@]}"; do printf '  - %s\n' "$item"; done
  exit 1
fi

# ── Next steps ─────────────────────────────────────────────────────────

cat <<EOF
## Next steps

Bootstrap the watcher:
  launchctl bootstrap gui/\$(id -u) "$WATCHER_PLIST"
  launchctl bootstrap gui/\$(id -u) "$FOLLOW_UP_PLIST"

Verify it loaded:
  launchctl print "gui/\$(id -u)/ai.${WATCHER_USER_LABEL}.adversarial-watcher"

Routine ops:
  launchctl bootout   "gui/\$(id -u)" "$WATCHER_PLIST"
  launchctl bootstrap "gui/\$(id -u)" "$WATCHER_PLIST"
  launchctl kickstart -k "gui/\$(id -u)/ai.${WATCHER_USER_LABEL}.adversarial-watcher"

Logs:
  tail -f "$LOG_ROOT/adversarial-watcher.log"
  tail -f "$LOG_ROOT/adversarial-follow-up.log"
EOF
