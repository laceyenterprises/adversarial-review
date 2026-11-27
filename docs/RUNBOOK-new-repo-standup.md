# RUNBOOK — Adversarial Review: new-repo standup

When a new repository should be covered by the adversarial-review pipeline
(first-pass review, remediation, merge-agent, AMA closure), run these steps.

## 1. Watch enrollment — automatic

The watcher **auto-discovers** every non-archived repo in the org via
`octokit.rest.repos.listForOrg` each refresh (`src/watcher.mjs`). A new repo is
picked up on the next refresh with no config change — confirm by looking for it
in the watcher log line `[watcher] Org repos refreshed — watching N repos: …`
(or its per-repo `branch-protection-warning` lines). There is no static repo
allowlist to edit.

## Repositories outside the home org

The home owner is the lowercased `org` in `config.json`, read once per process.
Without an `org`, owner routing is disabled. Home-owner and unknown-owner
requests use the service credential for calls without a repository target.
Non-repository API routes, including bare `orgs/<org>/repos`,
`users/<login>/repos` and `gists/public`, do not select repository authority.
Use explicit `repos/<owner>/<repo>` API paths or GitHub repository URLs when
an owner name matches an API namespace.

A second org needs the corresponding GitHub App installation in the broker's
owner map, managed outside this repository. Configure the App identity for each
role in Agent OS. The GitHub adapter verifies the configured App and the
repository's installation owner.

Enroll the repository in the watched set through the existing repository
registration process; this is what starts automatic review traffic and owner
routing for it. Org discovery alone covers the home org. This change does not
register repositories or change merge authority or merge gates.

`github-owner-token-unavailable` is a GitHub authentication outage for that
request: its role is unknown, routing configuration could not be read, the
broker mint or verification failed. Synchronous callers mint through the adapter
when the exact repository token is cold, with a fixed two-second subprocess cap
that does not grow with host load. No home token or PAT is sent instead. Routed adapter requests name the role and repository. Managed hammer
sessions use their own entitlement path. Follow-up workspace Git and publication
use the capability routes documented in the [follow-up runbook](follow-up-runbook.md#alternate-owner-follow-up-git).
Home merge adapter commands retain their existing authentication route. Routed
merge commands pass the credential's recorded role and repository to the
adapter. They use the merge-agent role in watcher and follow-up broker mode
when the ambient credential has no recorded role. The adapter uses `gh-cli`
with the target installation token, and the parent strips ambient GitHub
tokens from the adapter subprocess.

Home service reads and writes also select `merge-agent` when the corresponding
`WATCHER_GH_AUTH_VIA_BROKER` or `FOLLOW_UP_GH_AUTH_VIA_BROKER` flag is true.
They strip ambient tokens and resolve credentials for each adapter command.
Avoiding repeated broker mints depends on the external adapter's token cache;
`AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR`, when configured, is forwarded to it.
Cache implementation and deployment belong to Agent OS. Environment-token mode
retains its existing route.

Shell launcher seeds also forward the configured cache directory. Their bounded
runner resolves Perl from `PATH`, falling back to `/usr/bin/perl`. Watcher launchers
share the service-repository lookup fallback: a failed lookup logs a warning and
leaves credentials for runtime recovery. Default Node token refreshes cache the
home service repository after the first successful configuration read; restart
the daemon after changing that repository.

Health snapshots retain known, token-free adapter refusal codes (including
`broker-unreachable` and `github-app-token-unavailable`) in their inconclusive
read diagnostics. Arbitrary adapter messages, stderr and token material remain
redacted. Credential failures still defer to the next snapshot.

Asynchronous token subprocesses reserve one ten-second HTTP attempt per distinct
primary/standby broker URL plus one second for startup (21 seconds by default).
`REVIEWER_TOKEN_FETCH_TIMEOUT_MS` can raise that per-URL allowance. Internal adapter
retries are limited to one attempt per URL so a hung primary leaves time for
standby failover; subsequent refreshes use the ordinary daemon retry cadence.
Routed repositories cannot replace the shared home service token or its refresh
clock.

The daemon launchers and default refreshes seed service and reviewer role tokens
against `<home-org>/adversarial-review`. Install each enabled App on that
repository and on the repositories where that role will operate.

Before polling, the watcher's broker refresh records the minted service token's
`merge-agent` role. That provenance
authorizes subsequent owner mints. The shell startup seed alone has no Node
provenance; if refresh fails, it cannot acquire cross-org authority simply by
matching `GITHUB_TOKEN` or `GH_TOKEN`. Home traffic retains the existing
fail-safe refresh behavior.

## 2. Initialize the canonical labels — REQUIRED, not cosmetic

The pipeline **applies and reads** GitHub labels mid-flow — most importantly
`merge-agent-dispatched`, which the watcher adds on every merge-agent dispatch.
A repo the watcher is watching but whose labels are missing fails mid-pipeline:

> 2026-06-19: `foundry#15` merge-agent dispatch errored
> `'merge-agent-dispatched' not found`, and `podium` had **zero**
> adversarial-review labels — so closures could not be dispatched there at all.
> On 2026-06-20, app repos that had only the older adversarial subset were
> missing `retrigger-review`, so merge-agent could not request a fresh watcher
> pass after pushing a rebased branch.

Run the idempotent label initializer:

```bash
# from a full agent-os monorepo checkout, seed the shared PR-control subset:
scripts/init-pr-control-labels.sh --repo laceyenterprises/<repo>

# from this adversarial-review checkout, seed the full adversarial-review superset
# for one or more repos (short names resolve against the org):
scripts/init-adversarial-review-labels.sh foundry podium

# or every non-archived org repo at once:
scripts/init-adversarial-review-labels.sh --all
```

The agent-os initializer seeds the shared PR-control subset. The
adversarial-review initializer is the superset: it includes that subset plus
AMA controls, additive-scope labels, ticket-pipeline pause, and the
`fast-merge:*` classifiers. Run the adversarial-review initializer, or run both,
on any repo that participates in AMA closure or the fast-merge lane. If you are
standing up a standalone adversarial-review checkout without the full agent-os
monorepo on disk, run the adversarial-review initializer directly. Safe to
re-run any time.

Verify:

```bash
gh label list --repo laceyenterprises/<repo> --limit 1000 --json name --jq \
  '(["retrigger-remediation","retrigger-review","merge-agent-requested","merge-agent-dispatched","merge-agent-recovery-in-flight","operator-approved","adversarial-merge-requested","adversarial-merge-blocked","merge-on-comment-only","address-all-findings","merge-agent-skip","do-not-merge","no-auto-merge","no-merge-hold","duplicate-family","duplicate-family-hold","duplicate-family-survivor","duplicate-family-loser","not-a-duplicate-stack","merge-agent-stuck","stale-drift","pr-class: additive-only","operator-approved: scope-expand","reviewer-cycle-cap-reached","paused-for-redesign","operator-approved: advisory-only-review","live-pack-edit-approved","ticket-pipeline-paused","fast-merge-veto","fast-merge:spec-hash-rebind","fast-merge:test-fixtures","fast-merge:submodule-bump"] - map(.name)) as $missing | if ($missing|length)==0 then "ok" else "MISSING: \($missing)" end'
# expect ok
```

## 3. Enforce the canonical merge method (squash-only) — REQUIRED

The fleet treats one PR as one logical ticket, and all automation merges via
`gh pr merge --squash`. If `allow_merge_commit` / `allow_rebase_merge` stay
enabled, manual UI/CLI merges create merge-commits (and rebase merges), giving
the mixed history observed 2026-06-19. Disable them so every merge — automated
or manual — squashes, keeping history linear and the build-completion ledger's
PR↔mergeCommit correlation single-shaped.

Run the idempotent settings initializer:

```bash
# one or more repos (short names resolve against the org):
tools/adversarial-review/scripts/init-repo-merge-settings.sh foundry podium

# or every non-archived org repo at once:
tools/adversarial-review/scripts/init-repo-merge-settings.sh --all
```

Verify:

```bash
gh api repos/laceyenterprises/<repo> \
  --jq '{squash: .allow_squash_merge, merge_commit: .allow_merge_commit, rebase: .allow_rebase_merge}'
# expect squash=true, merge_commit=false, rebase=false
```

## 4. Worker-class title prefixes

PRs must carry a valid `[codex]` / `[claude-code]` / `[clio-agent]` / `[gemini]`
title prefix or they are recorded malformed-terminal and never reviewed (see the
top-level CLAUDE.md "Worker-class title prefixes are non-negotiable"). Nothing to
configure per-repo; this is a contract on the PR author.

## 5. (Optional) Branch protection

If the repo's GitHub plan supports branch protection and you want the
adversarial-gate context required at merge, add it to the target branch's
protection. The pipeline runs without it (the watcher logs a
`branch-protection-warning` and AMA can still close when
`merge_authority.branch_protection.required: false`).
