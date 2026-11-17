# RDX-00B

## Summary

Reviews on configured public-hygiene repositories use a public-safe addendum
and generic template, omitting operational extra context and attribution blocks.
The final filtered text is scanned before any review-write preparation, including
when retrying a captured body. A hit or unavailable scanner refuses posting,
records a redacted structured hold and raises the existing pipeline alert.
Final comment-only remediation raises scanner output headroom to 1 MiB per
stream and trims surrounding whitespace during case-insensitive repository
matching. Loader validation remains strict.

## Interface changes

Uses the existing `worker_pool.public_hygiene.repos` configuration and
`hq hygiene scan --repo <owner/name> --text-file <path> --json` contract.
Only exit zero with status `clean` permits posting for marked repositories.
No CI checks or live configuration changes are added. Unmarked reviews retain
their existing prompt, template and posting behavior.

## Verification

- Scoped repository runner: `node test/run-tests.mjs public-hygiene.test.mjs reviewer.test.mjs reviewer-fence.test.mjs slim-review-prompt-selection.test.mjs reviewer-generated-review-delivery.test.mjs reviewer-exact-head-post.test.mjs config-public-hygiene.test.mjs` — 329 tests passed, offline.
- `npm run lint` — passed with existing warnings; changed files also passed `eslint --fix`.
- `npm run typecheck:contracts` — passed.
- `bash demo/research-finding-walkthrough.sh` — passed with byte-stable deliveries.

All validation commands ran through the bounded validation runner. Scanner
fixtures contain synthetic values only; no live reviews or review database
were accessed.

Final remediation verification:

- The same seven-file scoped runner passed all 331 tests, including a real
  offline subprocess emitting more than 64 KiB on each output stream and
  whitespace/case matching regressions. The command used
  `env -u CLAUDE_CLI_PATH -u CLAUDE_CODE_CLI_PATH -u CLAUDE_CLI` to remove
  inherited host CLI overrides that caused three unrelated fixture mismatches.
- `npm run lint` passed with zero errors and 149 existing warnings.
- `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- `git diff --check` passed. The full suite is reserved for PR-head CI.
