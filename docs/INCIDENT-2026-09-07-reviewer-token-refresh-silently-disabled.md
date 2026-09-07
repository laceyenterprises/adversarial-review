# INCIDENT 2026-09-07 — reviewer-bot tokens never refreshed; every review 403'd an hour after each boot

**Severity:** SEV0 (review pipeline could not publish; PRs walked to terminal and stopped merging)
**Detected:** 2026-09-07 ~13:10Z, while draining a 44-PR backlog
**Mitigated:** 2026-09-07 13:19Z (watcher bounced with the three reviewer flags set)

## Impact

Reviews were produced normally and then failed to publish. `POST
/repos/{owner}/{repo}/pulls/{n}/reviews` returned
`403 Resource not accessible by integration`.

- 126 of the observed 403s were on `create-a-review-for-a-pull-request`.
- 141 `GITHUB POST FAILED` events across 41 distinct `agent-os` PRs plus 12 in
  `adversarial-review`.
- `lacey-gemini-reviewer[bot]` last published at **11:10:57Z**; PRs opened after
  that carried no Gemini review at all.

The damage was not the missing review text — it was the accounting. A failed
publish is scored `failure-class=unknown`, which counts against the infra
auto-recovery budget:

```
[watcher] Reviewer unknown-class failure on #6423; counting against attempt budget (1/4)
[watcher] Infra auto-recovery cap exhausted for ...#6368: class=reviewer-command-failed attempts=4/3
```

At 4/3 the PR is terminal and is never retried, so reviewed work stopped
converting into merges. 11 PRs reached the cap in 24h. The open-PR count rose
36 → 44 while merges continued at a trickle.

## Root cause

`refreshReviewerBrokerTokens()` iterates `BROKER_REVIEWER_ROLES` and skips any
role whose `<ROLE>_AUTH_VIA_BROKER` flag is not exactly `"true"`:

```js
if (String(env[flag] || '').trim() !== 'true') {
  summary.skipped.push({ role, reason: 'broker-mode-disabled' });
  continue;                       // silent — nothing logged
}
```

`CLAUDE_REVIEWER_AUTH_VIA_BROKER`, `CODEX_REVIEWER_AUTH_VIA_BROKER` and
`GEMINI_REVIEWER_AUTH_VIA_BROKER` were set **only** in
`launchd/ai.laceyenterprises.adversarial-watcher.airlock.plist`.

The watcher is no longer started by launchd. There is no loaded job for that
label (`launchctl print` → `Could not find service ... 502`; every on-disk copy
of the plist is `.bak`/`.deprecated`). It is started by
`scripts/adversarial-watcher-start.sh`, which sets `WATCHER_GH_AUTH_VIA_BROKER`
but never the three reviewer flags.

So the watcher's **own** `GITHUB_TOKEN` refreshed every tick and kept working —
which is exactly why the failure looked like a reviewer-permission problem
rather than an auth-plumbing one — while all three reviewer-bot tokens were
seeded once at boot and never refreshed. GitHub App installation tokens live
~1h. Roughly an hour into every boot, publication started failing and stayed
failing until the next restart.

Two facts that made this hard to see, and that the fix targets directly:

1. **The skip logged nothing.** A refresh loop that silently refreshes nothing
   is indistinguishable from a healthy one. The log showed
   `[reviewer-broker-refresh] watcher GITHUB_TOKEN/GH_TOKEN refreshed ...` on
   schedule, which read as "token refresh is fine."
2. **The 403 is scored as an unknown infra flake.** A permission/auth fault is
   not retryable, but it consumed the retry budget that decides whether a PR
   stays alive.

### Why it appeared to be a credential permission gap

`lacey-gemini-reviewer[bot]` had published successfully on several PRs, so the
App plainly held `pull_requests: write`. The same PR could show both a
successful review and later 403s. That is the signature of a token aging out
mid-life, not of a missing grant — the discriminator was that successes stop at
a fixed wall-clock time after each boot, not on a fixed set of PRs.

## Prior art

`watcher-tick-preflight.mjs` already documents SEV0 2026-09-06, where the same
token expired *inside* a single long tick and every `gh` call failed 401. That
fix moved the refresh onto a wall-clock. It was correct and is not implicated
here: the refresh was on the right clock, it just never ran for these roles.

## Fix

1. `scripts/adversarial-watcher-start.sh` defaults all three reviewer flags to
   `true` and exports them, mirroring how `WATCHER_GH_AUTH_VIA_BROKER` is
   already handled. The flag now lives with the start path that actually runs,
   not only in a plist that no longer executes.
2. `src/reviewer-broker-refresh.mjs` logs a loud warning, once per role per
   process, when a role is skipped `broker-mode-disabled` — naming the env var,
   the ~1h expiry, and the 403 it produces.

## Verification

Before the fix the broker served reviewer tokens only when a review happened.
After bouncing with the flags set, the broker served all three reviewer roles at
boot — i.e. the refresh loop is now actually iterating them:

```
token.served provider=github-app-claude-reviewer  ts=13:20Z
token.served provider=github-app-codex-reviewer   ts=13:20Z
token.served provider=github-app-gemini-reviewer  ts=13:20Z
```

`#6422` had no Gemini review before the bounce and received one at 13:17:11Z
after it.

Unit-level: with an empty env, `refreshReviewerBrokerTokens` skips all three
roles and emits exactly three warnings across two calls (warn-once per role);
with `GEMINI_REVIEWER_AUTH_VIA_BROKER=true`, `gemini-reviewer` is no longer
skipped.

## Follow-ups (not in this PR)

- Classify `403 Resource not accessible by integration` on review-create as its
  own non-retryable failure class so an auth fault cannot consume the infra
  auto-recovery budget and strand PRs at the 4/3 cap.
- Reconcile the launchd plist with the start-script path, or delete the
  deprecated plists. Env that matters is currently split across a file that runs
  and a file that does not.
- Sweep the PRs already terminal at the recovery cap; `retrigger-review
  --allow-failed-reset` is the sanctioned recovery.
