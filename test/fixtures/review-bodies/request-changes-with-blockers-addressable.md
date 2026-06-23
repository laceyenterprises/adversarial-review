## Summary
Two addressable blocking findings remain in the classifier.

## Blocking issues
- **Normalize stale-review routing**
  - **Category:** correctness
  - **File:** `src/merge-agent-rescue-classifier.mjs`
  - **Lines:** `88-112`
  - **Problem:** The stale-review branch evaluates after the merge-eligible fast path, so an older review can route incorrectly.
  - **Recommended fix:** Check `reviewHeadSha` against `headSha` before any merge/remediation routing.
- **Cover the override persistence branch**
  - **Category:** test-coverage
  - **File:** `test/merge-agent-rescue-classifier.test.mjs`
  - **Lines:** `90-120`
  - **Problem:** Same-head re-review persistence is not asserted, so the override contract can drift silently.
  - **Recommended fix:** Add a fixture-backed test for same-head operator-approved persistence.

## Non-blocking issues
- None.

## Suggested fixes
- Preserve the classifier contract asserted by this fixture.

## Verdict
Request changes
