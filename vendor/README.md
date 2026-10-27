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

The reviewed base enrolled the existing 0.8.0 producer above. This upgrade updates
`argus-artifacts.json` to the already-merged 0.9.0 producer, Agent OS PR #9435 at
`f37c7489439a8b53eafecb38870f75fe9f07fa57`, with SHA-256
`6882b99962cd7319ed858d0a15ee84f9384a566474359085153aef2b615f2cf9`.
Both immutable archives remain unchanged. Future upgrades update this machine
record alongside the lockfile.
It is an untrusted claim until the collector reads the producer's authoritative
merged PR/commit and Argus compares both old/new producer and consumer bytes.
See [the runbook](../docs/RUNBOOK-argus-artifact-provenance.md). Enrollment must
reach the reviewed base before a later upgrade can use the same-producer rule.


## Coordinated review-observation candidate 0.10.0 (DOG-11)

The coordinated producer PR #9489 refreshed its 0.10.0 candidate at revision
`dac9b8690234648346b052ab16f5ee77bee5c191`. The unchanged archive copied here has
SHA-256 `6644ab93a1233ad731a58ac2aeec1dd0d5437994fbb24bf0574fb0df22f2cfb8`.
The lockfile and `recorded.dispatchLookupSdk` provenance pin these exact bytes.
This remains a coordinated draft dependency; it does not claim merged release
or runtime activation. Historical release archives and Argus enrollment remain
unchanged. A later producer artifact refresh must update this candidate's
checksum and provenance together.
