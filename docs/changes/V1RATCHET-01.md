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
- The shared simplicity guidance lists the V1 growth ask as one more reason to
  write the advisory. It is still never a finding, verdict input, round or gate.

## Verification

`node test/run-tests.mjs` ran on the new test and every test file that touches
the reviewer prompt, the domain config or the simplicity guidance: 67 files,
1,853 passed, 0 failed.

Remediation: `node --test test/v1-growth-ratchet.test.mjs` passed (3 tests);
`npm run lint` passed (0 errors), `npm run typecheck:contracts` passed, and
`git diff --check` passed.
