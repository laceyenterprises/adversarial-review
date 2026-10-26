# App SDK release

`agent-os-app-sdk-0.4.0.tgz` is the existing Node SDK 0.4.0 release artifact,
installed using the exact `file:` dependency and integrity in `package-lock.json`.
It includes offline readers and the public producer-contract snapshot; runtime
status interpretation requires no producer source checkout or network.

SHA-256: `5509f65066fb6cec00aacc89fb6a2c561a32219784db3ff45538afd3ddbfa2e5`.

Copied unchanged from `platform/app-sdk/node/agent-os-app-sdk-0.4.0.tgz` at
merged producer revision `1c60bb0f82e2924f5df7c11003a3d523917f3cc8` (LVR-09).
Its full Node JSON snapshot carries recorded examples and per-producer capture
metadata. The review tests read that snapshot, not the browser projection.
The earlier 0.3.0 artifact remains immutable historical release evidence.

The artifact is consumed unchanged. Refresh by adopting a reviewed release,
updating the dependency and lockfile, and running the affected reader tests.
Do not rebuild or replace an immutable release under the same version.

## Dispatch lookup release 0.8.0

`agent-os-app-sdk-0.8.0.tgz` is copied unchanged from
`platform/app-sdk/node/agent-os-app-sdk-0.8.0.tgz` at merged Agent OS revision
`387fb06d5d8835e320f49388a2ebdf67f2249945` ([producer PR #9419](https://github.com/laceyenterprises/agent-os/pull/9419)).
SHA-256: `4fd689c6e80cb9b620a3715ed9fe9474425d42fb00637193939f6b1a69b16a2e`.

The release replaces the unverified candidate formerly carried by this PR;
the candidate is not a release record. Independent SHA-256, npm integrity and
merged revision pins are recorded as `recorded.dispatchLookupSdk` in
`test/fixtures/producer-contracts/provenance.json`. Historical `recorded.sdk`
0.4.0 captures remain unchanged. Runtime activation still requires the producer,
complete grants and the explicit default-off flag documented in
`docs/producer-contract-readers.md#dispatch-lookup`.

## Argus provenance record (LAC-2117)

`argus-artifacts.json` seeds the existing 0.8.0 merged producer from the record
above; this PR does not upgrade the dependency or change either immutable
archive. Future upgrades update this machine record alongside the lockfile.
It is an untrusted claim until the collector reads the producer's authoritative
merged PR/commit and Argus compares both old/new producer and consumer bytes.
See [the runbook](../docs/RUNBOOK-argus-artifact-provenance.md). Enrollment must
reach the reviewed base before a later upgrade can use the same-producer rule.
