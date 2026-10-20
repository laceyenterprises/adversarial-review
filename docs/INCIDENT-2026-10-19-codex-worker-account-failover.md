# LANEFAILOVER-01: review workers kept spending the personal account

On 2026-10-19, the review lane's Codex worker traffic continued using the
personal account as its quota approached exhaustion, while corporate capacity
remained available. The earlier reviewer account change, REVIEWCORPFIRST-01
(PR 1367), was deployed but affected reviewer spawns only. Recent review traffic
used another model, so that change did not redirect the lane's Codex worker
spend. The account-specific worker classes already existed in the consumer
registry, but worker dispatch did not automatically select them from the shared
readiness evidence. This report uses generic descriptions and synthetic examples.

The affected paths were the hammer closer, merge-agent recovery and Codex
remediation. Their class/cross-model fallback resolvers were separate from the
reviewer's corporate-first account resolver. Having capacity on another account
did not itself make that account reachable from an ordinary worker dispatch.
This left closure and remediation exposed to a personal quota cap and manual
pinning even when corporate workers could serve them.

The repair shares the existing account evidence classifier and makes the two
orders explicit: Codex workers use personal until exhausted or not ready, then
corporate; Codex reviewers remain corporate-first. The dispatch wrappers opt
code defaults and builder routing into worker routing while preserving explicit file/env/CLI
class pins and the previous behavior of account-specific classes. The worker
selector holds on unknown evidence or two unavailable accounts. It never treats
stale quota as confirmed exhaustion. Remediation retains account-scoped local
quota evidence as well. Every dispatch reports its account and reason, and the
next dispatch returns to personal when that account recovers. Claude-engine
selection and merge eligibility are unchanged.

Synthetic offline regressions cover personal capacity, provider/model exhaustion,
measured zero headroom, broker unavailability, missing/stale evidence, both
accounts unavailable, explicit pins, return to personal, actual dispatch class
and account logging, and unchanged corporate-first reviewer selection. Historical
cross-model fallback replays remain covered under explicit personal pins.

Deploy the updated watcher and follow-up consumer. Acceptance is a personal
account log while personal capacity is ready, followed by a corporate account
log after confirmed personal exhaustion, with closure continuing through the
ordinary merge gates. No live quota mutation or new operator pin is required.
Deployment acceptance is pending; offline tests cannot establish live broker
readiness or prove production failover.
