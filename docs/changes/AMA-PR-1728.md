# AMA-PR-1728

Make the stalled ownership-read regression test deterministic under CI load. Hold its deadline clock steady until the real timeout aborts the first read, then expire the shared budget. The test continues to require exactly one source read and bounded resolver retries without changing production behavior.

The final review findings are addressed by the existing head: the probe/census suite lives under `test/`, and receipt sampling distinguishes expected validation failures from unexpected runtime or storage failures.
