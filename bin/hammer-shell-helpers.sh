#!/usr/bin/env bash
# HAM_PHASE_OUTCOME assignments are read by the sourcing phase or shell.
# shellcheck disable=SC2034
# Sourced by persisted inputs after dispatch values and the runtime are restored.
ham_gh() { "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/metered-gh.mjs" exec-hammer "$@"; }
ham_git() {
  local ham_git_exit=0
  "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/metered-gh.mjs" exec-git "$@" || ham_git_exit=$?
  # Consumed by the sourcing phase before it releases its lease.
  # shellcheck disable=SC2034
  if [ "$ham_git_exit" -eq 76 ]; then HAM_PHASE_OUTCOME=git-credential-refresh-failed; fi
  return "$ham_git_exit"
}
ham_pr() { "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/hammer-pr-read.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" "$@"; }

# HAMCONFLICTSYNC-01: the bounded fetch helpers every hammer shell needs. The
# closer's own shell, the shipped conflict repair and the rendered verify-head
# phase all sync through these definitions; verify-head keeps a rendered copy
# that test/hamconflictsync-01.test.mjs pins byte-equal to this one.
ham_update_branch_transient() {
  sed '/^\[load-aware-timeout\]/d' "$1" | grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway'
}

ham_is_full_sha() {
  printf '%s' "$1" | grep -Eiq '^[0-9a-f]{40}$'
}

HAM_GIT_SYNC_NOMINAL_SECONDS="${HAM_GIT_SYNC_NOMINAL_SECONDS:-120}"
ham_bounded_git_operation() {
  /usr/bin/perl -e '
      use Errno qw(EINTR);
      my $seconds = shift;
      my $child = fork();
      die "git fetch fork failed: $!" unless defined $child;
      if ($child == 0) { exec @ARGV or die "git fetch exec failed: $!"; }
      my $timed_out = 0;
      $SIG{ALRM} = sub {
        $timed_out = 1;
        kill "TERM", $child;
        alarm 5;
        $SIG{ALRM} = sub { kill "KILL", $child; };
      };
      alarm $seconds;
      my $waited;
      do { $waited = waitpid($child, 0); } while ($waited == -1 && $! == EINTR);
      my $status = $?;
      alarm 0;
      exit($timed_out ? 124 : ($status & 127 ? 128 + ($status & 127) : $status >> 8));
    ' "$@"
}

ham_bounded_git_sync() {
  local ham_git_sync_attempt ham_git_sync_timeout ham_git_sync_stderr ham_git_sync_exit
  ham_git_sync_attempt=1
  while [ "$ham_git_sync_attempt" -le 2 ]; do
    ham_git_sync_timeout=$("$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/load-aware-timeout.mjs" "$HAM_GIT_SYNC_NOMINAL_SECONDS" || true)
    case "$ham_git_sync_timeout" in
      ''|*[!0-9]*|0) ham_git_sync_timeout="$HAM_GIT_SYNC_NOMINAL_SECONDS" ;;
    esac
    echo "HAM: git fetch attempt=$ham_git_sync_attempt deadline=${ham_git_sync_timeout}s" >&2
    ham_git_sync_stderr=$(mktemp "${TMPDIR:-/tmp}/ham-git-sync-${HAM_PR_NUMBER}.XXXXXX") || return 1
    if ham_bounded_git_operation "$ham_git_sync_timeout" env HAM_GIT_SYNC_BOUNDED=1 "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/metered-gh.mjs" exec-git fetch --no-prune --no-tags origin "$@" 2>"$ham_git_sync_stderr"; then
      cat "$ham_git_sync_stderr" >&2
      rm -f "$ham_git_sync_stderr"
      return 0
    else
      ham_git_sync_exit=$?
    fi
    cat "$ham_git_sync_stderr" >&2
    if [ "$ham_git_sync_exit" -eq 76 ]; then
      HAM_PHASE_OUTCOME=git-credential-refresh-failed
      rm -f "$ham_git_sync_stderr"
      return 76
    elif [ "$ham_git_sync_exit" -eq 124 ]; then
      echo "git fetch timed out after ${ham_git_sync_timeout}s; SIGTERM cleanup completed" >&2
    elif ! ham_update_branch_transient "$ham_git_sync_stderr"; then
      rm -f "$ham_git_sync_stderr"
      return 1
    fi
    rm -f "$ham_git_sync_stderr"
    if [ "$ham_git_sync_attempt" -ge 2 ]; then
      return 1
    fi
    sleep 5
    ham_git_sync_attempt=$((ham_git_sync_attempt + 1))
  done
  return 1
}
