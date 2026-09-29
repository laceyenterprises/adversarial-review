# Antigravity Gemini Reviewer Runtime

This runbook covers the Antigravity Gemini reviewer runtime. The live reviewer
path now delegates Antigravity auth and quota behavior to the `agy` CLI, which
uses the per-user macOS keychain generic-password item service `gemini`, account
`antigravity`. The older AGR-01 file-backed OAuth bridge remains documented
below only for legacy credential maintenance; `reviewWithGemini(runtime=antigravity)`
no longer selects bridge accounts, injects per-account access tokens, marks
rate limits, pages all-capped account pools, or emits AGR-06 account telemetry.

## Scope

- `bin/agr-auth.mjs` is the operator CLI.
- `src/auth/antigravity-bridge.mjs` owns PKCE login, refresh-token storage,
  access-token refresh, and credential validation for the legacy file-backed
  bridge only.
- `reviewer.gemini.runtime` selects the Gemini reviewer runtime.
- `reviewer.gemini.runtime: antigravity` invokes
  `agy --print --print-timeout <N> -m <model>` and feeds the review prompt on
  stdin. The print timeout is derived from the reviewer subprocess timeout and
  kept slightly lower than the outer wall clock so capture/cleanup has slack.
- `src/agy-reviewer-auth.mjs` owns the fail-closed pre-flight: first
  `security find-generic-password -s gemini -a antigravity`, then `agy models`.
  Both probes run with the same OAuth-scrubbed env used for the review spawn,
  so `GEMINI_API_KEY` and `GOOGLE_API_KEY` cannot satisfy the probe. The
  default probe timeout is 5s. Timeout-shaped keychain probe failures and
  transient `agy models` transport failures are retried with bounded backoff
  before surfacing an OAuth failure; definitive missing-keychain and
  non-transient probe failures still fail closed immediately. Watcher startup
  runs the same probe as a warning-only visibility check when the runtime is
  `antigravity`, and successful real probes are cached briefly in the process
  that performs the check.
- `agy` may leave a language-server descendant alive after the direct command
  exits, with that descendant still holding inherited stdout/stderr pipes. The
  auth preflight therefore runs `agy models` in a detached process group and
  treats main-process exit as authoritative: after the direct `agy` process
  exits, the runtime kills the group, drains already-buffered stdout/stderr
  until close, and reports the direct process's real output/status instead of a
  synthetic timeout. The live reviewer spawn uses the same contract for
  `agy --print -m <model>` via process-group reaping. Killing descendants is
  safe only for these dedicated AGY probe/review groups after the direct process
  has exited, or when the configured timeout/max-buffer guard has fired.
- Quota and rate-limit handling for the live Antigravity reviewer is whatever
  `agy` returns to the subprocess. The old bridge-level hold decision,
  all-capped page, and per-account rate-limit marking are retired for this
  runtime path.
- Credential validity is asserted by direct JSON file read, schema validation,
  and file-mode checks only when an operator explicitly uses the legacy bridge
  CLI. The live reviewer path does not consume these files.

## Configuration

Set OAuth client configuration at runtime:

```bash
export GEMINI_ANTIGRAVITY_CLIENT_ID='<oauth-client-id>'
export GEMINI_ANTIGRAVITY_CLIENT_SECRET='<oauth-client-secret>'
```

Credential files default to:

```text
~/.gemini/antigravity-bridge/<account-id>.json
```

Override the credential directory with:

```bash
export GEMINI_ANTIGRAVITY_BRIDGE_DIR=/path/to/private/bridge-dir
```

The directory must be mode `0700`. Credential files must be mode `0600`.
Reads reject looser permissions before parsing credential JSON.

### Runtime Selection

The Gemini reviewer defaults to the direct Gemini CLI runtime:

```yaml
reviewer:
  gemini:
    runtime: cli
```

Select the Antigravity runtime:

```yaml
reviewer:
  gemini:
    runtime: antigravity
```

Before spawning a review, the runtime checks that the `gemini`/`antigravity`
keychain item exists and that `agy models` returns non-empty stdout. Transient
timeouts and `agy models` network/transport blips are retried before
escalation. The keychain existence probe is only the fast-path for a truly
absent item; `agy models` is the authoritative readability/ACL check. If the
keychain item is definitively missing, `agy models` returns empty output, or a
non-transient probe failure persists, the reviewer fails closed with an OAuth
error and remediation text matched to the failed probe class.

If `agy models` or `agy --print` appears to return useful output but the caller
hangs until timeout, suspect the inherited-pipe language-server failure mode
first. Do not replace the runtime helper with `execFile`, command substitution,
or another capture primitive that waits for pipe EOF from all descendants. The
expected diagnostic shape after the fix is the direct `agy` result: successful
model output, a normal non-zero `agy` failure, `agy-probe-empty`, or the
configured timeout/max-buffer guard. A recurring `agy-probe-timeout` after the
group-reaping path usually means the direct `agy` process itself failed to exit
inside `AGY_AUTH_PROBE_TIMEOUT_MS`, not merely that an orphaned language server
kept the pipes open.

Troubleshooting logs and remediation surfaces report the probed keychain item as
`keychainItem: gemini/antigravity`. Search for that composite value when
diagnosing an Antigravity reviewer auth failure; the older `Gemini Safe Storage`
item belongs to the desktop app path and is not the live `agy` selector.

Watcher startup also runs this probe when `runtime: antigravity` is configured.
Startup logs a warning on failure rather than refusing to boot; the per-review
probe remains fail-closed. Startup visibility is not a cross-process cache
warmup for reviewer subprocesses. Successful real preflights may be cached
briefly in the process performing the probe; `agy --print` remains the
authoritative reviewer invocation and still fails closed if credential state is
lost inside that short TTL.

Probe knobs:

```bash
export AGY_AUTH_PROBE_TIMEOUT_MS=5000
export AGY_AUTH_PROBE_MAX_ATTEMPTS=3
export AGY_AUTH_PROBE_RETRY_BACKOFF_MS=250
export AGY_AUTH_PROBE_SUCCESS_TTL_MS=60000
```

Env aliases:

```bash
export AGENT_OS_REVIEWER_GEMINI_RUNTIME=antigravity
```

Legacy aliases are also accepted:

```bash
export ADVERSARIAL_REVIEW_GEMINI_RUNTIME=antigravity
```

The historical `reviewer.gemini.antigravity.accounts[]` config remains parsed
for compatibility with older modules, but the live `agy` runtime does not use
it for reviewer dispatch.

### Multiple Reviewer OS Identities (CCX-08)

With `runtime: antigravity`, `reviewer.gemini.identities` lists the OS users
that `agy` reviews may run as, in lease order:

```yaml
reviewer:
  gemini:
    runtime: antigravity
    identities: [<hq-owner>, agentos-reviewer, agentos-reviewer2]
```

If the key is unset, or lists only the HQ owner (the user the watcher runs
as), behavior is unchanged: agy runs directly as the HQ owner, and the Gemini
dispatch cap is the broker credential count. Every other entry is an "added"
identity. The watcher reaches it only through `sudo -n -H -u <user>` and the
root-owned pinned commands CCX-07 installs under
`/usr/local/libexec/agent-os/`. A Gemini review then leases one ready identity
for its whole run. On an added identity, the snapshot is streamed into that
user's 0700 scratch copy, and the scratch copy is removed on every exit path.
`root`, `agentos-worker` and the `AGENT_OS_WORKER_RUN_AS_USER` /
`HQ_WORKER_RUN_AS_USER` user are refused, and the watcher logs the refusal.

**The runtime must be able to carry the identity.** Only a reviewer runtime
that advertises `capabilities.agyReviewerIdentity` passes the leased identity
to the reviewer child. Today that is only `cli-direct`. `agent-runtime` (the
`domains/code-pr.json` default) and `agent-os-hq` do not. On those runtimes the
identities are inert, and the watcher logs this once per runtime:

```text
[agy-identities] reviewer.gemini.identities is set but reviewer runtime <id> cannot run a review as an added identity; ...
```

Gemini reviews on those runtimes stay on the HQ-owner path, with no lease and
the broker cap.

**How the Gemini cap is chosen, per watcher drain:**

A Gemini candidate is one whose reviewer is Gemini, or, on a pipeline-enabled
domain, one with a stage seat whose role runs Gemini. Pipeline stages lease an
identity too, so they count against the cap the same way.

- No added identities, or no Gemini candidate on a leasing runtime: the broker
  credential count, as before.
- Every Gemini candidate on a leasing runtime: the number of *ready*
  identities. The broker is not consulted.
- A mix of both: the lower of the ready count and the broker count.

**Readiness and isolation.** Each drain that has a leasing Gemini candidate
runs `status` and `settings` on the keychain helper for every added identity.
A lease does not depend on that drain: before leasing, the pool runs the same
pass itself when none has run yet, when an added identity has never been
checked, or when the last pass is more than 60s old. The pool-disabled watcher
path (`ADVERSARIAL_REVIEWER_POOL_ENABLED=false`) and pipeline stages lease this
way. The HQ owner is leasable without a pass, as it always was.

An identity is isolated when:

- its keychain or keychain item is missing or unreadable, or its settings file
  is invalid;
- its settings drift from the HQ-owner path's effective agy settings;
- a CCX-07 keychain-bootstrap record marks it not ready;
- a review it ran fails with any failure class other than `cancelled`,
  `stale-review-head`, `daemon-bounce`, or the provider-wide classes
  `cascade`, `provider-overloaded` and `quota-exhausted` (those hit every
  identity at once). A failed review isolates the HQ owner too;
- a review process still runs as that user after its review ended (see
  below);
- a review a previous watcher leased on it is still running (see "Watcher
  restarts" below).

Log lines:

```text
[agy-identities] identity=<user> isolated: <reasons>
[agy-identities] identity=<user> re-admitted
```

An identity isolated by a failed review or a bootstrap record is re-admitted
automatically. This happens once its cheap check passes and a background
`agy models` probe (`probe` on the keychain helper; the auth probe for the HQ
owner) succeeds. No operator step is needed. An identity that stays isolated
lowers the cap by one. Fix the reason in the log line (keychain login,
settings file) and the next drain re-admits it.

**No lease available.** If no identity is ready and free within 5 minutes,
the review does not run. It fails with the transient class
`agy-identity-unavailable`, and its error lists each unready identity with its
reasons. Like `cascade`, it parks the PR in `pending-upstream` on the bounded
infra auto-recovery budget. It is deliberately not `reviewer-timeout`: no
reviewer ran, so it does not count toward the reviewer-timeout merge-agent
handoff.

**Processes the watcher cannot signal.** agy on an added identity runs as
another OS user, and the HQ owner cannot signal that user's processes. So the
process-group reaping that handles agy's leftover language server on the
HQ-owner path does not reach them, and neither does the SIGTERM/SIGKILL on a
timeout. Two things keep this from hanging a review or sharing a HOME:

- The reviewer child captures agy's output through HQ-owner files that agy
  writes via inherited descriptors, not through pipes. A leftover descendant
  therefore cannot hold the capture open, and the review settles when sudo
  exits. If sudo itself outlives a timeout kill, the capture settles 10s after
  the SIGKILL was due anyway and leaves the process running.
- When a lease is released, the watcher lists the processes whose real user is
  that identity (`/bin/ps -U <user> -o pid=,pgid=,comm=`, no privilege
  needed) and keeps only the ones a review started:
  - agy, the pinned `agy-reviewer-agy` wrapper, or agy's language server
    (`antigravity*`, `language_server*`), by process name;
  - anything in the process group of one of those;
  - anything in a process group whose leader is not one of that user's own
    processes, which is every group a pinned command starts through sudo.

  The per-user agents launchd keeps running for a user that has used
  CoreFoundation or Security.framework (`cfprefsd`, `distnoted`,
  `trustd --agent`, `secd`) and any LaunchAgent job lead their own process
  groups, so they never count. If a review process is left, for example a
  language server or an agy that outlived a timeout, the identity is isolated
  as draining. It is not leased again until none are left, and each readiness
  pass checks again. The watcher's own helper calls as that user (`status`,
  `settings`, `probe`, `cleanup`) would look like review processes, so while
  one is running the check is deferred to the next pass. An unreadable answer
  counts as "still running":

```text
[agy-identities] identity=<user> isolated: N review process(es) still running as <user> (<pid> <name>, ...); not leased until they exit
```

The CCX-07 pinned commands have no verb that kills a process as the identity,
so nothing in this module kills survivors. agy's own `--print-timeout` bounds
a surviving agy. A language server that never exits keeps its identity out
until an administrator ends it, for example with
`sudo pkill -KILL -u <user>`. The durable fix belongs in CCX-07's pinned agy
wrapper: run agy in its own process group and SIGKILL that group when agy
exits or the wrapper is signalled.

**Watcher restarts.** `cli-direct` reviewer children survive a watcher bounce.
Every lease is therefore also written into the reviewer run record
(`data/reviewer-runs/<session>.json`, `subjectContext.agyIdentityLease`,
written before the reviewer child is spawned). Every readiness pass reads the
active run records. It keeps an identity out while a review that this watcher
does not hold in memory still runs on it: the record is `launching` with no
process group yet, or its process group is alive. For example, a review
leased by the watcher before a restart:

```text
[agy-identities] identity=<user> review <reviewId> (reviewer session <uuid>) from a previous watcher still runs; not leased until it ends
```

Once that review ends, the pass does what the lease release would have done.
It removes the review's scratch copy and re-probes the identity if the run
record says `failed`. For an added identity, it also runs the survivor check
above. An added identity also starts every watcher's life as draining, so its
first readiness pass runs the survivor check before it can be leased. If the
run records cannot be read, every identity not leased in memory stays out.

**Alerts.** Two conditions page the operator through the alert bus. Each pages
again at most every 15 minutes while it lasts:

- `reviewer.agy_identity_draining`: an identity has been draining (survivors,
  or a review from a previous watcher) for 15 minutes.
- `reviewer.agy_identities_none_ready`: a drain has had Gemini work on a
  leasing runtime and zero ready identities for 15 minutes. The dispatch cap
  is then 0, so no review reaches the lease and nothing else would fail.

Both also log `[agy-identities] ALERT: ...`.

**Startup sweep.** At watcher startup, each added identity's workspace helper
runs `sweep`, which removes leaked scratch copies older than the helper's age
threshold. A non-zero result is logged as
`identity=<user> startup sweep removed N leaked scratch dir(s)`. A failing
sweep only warns; it never blocks startup.

**Bounded extract.** The snapshot `tar` has its own bound. If the workspace
helper exits or fails to spawn before draining the archive (for example
because the review id already exists or the scratch disk is full), `tar` is
killed immediately. The review then fails with `agy-identity-extract-failed`
instead of holding the slot until the reviewer timeout.

## Output Guard And Timeout Behavior

`agy --print` does not expose a quiet, JSON, or final-message-only flag. In
agentic mode it can print planning/tool narration before the final answer. The
bad failure shape seen on PR #2435 was two concatenated attempts under the
Gemini review heading, each made of "I will..." exploration text, one ending in
`Error: timed out waiting for response`, and neither containing `## Verdict`.

The reviewer therefore validates captured AGY output before posting:

- a body must contain a parseable `## Verdict` section that normalizes to
  `Comment only`, `Request changes`, or `Approve`/`Approved`
- narration-only output, `Error: timed out waiting for response`, other AGY
  error sentinel lines, and unparseable bodies raise reviewer failure instead
  of posting a GitHub review
- when a valid review block is preceded by narration, only the review block
  from the review heading or first real `##` section is posted
- inline verdict headings such as `## Verdict: Comment only` are normalized to
  the downstream parser's canonical two-line form before posting

This is intentionally the same operational class as a Claude/Codex subprocess
failure before posting a verdict: the watcher retry and attempt-budget handling
owns recovery, and operators diagnose the failed reviewer attempt rather than
cleaning up a garbage PR review.

The review command's `--print-timeout` is sized from
`reviewer.timeout_ms`. With the default 20 minute reviewer timeout, AGY receives
`--print-timeout 1170s`. If `reviewer.timeout_ms` is lowered, confirm the
derived print timeout still leaves enough time for AGY to finish a real review;
if it is raised, the AGY print timeout rises with it.

## Oversized Prompt Fallback

When an Antigravity prompt exceeds the argv budget, the reviewer first tries
the configured cross-model route for the builder class. If no safe route is
available, it splits the diff into bounded Antigravity chunks. File patches
that must be split by line carry the `diff --git`, file metadata, `---`/`+++`,
and active hunk header on every emitted chunk so the reviewer still has file
and line context.

Merged chunk reviews preserve the parent review contract: the final body has
one `## Summary`, one `## Blocking issues`, one `## Non-blocking issues`, and
one `## Verdict`. Only issue bullets from each child review's matching section
are copied into the merged sections; child summaries, verdicts, and duplicate
headings are not nested into the public review body.

If neither cross-model routing nor chunk fallback can produce a review, the
no-review prevention guard sends the OpenClaw wake-hook alert. Transient
`curl`/transport failures such as timeouts, DNS/TLS/network errors, and
temporary 5xx-class unavailability are retried with a small bounded backoff
before the alert attempt is logged as failed.

## Login

```bash
agr-auth login <account-id> [--project-id <project-id>]
```

The CLI starts a local OAuth callback listener on:

```text
http://localhost:51121/oauth-callback
```

The browser is opened only after the listener reports ready. If the port is
already in use, login fails with `CALLBACK_SERVER_FAILED` and the message names
the occupied callback port.

The stored file schema is:

```json
{
  "email": "user@example.com",
  "refreshToken": "<redacted-refresh-token>",
  "projectId": "optional-project-id"
}
```

## Status

```bash
agr-auth status [account-id]
agr-auth status [account-id] --check-token
```

Default status is read-only: it checks credential presence, JSON schema, and
permissions without refreshing or rotating tokens. Use `--check-token` when an
operator intentionally wants a live refresh-token check.

Without an account id, `status` lists all valid credential files in the bridge
directory and ignores unrelated files.

## Refresh Rotation

`getAccessToken(accountId)` serializes refreshes per credential path:

- in-process callers share one in-flight refresh promise;
- cross-process refreshes use a bounded lock file beside the credential file;
- rotated refresh tokens are persisted with a private temp file plus rename;
- if a rotated refresh token cannot be persisted, the fresh access token is
  still returned and a warning hook or process warning records the persistence
  failure.

If status or reviewer wiring reports `REFRESH_TOKEN_EXPIRED`, re-run login for
that account id. Do not hand-edit refresh tokens.

## Current Non-Goals

- No multi-account scheduler, rotation policy, all-capped hold decision, or
  AGR-06 account telemetry is enabled for the live `agy` runtime.
- No OAuth client secrets are committed to the repository.


CCX-08 final closeout notes:

- Pipeline admission reserves the maximum simultaneous Gemini seats in a panel,
  including detached reviews while their current stage uses another model.
  Actual Gemini spawns replace the reservation rather than double-counting it.
  Pipeline reservations apply only to multi-identity plans; unset/single-owner
  deployments retain their existing admission behavior.
- Added identities carry prompts through the pinned wrapper's `--prompt-stdin`
  protocol. The native `--print` binding is restored after sudo, keeping diffs
  out of sudo COMMAND logs while preserving model selection. Install the Agent OS
  companion wrapper from PR #7386 before enabling multi-identity reviews.
- Captured output is read with a positioned, bounded tail read; the child never
  allocates the entire captured file while settling.
- Config parity: Agent OS Python schema `schema_v1/misc.py` validates the ordered
  identity list with its local-user pattern. The shell loader delegates parsing
  and validation to that Python loader and exports the validated JSON leaves;
  it does not maintain an independent schema for this key. Node keeps its own
  matching schema. The shell's optional-key allowlist does not reject extra
  validated leaves, so no separate shell schema entry is required.
