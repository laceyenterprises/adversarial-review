# READMESPLIT-01 — Give review contracts dedicated documentation

## Summary

The root README links to dedicated pages for the production pipeline, design,
configuration, hammer, lifecycle and smoke, token pools, no-op outcomes, and
operational behaviors. Historical README change notes are archived together
because they mix ticket notes, PR references and findings follow-ups.

## Interface changes

`state-machines.json` and `post-merge-verify.json` declare the same owner-relative
`documentationPath`. Reviewers, remediators and closers use that page for changes
to the lifecycle and smoke contract. Stale documentation still blocks review.

## Verification

The focused prompt and SMV tests cover the rendered placement rule, diagram
parity and smoke-promise anchors. A one-off local link check covers the root
README and the moved pages.
