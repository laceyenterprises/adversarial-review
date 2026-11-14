# CLOSERHANDOFF-01

Mirror `worker_pool.closer_handoff.enabled` in the strict Node configuration
reader, defaulting to true and accepting false. This lets Agent OS ship the
builder-to-closer workspace custody transfer with an operator off switch while
the review daemons continue reading the shared configuration.

Validation: focused configuration parity tests cover the default, explicit
disable and invalid scalar type. This companion changes no review or merge
eligibility policy.
