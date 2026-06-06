#!/usr/bin/env bash
# Shared OPH-01 helper for launchd-managed daemons that call `op`.

OP_RATE_LIMIT_SIGNATURE="Too many requests. Your client has been rate-limited"
_OP_RATE_LIMIT_DEFAULT_BACKOFF_S=900

op_rate_limit_stderr_indicates_rate_limit() {
  local stderr_file="$1"
  grep -Eiq 'too[[:space:]-]+many[[:space:]-]+requests|rate[[:space:]_-]*limit(ed)?|http[^[:alnum:]]*429|status[^[:alnum:]]*429|quota' "$stderr_file" 2>/dev/null
}

_op_rate_limit_resolve_backoff_seconds() {
  local raw="${OP_RATE_LIMIT_BACKOFF_S-}"
  if [[ -z "$raw" ]]; then
    printf '%s\n' "$_OP_RATE_LIMIT_DEFAULT_BACKOFF_S"
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  echo "op-rate-limit: OP_RATE_LIMIT_BACKOFF_S=${raw} is not a non-negative integer; using default ${_OP_RATE_LIMIT_DEFAULT_BACKOFF_S}s" >&2
  printf '%s\n' "$_OP_RATE_LIMIT_DEFAULT_BACKOFF_S"
}

op_resolve_with_rate_limit_backoff() {
  if (( $# == 0 )); then
    echo "op_resolve_with_rate_limit_backoff: no command provided" >&2
    return 2
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d -t op-rate-limit.XXXXXX)" || return 1
  local stderr_file="${tmp_dir}/stderr"
  local stderr_fifo="${tmp_dir}/stderr.fifo"
  : > "$stderr_file" || {
    rm -rf "$tmp_dir"
    return 1
  }
  mkfifo "$stderr_fifo" || {
    rm -rf "$tmp_dir"
    return 1
  }

  local rc=0
  local child_pid=""
  local tee_pid=""
  local interrupted_signal=""

  _op_rate_limit_descendant_pids() {
    local parent="$1"
    local child
    pgrep -P "$parent" 2>/dev/null | while IFS= read -r child; do
      [[ -z "$child" ]] && continue
      printf '%s\n' "$child"
      _op_rate_limit_descendant_pids "$child"
    done
  }

  _op_rate_limit_forward_signal() {
    local sig="$1"
    interrupted_signal="$sig"
    if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
      local pid
      local pids=("$child_pid")
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        pids+=("$pid")
      done < <(_op_rate_limit_descendant_pids "$child_pid")
      for pid in "${pids[@]}"; do
        kill "-$sig" "$pid" 2>/dev/null || true
      done
    fi
  }

  trap '_op_rate_limit_forward_signal TERM' TERM
  trap '_op_rate_limit_forward_signal INT' INT
  tee -a "$stderr_file" < "$stderr_fifo" >&2 &
  tee_pid=$!
  "$@" 2> "$stderr_fifo" &
  child_pid=$!
  wait "$child_pid" || rc=$?
  if [[ -n "$interrupted_signal" ]]; then
    wait "$child_pid" 2>/dev/null || true
  fi
  wait "$tee_pid" 2>/dev/null || true
  trap - TERM INT

  if [[ "$interrupted_signal" == "TERM" ]]; then
    rm -rf "$tmp_dir"
    return 143
  fi
  if [[ "$interrupted_signal" == "INT" ]]; then
    rm -rf "$tmp_dir"
    return 130
  fi
  if (( rc == 0 )); then
    rm -rf "$tmp_dir"
    return 0
  fi
  if ! op_rate_limit_stderr_indicates_rate_limit "$stderr_file"; then
    rm -rf "$tmp_dir"
    return "$rc"
  fi

  local backoff_s
  backoff_s="$(_op_rate_limit_resolve_backoff_seconds)"
  rm -rf "$tmp_dir"
  if (( backoff_s == 0 )); then
    echo "op-rate-limit: rate-limit detected; OP_RATE_LIMIT_BACKOFF_S=0, exiting immediately (test/escape hatch)" >&2
    return "$rc"
  fi
  echo "op-rate-limit: 1Password account-level rate-limit detected; sleeping ${backoff_s}s before exit so launchd KeepAlive cannot tight-loop into another op call against the exhausted quota" >&2
  sleep "$backoff_s"
  return "$rc"
}
