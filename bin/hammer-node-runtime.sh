#!/usr/bin/env bash
# Shared by phase entrypoints and persisted inputs.sh; no Node bootstrap needed.
ham_resolve_node_runtime() {
  local candidate="${HAM_NODE_BIN:-}"
  if [ -z "$candidate" ]; then
    candidate="${AGENT_OS_NODE_BIN:-}"
    if [ -z "$candidate" ]; then
      candidate=$(command -v node 2>/dev/null || true)
    fi
  fi
  # Explicit pins fail visibly instead of silently selecting another runtime.
  case "$candidate" in
    /*)
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        export HAM_NODE_BIN="$candidate"
        return 0
      fi ;;
  esac
  unset HAM_NODE_BIN
  # Consumed by the sourcing phase and its failure-audit wrapper.
  # shellcheck disable=SC2034
  HAM_PHASE_OUTCOME=node-runtime-unavailable
  echo 'HAM hard-blocker: node-runtime-unavailable: HAM_NODE_BIN must resolve to an absolute executable file (HAM_NODE_BIN, AGENT_OS_NODE_BIN, or PATH node)' >&2
  return 1
}
ham_resolve_node_runtime
