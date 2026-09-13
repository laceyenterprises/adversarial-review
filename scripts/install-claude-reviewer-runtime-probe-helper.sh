#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_SOURCE="${CLAUDE_REVIEWER_RUNTIME_PROBE_HELPER_SOURCE:-${SCRIPT_DIR}/libexec/claude-reviewer-runtime-probe}"
HELPER_DEST="${CLAUDE_REVIEWER_RUNTIME_PROBE_HELPER_DEST:-/usr/local/libexec/agent-os/claude-reviewer-runtime-probe}"
SUDOERS_DEST="${CLAUDE_REVIEWER_RUNTIME_PROBE_SUDOERS_DEST:-/etc/sudoers.d/40-agent-os-claude-reviewer-runtime-probe}"
RUNTIME_USER="${CLAUDE_REVIEWER_RUNTIME_PROBE_SUDO_USER:-${1:-${SUDO_USER:-${USER:-}}}}"

sudoers_escape_command_path() {
  local escaped="${1//\\/\\\\}"
  printf '%s' "${escaped// /\\ }"
}

if [[ -z "${RUNTIME_USER}" ]]; then
  echo "error: runtime sudo user is required" >&2
  echo "usage: $0 <runtime-user>" >&2
  exit 64
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "error: run as root, for example: sudo -n $0 ${RUNTIME_USER}" >&2
  exit 77
fi

if [[ ! -x "${HELPER_SOURCE}" ]]; then
  echo "error: helper source is missing or not executable: ${HELPER_SOURCE}" >&2
  exit 66
fi

install -d -o root -g wheel -m 0755 "$(dirname "${HELPER_DEST}")"
install -o root -g wheel -m 0755 "${HELPER_SOURCE}" "${HELPER_DEST}"

SUDOERS_HELPER_DEST="$(sudoers_escape_command_path "${HELPER_DEST}")"
tmp="$(mktemp "${SUDOERS_DEST}.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
cat >"${tmp}" <<EOF
${RUNTIME_USER} ALL=(root) NOPASSWD: ${SUDOERS_HELPER_DEST} *
EOF
chmod 0440 "${tmp}"
/usr/sbin/visudo -cf "${tmp}" >/dev/null
install -o root -g wheel -m 0440 "${tmp}" "${SUDOERS_DEST}"

echo "installed ${HELPER_DEST}"
echo "installed ${SUDOERS_DEST}"
