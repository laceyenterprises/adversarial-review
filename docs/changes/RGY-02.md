# Finding selection read API

`readReviewFindings` accepts repo, PR number/list, finding ID, reviewer model,
harness, prompt digest, inclusive since/exclusive until, literal area prefix,
blocking and label-state filters before keyset pagination. Returned findings
include ordered grade records and graded/disputed indicators. Graded excludes
lifecycle and severity-only observations. Disputed includes conflicting
real/false grades or evidenced withdrawals and can overlap graded. Timestamps
compare instants, and area matching respects path boundaries (or backlog area).
The API remains observational and supports caller-owned read-only connections.
