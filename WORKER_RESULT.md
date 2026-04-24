## Result

- Updated branch: `codex/lac-210-trigger-rereview-from-replies`
- Commit pushed: `2a20b86` (`[codex] LAC-210 trigger rereview from remediation replies`)
- Push remote: `origin/codex/lac-210-trigger-rereview-from-replies`

## What Changed

- Added durable review-state handling in `src/review-state.mjs` so remediation follow-up logic can explicitly reset watcher delivery rows back to `review_status = 'pending'`.
- Updated `src/follow-up-remediation.mjs` reconciliation to:
  - read and validate the remediation reply artifact
  - fail closed on invalid reply artifacts
  - trigger watcher-visible adversarial re-review when `reReview.requested = true`
  - preserve blocked re-review outcomes explicitly on the completed follow-up job instead of forcing malformed/closed paths
- Added reconciliation coverage for:
  - successful re-review trigger
  - blocked malformed-title re-review requests
  - invalid remediation reply artifacts
- Updated `README.md` and `SPEC.md` to match the landed LAC-210 behavior and operator recovery semantics.

## Tests Run

- Passed:
  - `npm test -- test/follow-up-remediation.test.mjs test/follow-up-reconcile.test.mjs test/watcher-retry-semantics.test.mjs`

## Push Status

- `git push -u origin codex/lac-210-trigger-rereview-from-replies` succeeded

## PR Blocker

- `gh pr create --base main --head codex/lac-210-trigger-rereview-from-replies --title "[codex] LAC-210 trigger rereview from remediation replies" ...` failed locally with:
  - `failed to create root command: failed to read configuration: open /Users/placey/.config/gh/config.yml: permission denied`
- Branch is pushed, but PR creation from this clone is blocked by local `gh` config permissions.
