# KEY-04 — Shared credential configuration namespace

Mirror the credential policy keys: enforcement and model_broker.enforcement
default to observe; cloud.enabled defaults false. Nested namespaces tolerate
unknown sibling overlay keys. This change defines configuration only and does
not change review or closure behavior. No restart or activation is needed.
