# SEV2: absolute reviewer lease and no-progress bounds

Ticket: REVIEWERLEASECAP-02. Date: 2026-11-14.
Status: source repair; live recovery unverified.

## Finding and cause

[Phase 0 PR #1883](https://github.com/laceyenterprises/adversarial-review/pull/1883)
is still open. This repair is based on `origin/main`; its diagnostic test is
retained here with repaired expectations. The supplied incident account records
14–18-hour claims, durations of 689–1,030 minutes, and a budget wait holding a
claim for roughly 14 hours. These are historical task-provided observations,
not new measurements. Fixtures contain synthetic inputs only.

The streamed path saturated at three hours, then load-scaled that budget.
The legacy 20-minute resolver was a different path. The generic scaler preserves
oversized nominals, so its maximum argument alone cannot enforce this ceiling.

## Fix

Existing `reviewer.ceiling_max_seconds` now bounds claims and process timers
last, after scaling, explicit requests, chunk/slack composition and sequential
fallbacks. The conservative three-hour default preserves the prior documented
nominal maximum while preventing overnight load extensions. The existing config
path can raise it deliberately; no new schema key is introduced. Gemini's
secondary chunk cap cannot raise it. Historical persisted claims are bounded
from their original start during selection and reattach; identity, confirmed
exit and late posted-review checks still precede release of live orphans.

Model first-output and rolling progress watchdogs now also obey the independent
`reviewer.no_progress_timeout_ms` bound (default 15 minutes). Idle thresholds
no longer grow with host load. Valid Claude events and other model stdout renew
progress; diagnostic stderr cannot, including file-backed capture. Wrapper
forwarding preserves that evidence filter. OAuth wall/idle and proxy upstream
idle timers obey the same bounds. Existing `reviewer-stalled` settlement
releases only its matching claim, without charging retry budgets. Continuous
progress re-arms the watchdog within the outer wall budget.

REVIEWTHROTTLESLEEP-01 typed `github-budget-deferred` receipts retain their reset
hold and budget-neutral release. The outer preparation/posting wrapper does not
guess liveness from silence. No review strictness, merge predicate, CI job,
label, durable status or retry budget changes. The
[change note](../changes/REVIEWERLEASECAP-02.md) records 377 passing synthetic
regressions and scoped checks. No live database, reviewer, daemon or local
configuration changed; deployment observation remains outside this repair.
