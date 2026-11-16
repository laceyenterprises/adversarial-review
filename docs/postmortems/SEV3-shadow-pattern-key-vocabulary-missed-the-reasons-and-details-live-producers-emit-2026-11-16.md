# SEV3: Shadow pattern vocabulary missed fixed producer text

## What happened

Roughly half of about 5,600 shadow divergences were unkeyable, forcing
individual triage instead of allowing reviewed exact-pattern dispositions.
About 2,400 non-error rows carried missing fixed classes. Expanding the
vocabulary was projected to make about 2,300 of those rows keyable.

## Cause and fix

The reason allowlist was copied from eligibility, missing the wrapping
workflow layer. The detail allowlist covered a sample rather than the fixed
next-action rows and legacy adapters. The fix explicitly enumerates their
literal classes, including the two bounded live-owner actors, while preserving
the versioned key format and exact matching. Synthetic regressions cover
re-keying history, evidence admission, report buckets and exclusions.

## Limits

Reports re-key history at read time; dispositions are not applied retroactively.
Only future matching appends capture a reviewed pattern disposition, using the
new vocabulary after the normal watcher reload. Fold errors stay ineligible
for pattern application, and dynamic reasons stay unkeyable. This change
does not clear the historical backlog or change promotion arithmetic.
