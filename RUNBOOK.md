# Adversarial Review Runbook

## Test coverage requirements

SQL-contract tests are necessary but not sufficient for the watcher hot path. The 2026-05-11 outage showed that a query-level assertion can stay green while `src/watcher.mjs` fails at runtime before the reviewer claim can progress.

Any change touching the per-subject loop in `src/watcher.mjs` or reviewer follow-up flow in `src/follow_up.mjs` / `src/follow-up*.mjs` must update or re-run `test/watcher-claim-loop.test.mjs`. That test imports the real watcher module and drives the typed subject-adapter loop with synthetic GitHub, SQLite, and subject fixtures.

Before merging watcher-loop changes, run the regression verification against the historical buggy commit:

```bash
test -z "$(git status --porcelain --untracked-files=all)" || {
  echo "working tree is dirty; stash or commit changes before running the regression check" >&2
  exit 1
}
git fetch origin
git worktree add ../watcher-claim-loop-regression e664a4e
cp test/watcher-claim-loop.test.mjs ../watcher-claim-loop-regression/test/watcher-claim-loop.test.mjs
(cd ../watcher-claim-loop-regression && node --test test/watcher-claim-loop.test.mjs)
git worktree remove ../watcher-claim-loop-regression
```

The historical case is documented in `docs/POSTMORTEM-adversarial-pipeline-down-2026-05-11.md` in the parent `agent-os` repository. The expected failure mode on `e664a4e` is `ReferenceError: pr is not defined`; the expected result on current code is a passing claim-loop test.

Install the local pre-commit hook once per checkout:

```bash
bash scripts/install-githooks.sh
```

The hook runs ESLint on staged `.mjs` / `.js` files under `src/`.

## Public-hygiene reviews

Repositories in `worker_pool.public_hygiene.repos` use a public-safe prompt
addendum and a generic posted header without operational attribution, audit
links or identifiers. Extra operational prompt context is omitted. Configure
this list through the existing configuration loader; repository names are never
embedded in the reviewer.

Immediately before writing a review, the pipeline invokes
`hq hygiene scan --repo <owner/name> --text-file <temporary-file> --json` on the
complete filtered body. Only a successful `clean` result permits posting.
Hits, missing scanners, malformed responses and configuration failures hold
posting and raise the existing operator alert. The structured
`reviewer.public_hygiene_hold` event records a class and numeric line/rule
locations without matched values. Repair the text, private scanner configuration
or CLI availability and retry the review. Temporary text files are private and
removed after scanning. Unmarked repositories retain their existing behavior.
