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

## Dispatch lookup candidate 0.8.0

`agent-os-app-sdk-0.8.0.tgz` is the runtime dependency for dispatch lookup.
SHA-256: `c95d059abaae070965fe363ae90fd5f5e2e2dd67b3f45de5317e668bda2912df`.
The independent SHA-256 and npm integrity pins are recorded separately in
`test/fixtures/producer-contracts/provenance.json` as `recorded.dispatchLookupSdk`;
`recorded.sdk` and its historical 0.4.0 captures remain unchanged.

**Merged producer release revision: unverified.** No merged 0.8.0 release record
was available in this consumer checkout or the artifact metadata. The byte pin
prevents undetected artifact drift; it does not establish release provenance.
Before runtime activation, the operator must obtain the reviewed merged producer
release record, verify these bytes against it, and record its full revision.
Do not infer a release revision from the consumer commit or the bundled older
producer-contract snapshot. Dispatch reads default off until explicitly enabled;
see `docs/producer-contract-readers.md#dispatch-lookup` for deployment order.
