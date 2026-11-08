# GHBUDGET-01

Lifecycle polling now revalidates PR head/state through authenticated REST
conditional requests. An unchanged response uses a matched ETag/body after a
304 rather than spending primary quota on another full head read. Fresh
responses still own head changes and merged/closed terminal transitions.

Closer identity and hammer merge-precondition reads enter the existing urgent
budget scope. Polling retains its existing floor; an exhausted or explicitly
limited bucket still refuses critical reads. Tokens whose App/installation
identity the broker verified share the same budget key across rotations.

API telemetry identifies its calling consumer and counts actual HTTP responses
separately from logical attempts. Child adapters inherit that consumer tag.
Each poll logs known installation balances and persists deficit episodes,
alerting once after more than 15 minutes below the polling floor. Healthy
observations rearm the alert; restarts retain its receipt.

Synthetic tests simulate 60 unchanged polls: 60 full reads before, one initial
200 plus 59 budget-exempt 304s after (98.3% fewer charged reads for this path).
Live savings require the declared two-hour SRE receipt after deployment.
