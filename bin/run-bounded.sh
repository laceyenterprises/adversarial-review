#!/usr/bin/env bash
# exec keeps the cancellable supervisor at the caller's recorded PID.
exec "${HAM_NODE_BIN:-node}" "$(dirname "$0")/run-bounded.mjs" "$@"
