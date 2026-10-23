# App SDK release

`agent-os-app-sdk-0.3.0.tgz` is the existing Node SDK 0.3.0 release artifact,
installed using the exact `file:` dependency and integrity in `package-lock.json`.
It includes offline readers and the public producer-contract snapshot; runtime
status interpretation requires no producer source checkout or network.

SHA-256: `824ceb872dda0451ca53f4cd7d4c38b56c02e9bb1931231e87698b0d105e8de1`.

The artifact is consumed unchanged. Refresh by adopting a reviewed release,
updating the dependency and lockfile, and running the affected reader tests.
Do not rebuild or replace an immutable release under the same version.
