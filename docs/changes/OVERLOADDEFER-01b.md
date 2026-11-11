# OVERLOADDEFER-01b

## Summary

Supersedes PR 1814. The watcher owns launch-less overload rescue receipts at
startup and every 30 seconds. Each tick scans at most 100 directory entries
asynchronously and drains queued due receipts before advancing its cursor.
One bounded child submits only PR identity to the companion retry-only rescue
entrypoint, which rechecks live head, review, holds and writer custody.
Deploy the companion before this retry owner.

Live AMA enablement/execution switches gate retries. Unchanged successful
rescues and failed children back off per PR from 30 seconds to 30 minutes.
Removed or ineligible receipts after success count as progress. Receipts
untouched for 24 hours are skipped across restarts; fresh writes restore
eligibility. Queued records are revalidated and broken directory cursors reopen.
Signal cleanup shuts down the hammer queue and aborts rescue before reviewer
cleanup, without waiting on rescue. Child pipe settlement is bounded and all
process exits synchronously send SIGKILL to the recorded active rescue group,
without depending on the SIGTERM grace timer. An unsupported
`--retry-overload-only` diagnostic logs once and suspends retries until watcher
restart after companion deployment. Other child failures keep per-PR backoff.

Helper exhaustion pages once per PR/head, archives the receipt, and releases
the overload hold to ordinary capped closer selection. Only the same job within
30 minutes of the original exhaustion inherits exhaustion without a refund.
Repeated releases do not extend that incident window. A new job or expired
window gets a fresh bounded cycle within existing lifetime caps. Main's
OVERLOADDEFER-01c true-overload threshold remains authoritative, as do head,
lease, strict review, attestation and terminal-state predicates.

The note and its links now follow the canonical `docs/changes/` convention.
The operator plan reads it using the explicit absolute
`ADVERSARIAL_REVIEW_CHECKOUT` deployment path, independently of the working
directory. The state declaration explicitly supersedes the original exhaustion
hold and shared paging contract. Sustained overload can consume the ordinary
attempt budget within minutes during immediate inherited releases. On-call must
expect a possible first-pass SEV1 page burst, one per already-exhausted PR/head;
legacy shared host pages do not deduplicate these pages.

After the normal AR float and watcher/follow-up restart, SRE retains deployed
SHAs and PID start times and observes organic receipt progress within a directory
rotation including queued children, bounded execution and applicable backoff.
Grok remediation routing stays opt-in and disabled by default; no remediator-grok
or hammer-grok vault entry is added. The closer stays refused under the narrowed
scope. This PR performs no live repair, configuration write or restart.

## Interface changes

No persistent store shape, merge predicate, lifecycle enum or smoke promise
changes. The watcher retry owner now suspends unsupported companion calls for
its process lifetime and synchronously kills its recorded group on exit.
The operator plan requires `ADVERSARIAL_REVIEW_CHECKOUT` to identify the deployed
checkout; no live action is executed by this PR.

## Verification

Commands ran through `bash bin/run-bounded.sh --timeout 25 --`:

- `node --test test/overload-rescue-retry.test.mjs test/watcher-sigterm-preserves-reviewers-on-drain.test.mjs` — 26 passed.
- `node --test test/smv.test.mjs` — 11 passed, including the disposable sandbox smoke.
- `node --test --test-name-pattern 'onSpawn|pre-spawn abort|SIGTERM-ignoring' test/process-group-spawn.test.mjs` — four passed.
- `npm run lint` — zero errors, 149 existing warnings.
- `npm run typecheck:contracts` — passed.
- `bash demo/research-finding-walkthrough.sh` — passed with byte-stable deliveries.

`bash bin/run-bounded.sh --timeout 240 -- node test/run-tests.mjs test/watcher-claim-loop.test.mjs`
passed all 168 claim-loop checks under the repository's isolated runner.
`node scripts/validate-data-model-catalog.mjs` validated 93 entries.
`git diff --check` passed. A read-only YAML/command fixture confirmed that the
operator plan reads the same canonical note from both the checkout and `/tmp`;
the Markdown links resolve to that note. Full-suite validation remains owned
by PR-head CI.
