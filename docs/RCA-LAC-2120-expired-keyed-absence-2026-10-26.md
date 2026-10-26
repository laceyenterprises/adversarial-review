# SEV3 / LAC-2120: expired intent absence authorization gap

Observed 2026-10-26 19:45–20:05 UTC. Incident:
[LAC-2120](https://linear.app/laceyenterprises/issue/LAC-2120).
The canonical [Agent OS RCA](https://github.com/laceyenterprises/agent-os/blob/main/docs/postmortems/SEV3-expired-closer-grant-filtered-absence-2026-10-26.md)
records the bounded incident evidence and producer repair. This companion owns
consumer acceptance and durable query/audit provenance.

At 20:02:47 UTC, Agent OS #9445 and #9448 retained expired keyed
`dispatching/submitting`, `inspection-required` intents without LRQ receipts.
Their public reason detail was `dispatch absence scope unproven`. Trusted owner
exact-key no-row reads in
`/private/tmp/os-rescue-20261026-194536/key-probes.jsonl` were insufficient to
replace the consumer's grant-filtered scope. Bounded reads of only the native
per-PR records confirmed retained deadlines and safe holds. None was mutated.

Root cause: the public producer lacked an authorized global absence contract;
the consumer's refusal was correct. LAC-2081 native recovery/fencing,
LAC-2096 schema-compatible identity, LAC-2113 controller identity and LAC-2118
SDK rollout hold boundaries were read and preserved. Related issue comments
and open-PR searches found no existing exact-gap fix. No changes to the
root-owned #1550/#1555 branches/jobs or held #7392 were made.

The [recovery contract](dispatch-absence-recovery.md) consumes only an exact,
expiring operator-authorized selector-bound negative fact emitted by the public
canonical producer. It retains the proof in intent query and operator audit.
The producer alone reads unfiltered rows; app row grants stay intact. Ordinary
empty, hidden/foreign, partial, malformed or unreadable evidence stays held.
A positive matching launch still recovers through native receipt adoption;
operator settlement refuses it. Both key and whole ticket/time proofs remain
required for the operator's expired keyed settlement. No state destination,
locking algorithm, submitter/deadline rule, retry budget, fallback reader,
production flag or merge gate changes.

The real authenticated producer → packaged SDK → consumer → documented CLI
composition passes synthetic full absence, existing/foreign launch, partial
grants, transport failure, live/reused submitter, concurrent receipt/replacement
and retry refund replay scenarios. The producer suite ran 33 passing cases,
including 20 composition scenarios through immutable SDK 0.8.0 and 0.9.0.
Consumer SDK/intent slices passed 178 cases; the independent state graph/source invariant passed unchanged. Lint has zero errors (existing
warnings); contract typecheck and byte-equivalence demo passed. Publication
records final additional checks and any baseline limitations.

The original filtered-empty composition deterministically refuses settlement
without changing lease/retry ownership. Fully authorized producer proofs permit
fenced audited settlement. Controlled yielding-read mutations preserve concurrent
receipts/replacements. No concurrency mechanism changes and no probabilistic
race-fix claim are made. No paid-model validation ran. Existing immutable SDK
artifacts, installed dependencies and DOG-10 migration remain unchanged.

Source publication: normal prefixed cross-model producer/consumer PRs, with
required checks and no admin merge or approval label. Deployment/loaded
producer and consumer generations: unverified. Exact entitlement provisioning,
owner dry-run/apply and organic #9445/#9448 recovery: separately authorized and
unverified. This worker did not remediate/merge those PRs, edit dispatch records,
change live grants/flags/roles/providers or restart/deploy a service.

Full offline validation completed in 750 seconds with exit 1: 15,426 passed,
ten skipped, one failure in unchanged `test/derived-artifacts.test.mjs:335`.
The cancellation fixture's `spawnSync ps` is refused with `EPERM` in this worker
environment. The test and imported artifact implementation are unchanged from
origin/main. A bounded replay of that unchanged file reproduced the same failure
(38 passed, one skipped, one failed). This is a disclosed environment/baseline
limitation, not full-suite green; no test, process guard or permission was
weakened. All changed recovery slices remain green.
