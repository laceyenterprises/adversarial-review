# READMESPLIT-01 — Give review contracts dedicated documentation

## Summary

The root README links to dedicated pages for the production pipeline, design,
configuration, hammer, lifecycle and smoke, token pools, no-op outcomes, and
operational behaviors. Historical README change notes are archived together
because they mix ticket notes, PR references and findings follow-ups.

Final comment remediation names `docs/STATE-MACHINES-AND-SMOKE.md` as the root
owner fallback, clarifies the archive's change-note link, corrects the MES-09
superproject handoff URL, and breaks the merge-order syntax example key.
MGQ-01 through MGQ-07 now live together in `docs/production-pipeline.md`,
with a link from the token pool page. Queue contract wording is preserved.

## Interface changes

`state-machines.json` and `post-merge-verify.json` declare the same owner-relative
`documentationPath`. Reviewers, remediators and closers use that page for changes
to the lifecycle and smoke contract. Stale documentation still blocks review.

## Verification

The focused prompt and SMV tests cover the rendered placement rule, diagram
parity and smoke-promise anchors. A one-off local link check covers the root
README and the moved pages.

Final remediation verification:

- `git diff --check` passed.
- A one-off offline Python check confirmed all seven MGQ sections moved
  verbatim, interleaved notes stayed in place, all 19 moved/new links resolve,
  and the named root fallback matches both declarations.
- `bash bin/run-bounded.sh --timeout 30 -- node --test
  test/protective-predecessor-parser-parity.test.mjs` passed both tests.
- A direct parser check confirmed the rendered syntax example declares no hold
  and removing ` (syntax)` declares PR #1234.
- The sandbox runner attempt (`node test/run-tests.mjs
  test/protective-predecessor-parser-parity.test.mjs`) could not load its shared
  preload because this checkout lacks `js-yaml`. The same pure parser tests
  passed directly as recorded above; no full local suite was run.

Hammer CI repair gave the historical README conflict test its own fixture,
checked that the front page links to the current change-note guide, and moved
merge-agent dispatch assertions to the production pipeline page. Canonical
changed-file validation passed all 92 tests on Node 26.10.0.
