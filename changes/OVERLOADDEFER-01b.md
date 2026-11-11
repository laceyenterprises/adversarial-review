# OVERLOADDEFER-01b

## Summary

Supersedes PR 1827. The watcher owns launch-less overload rescue receipts at
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

This dispatch explicitly requires the note in `changes/`, an exception to the
canonical `docs/changes/` convention. All links point to this fragment.
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

Fresh rewrite validation used runtime Python's
`-m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 600 --command`
under the required netguard PATH, PYTHONPATH and NETGUARD_LOG environment.
Touched test files ran individually and serially with `node --test <file>`;
`bash bin/run-bounded.sh --timeout 600 --` additionally enforced an absolute
process-group deadline for the remaining commands:

| Test file | Passed |
| --- | ---: |
| `test/overload-rescue-retry.test.mjs` | 18 |
| `test/ama-hammer-retry-cap.test.mjs` | 199 |
| `test/overload-deferral.test.mjs` | 8 |
| `test/github-api.test.mjs` | 77 |
| `test/watcher-fast-merge.test.mjs` | 20 |
| `test/watcher-reviewer-timeout-handoff.test.mjs` | 35 |
| `test/watcher-sigterm-preserves-reviewers-on-drain.test.mjs` | 8 |

All 365 tests passed. No full worker-pool or repository test suite ran.
`npx eslint --fix` on the four touched source files and `npm run lint` passed
with zero errors (full lint retained 149 existing warnings).
`npm run typecheck:contracts` passed.
`node scripts/validate-data-model-catalog.mjs` validated 93 entries.
`bash demo/research-finding-walkthrough.sh` passed with byte-stable deliveries.
JSON comparison preserved all unrelated main state/post-merge declarations;
all change-note links resolve. The operator command read this same fragment
from both the checkout and `/tmp`. `git diff --check` passed.

The plain-shell CI mirror and managed push provide publication evidence in
the replacement PR. The mirror entrypoint is supplied by the host tooling
(`scripts/ci-mirror/run-ci-mirror.py`), since this standalone repository has no
copy. Full-suite validation remains owned by PR-head CI. No failing source-PR
check or pre-existing failing gate was observed.
