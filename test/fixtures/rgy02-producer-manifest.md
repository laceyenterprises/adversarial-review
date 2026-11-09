`rgy02-producer-manifest.json` is copied byte-for-byte from the saved output of
`hq osg findings select --name rgy02-producer-contract --review-service <this-repo>
--reviews-db /tmp/rgy02-fixture.Snmi1W/data/reviews.db --json`, with
`HQ_ROOT=/tmp/rgy02-fixture.Snmi1W`, on 2026-11-09. The installed RGY-02 producer
wrote `osg/findings/manifests/rgy02-producer-contract.json` below that temporary
root. No manifest fields were rewritten.

The temporary store was created through this repo's review-state, reviewer-pass
and body-capture APIs with two synthetic blocking findings on `sample/service`
PRs 7 and 8, heads `7` repeated 40 times and `8` repeated 40 times. Both bodies:

```markdown
## Blocking Issues
- **Validate input**
  - **File:** `src/input.mjs`
  - **Lines:** 2
  - **Problem:** Invalid input is accepted.
## Non-blocking Issues
- None.
```

Tests consume only the saved JSON; they do not invoke HQ, Python, network or any
external repository. The metadata timestamp and temporary path are producer
output and do not participate in the findings digest.
