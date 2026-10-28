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
`argus-artifacts.json` to the already-merged 0.10.0 producer, Agent OS PR #9489 at
`eba16c857d18b3f153071b846429bd9cb08e875c`, with SHA-256
`3c85183c497351739181b7ccc37f768d3c08c85cc36f2f2bf8f441b05f4ec83a`.
The immutable archives remain unchanged. Future upgrades update this machine
record alongside the lockfile.
It is an untrusted claim until the collector reads the producer's authoritative
merged PR/commit and Argus compares both old/new producer and consumer bytes.
See [the runbook](../docs/RUNBOOK-argus-artifact-provenance.md). Enrollment must
reach the reviewed base before a later upgrade can use the same-producer rule.


## Review-observation release 0.10.0 (DOG-11)

Producer PR [#9489](https://github.com/laceyenterprises/agent-os/pull/9489) merged
the 0.10.0 release at revision
`eba16c857d18b3f153071b846429bd9cb08e875c`. The unchanged archive copied here has
SHA-256 `3c85183c497351739181b7ccc37f768d3c08c85cc36f2f2bf8f441b05f4ec83a`.
The lockfile and `recorded.dispatchLookupSdk` provenance pin these exact bytes.
This is a merged release dependency; runtime activation remains separate.
Historical release archives remain unchanged. A later producer artifact refresh
must update the checksum and provenance together.


## Coordinated dispatch-file release 0.12.0

The runtime archive is `agent-os-app-sdk-0.12.0.tgz`, SHA-256
`5aeaf21a592cc8e1811c5eefdb1d68efced730d46cd3dc0d22c95be1d0b55daf`. The lockfile pins its SHA-512 integrity.
It adds authorized dispatch metadata, bounded redacted logical logs and public
host observations. `recorded.dispatchLookupSdk` labels this candidate
`coordinated-pr`; its producer has not yet merged. Historical immutable
archives and capture definitions retain their provenance.

The artifact authority record deliberately continues to hold this upgrade
until the producer merges. Follow the coordinated-release procedure in the
SDK README to verify merged bytes and update `argus-artifacts.json` with the
authoritative producer PR and merge commit. A candidate revision or this note
confers no artifact authority and permits no runtime activation.


Follow-up owner: the release operator for [agent-os#9570](https://github.com/laceyenterprises/agent-os/pull/9570),
tracked jointly with consumer [#1583](https://github.com/laceyenterprises/adversarial-review/pull/1583),
must compare the merged archive digest, refresh bytes if necessary and update
`recorded.dispatchLookupSdk`, the lockfile and `argus-artifacts.json` together
before activation. See the closure runbook's public evidence rollout limits.
