# Adversarial Review Runbook

## Test coverage requirements

SQL-contract tests are necessary but not sufficient for the watcher hot path. The 2026-05-11 outage showed that a query-level assertion can stay green while `src/watcher.mjs` fails at runtime before the reviewer claim can progress.

Any change touching the per-subject loop in `src/watcher.mjs` or reviewer follow-up flow in `src/follow_up.mjs` / `src/follow-up*.mjs` must update or re-run `test/watcher-claim-loop.test.mjs`. That test imports the real watcher module and drives the typed subject-adapter loop with synthetic GitHub, SQLite, and subject fixtures.

Before merging watcher-loop changes, run the regression verification against the historical buggy commit:

```bash
git fetch origin
git checkout e664a4e
git checkout <your-branch> -- test/watcher-claim-loop.test.mjs
node --test test/watcher-claim-loop.test.mjs
```

The historical case is documented in `docs/POSTMORTEM-adversarial-pipeline-down-2026-05-11.md` in the parent `agent-os` repository. The expected failure mode on `e664a4e` is `ReferenceError: pr is not defined`; the expected result on current code is a passing claim-loop test.

Install the local pre-commit hook once per checkout:

```bash
bash scripts/install-githooks.sh
```

The hook runs ESLint on staged `.mjs` / `.js` files under `src/`.
