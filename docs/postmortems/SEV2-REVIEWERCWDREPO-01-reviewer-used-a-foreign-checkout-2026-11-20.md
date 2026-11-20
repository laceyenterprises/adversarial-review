# SEV2 — reviewer used a foreign checkout

Date: 2026-11-20. Follow-up: REVIEWERCWDREPO-01.

## Impact

Reviews of sibling repositories could lack local code evidence or publish
references to a private deployment tree. In a read-only sample of 60 public
sibling PRs, three automated reviews cited paths or module names from the
private tree. A separate sample of seven private sibling PRs showed diff-only
reviews and contained zero citations to the deployment tree. These samples
establish exposure and degraded grounding. They do not measure total impact.

## Cause

The reviewer selected its own checkout for a repository name ending in the
service suffix. Every other name selected the deployment superproject. The
snapshot archived that checkout's current `HEAD`, even when the PR belonged
to a different repository or the requested commit was missing.

For example, a review of `example/public-widget` could inspect
`internal/example-module/index.js` from `example/private-deploy`. Both
repository names and the file path in this example are synthetic.

## Correction and evidence

Reviewer and Argus lookup now require a full GitHub origin match. The reviewer
archives the requested SHA and reports an empty diff-only workspace when the
source or commit cannot be materialized. Generated reviews without current
workspace provenance are ineligible for redelivery.

Offline regressions cover both deployment paths, a sibling clone fetched at a
commit other than its checkout HEAD, an unavailable commit, and a public
target with a private checkout at a candidate path. Fixtures use temporary
local repositories. This records source correction and offline coverage.
Previously published review bodies and deployed recovery were outside the
scope of the change.
