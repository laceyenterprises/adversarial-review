# INCIDENT 2026-10-11 — first review waits behind a single Gemini slot

**Tracking:** REVIEWAGE-02
**Observed:** 2026-10-11 05:28Z SRE tick
**Primary surfaces:** watcher reviewer admission and queue-depth spillover

## Impact and evidence

Operator at approximately 05:26Z: "We have a or that's 34 minutes without a
first review" (referring to a PR).

- Agent OS PR 8056 opened at 04:52Z and still had no review at 05:28Z
  (36 minutes). PR 8057 opened at 05:16Z and also had no review.
- Deployment `reviewer.gemini.mode: always-on` replaced Claude or Codex with
  Gemini. The last 12 MB of watcher logs contained 270 Gemini spawns,
  52 Codex spawns and 26 Claude spawns.
- Gemini had one credential. In 6 MB of logs there were 301 dispatch deferrals
  with `reason=gemini-credential-concurrency-saturated`;
  `max_observed_concurrency=2`.
- The first-pass failover logged `depth=1 threshold=2 spill_slots=0` and
  disengaged. Re-reviews of PR 8044, PR 8051, PR 8053, PR 8055 and
  adversarial-review PR 1261 competed for the same credential.
- PR 8056 obtained Claude only after a Gemini attempt failed around 05:25Z:
  `Claimed infra-failed review … (class=reviewer-command-failed, infra attempt 1/3)`.
  These observations come from separate log snapshots; the precise ordering
  of the 05:25Z attempt and 05:28Z no-review observation is not established.

## Root cause

Depth pressure cannot bound a lone request's wait. First-pass depth excludes
re-reviews even though both lanes consume the same Gemini credential.
The pool enqueue timestamp also restarted each discovery tick, so it could
not represent the durable current-head request's wait.

## Correction

On Gemini credential saturation, requests older than 480 seconds for first
pass or 900 seconds for re-review use the replaced reviewer class, subject to
existing writer diversity, credential eligibility and quota rules. Wait starts
at the persisted current-head request marker, never the PR creation time.
Each wait spill logs PR, pass kind, wait seconds and destination class.

The two existing depth lanes remain separate. Their durable counts include
credential-deferred pending requests; the re-review count now also includes
`pending-upstream` admission requests. No combined depth or config key is added.

The module bounds accept environment overrides
`ADVERSARIAL_REVIEW_FIRST_PASS_REVIEW_MAX_WAIT_SECONDS` and
`ADVERSARIAL_REVIEW_REREVIEW_MAX_WAIT_SECONDS`; zero disables each bound.
Invalid values fall back to the defaults. Deployment mode and defaults are unchanged.

## Follow-up

Promoting these bounds to config keys requires parity with the Agent OS Python
schema and shell loader as well as this repository's Node loader. That work
is outside this one-repository correction. No CI check or merge gate is added.
