## Summary
The change trims whitespace before greeting. The behavior is small and contained.

## Blocking issues
- None.

## Non-blocking issues
- **No test for padded names**
  - **File:** `lib/greeting.js`
  - **Lines:** `2-3`
  - **Problem:** The new trim has no regression test covering a padded name.
  - **Why it matters:** The behavior could regress unnoticed.
  - **Recommended fix:** Add a test that passes `'  Ada  '`.

## Suggested fixes
Add one padded-name test.

## Verdict
Comment only
