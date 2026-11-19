# V1RATCHET-01

## Summary

The reviewer simplicity check gains the V1 growth ratchet that the 2026-11-11
architecture review (§10.1) and the 2026-11-18 audit (§8 item 7) proposed.
It is audited, not gated. The reviewer prompt's extra context carries a short
`## V1 growth (audited, not gated)` section with net non-test lines per frozen
V1 subsystem; that section is not posted in the GitHub review. When a fix grows
a subsystem that a pack owns, the prompt asks the reviewer to use the optional
`## Simplicity and cost (advisory)` section in the posted review to request a
matching deletion or a move into that pack's ticket.

## Interface changes

- `domains/code-pr.json` `v1GrowthRatchet.subsystems`: repo, path prefixes and
  owning pack per V1 subsystem. The first matching subsystem wins. Paths and owners
  are tunables. To add an owner when a pack is promoted, change this file only.
- `src/v1-growth-ratchet.mjs` measures and formats the section.
  `buildReviewerExtraContext` adds it in full and slim modes, but not in
  public-hygiene mode.
  Measurement and formatting are asynchronous: cross-subsystem renames read
  destination contents at the immutable reviewed head and reconstruct the source
  line count from the hunk delta. Copies retain their source. Same-subsystem
  renames use only hunk changes. Test paths use the existing slim classifier,
  with the existing `fixtures/` exclusion retained. A missing head, failed read
  or non-text content reports unknown growth and retains the optional advisory
  ask instead of reporting zero. These reads have an injectable fixture seam;
  they introduce no persistent state or lifecycle/smoke change.
  Measurement and formatting are asynchronous. Test paths use the shared
  `isTestPath` classifier (including `.spec.*`, `spec/`, `specs/`, `testdata/`
  and `__fixtures__/`), with `fixtures/` also excluded.
  Renames across subsystem or test/production boundaries read the destination
  at the immutable reviewed head through `fetchRepoFileAtRef`; its full line
  count and the hunk delta determine source removals and destination additions.
  Same-subsystem renames retain hunk-only accounting without a content read;
  copies count destination additions without subtracting the retained source.
  Missing heads, failed reads and non-text content report unknown net growth
  and retain the fix advisory for affected pack-owned subsystems. These reads
  never add a merge gate. Tests inject content readers and remain offline.
- The shared simplicity guidance lists the V1 growth ask as one more reason to
  write the advisory. It is still never a finding, verdict input, round or gate.

## Verification

`node test/run-tests.mjs` ran on the new test and every test file that touches
the reviewer prompt, the domain config or the simplicity guidance: 67 files,
1,853 passed, 0 failed.

Remediation: `node --test test/v1-growth-ratchet.test.mjs` passed (3 tests);
`npm run lint` passed (0 errors), `npm run typecheck:contracts` passed, and
`git diff --check` passed.

Final comment-only remediation: 51 tests passed across
`test/v1-growth-ratchet.test.mjs`, `test/slim-review-prompt-selection.test.mjs`,
`test/reviewer-file-inventory.test.mjs`, `test/reviewguard-context.test.mjs`,
`test/code-pr-security-domain.test.mjs` and
`test/research-finding-end-to-end.test.mjs`. The offline Git fixture covers
200-line moves into and out of a subsystem and a move with edits. Additional
cases cover recognized test paths, test/production moves, retained copy sources,
unavailable contents, empty files, final-newline handling and reviewed-head
binding in full/slim prompt context.
`npm run lint` passed (0 errors, 149 existing warnings),
`npm run typecheck:contracts` passed,
`bash demo/research-finding-walkthrough.sh` passed, and `git diff --check` passed.
The full suite is left to PR-head CI.
