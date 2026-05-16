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
