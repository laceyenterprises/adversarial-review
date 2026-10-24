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
