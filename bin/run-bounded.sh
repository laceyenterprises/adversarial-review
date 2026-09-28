#!/usr/bin/env bash
# Run one foreground command with a wall-clock limit and a bounded transcript.
set -u
seconds=900
bytes=4096
while [ "$#" -gt 0 ]; do
  case "$1" in
    --timeout) seconds="$2"; shift 2 ;;
    --tail-bytes) bytes="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo 'usage: run-bounded.sh [--timeout seconds] [--tail-bytes bytes] -- command [args...]' >&2; exit 64 ;;
  esac
done
if [ "$#" -eq 0 ] || ! [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || ! [[ "$bytes" =~ ^[1-9][0-9]*$ ]] || [ "$bytes" -gt 8192 ]; then
  echo 'run-bounded: command, positive timeout, and tail bytes 1..8192 required' >&2
  exit 64
fi
log=$(mktemp "${TMPDIR:-/tmp}/run-bounded.XXXXXX") || exit 1
trap 'rm -f "$log"' EXIT
/usr/bin/perl -e '
  use POSIX qw(:sys_wait_h);
  my $seconds = shift;
  my $child = fork();
  die "fork failed: $!" unless defined $child;
  if ($child == 0) {
    POSIX::setpgid(0, 0) == 0 or die "setpgid failed: $!";
    exec @ARGV;
    die "exec failed: $!";
  }
  my $timed_out = 0;
  $SIG{ALRM} = sub {
    $timed_out = 1;
    kill "TERM", -$child;
    alarm 5;
    $SIG{ALRM} = sub { kill "KILL", -$child; };
  };
  alarm $seconds;
  my $waited;
  do { $waited = waitpid($child, 0); } while ($waited == -1 && $! == EINTR);
  my $status = $?;
  alarm 0;
  if ($timed_out) {
    select undef, undef, undef, 0.2;
    kill "KILL", -$child;
  }
  exit($timed_out ? 124 : ($status & 127 ? 128 + ($status & 127) : $status >> 8));
' "$seconds" "$@" >"$log" 2>&1
status=$?
tail -c "$bytes" "$log"
printf '\n'
exit "$status"
