## Summary
This fixture exercises operator-approved current-head provenance.

## Blocking issues
- **Addressable parser cleanup**
  - **Category:** correctness
  - **File:** `src/merge-agent-rescue-classifier.mjs`
  - **Lines:** `55-78`
  - **Problem:** The review would normally require remediation without the override.
  - **Recommended fix:** Keep the parser output stable across watcher refactors.

## Non-blocking issues
- None.

## Suggested fixes
- Preserve the classifier contract asserted by this fixture.

## Verdict
Request changes
