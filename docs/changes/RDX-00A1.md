# RDX-00A1

## Summary

Mirror the main repository's strict `worker_pool.public_hygiene` configuration:
`repos`, per-class `identities` (`name`, `email`) and private `denylist_path`.
Reject malformed declarations and require a readable UTF-8 file for nonempty repos.
These are shared policy keys; scanner rule parsing belongs to the canonical scanner.

Final remediation preserves default identities provenance, permits identity
fields to merge across layers, and watches the resolved denylist through the
existing digest cache rather than reading and decoding it on every cache hit.
Missing policy projections no longer enter cache-hit semantic validation.

## Interface changes

The identities map has `code-default` provenance. Complete identity records are
required after merging and for standalone validation; partial overlay records
are accepted. Cached denylist freshness and drift diagnostics share the existing
metadata/content-signature mechanism. See
[`LOADER-CONTRACT.md`](../../projects/cfg/LOADER-CONTRACT.md#public-hygiene-declarations-and-cache-freshness).
No persistent store, lifecycle state, dispatch flow or smoke promise changes.

## Verification

- `node test/run-tests.mjs test/config-public-hygiene.test.mjs test/config-loader.test.mjs test/role-config-cache.test.mjs test/config-loader-profile-overlay.test.mjs test/config-loader-runtime-tolerance.test.mjs`
  — 319 targeted offline tests passed, including null projection, provenance,
  partial layers, digest reuse/expiry, denylist changes/removal/path replacement,
  drift diagnostics and an edit during YAML loading.
- `npm run lint` — passed, zero errors (149 existing warnings).
- `npm run typecheck:contracts` — passed.
- `bash demo/research-finding-walkthrough.sh` — passed, byte-stable offline demo.
- `git diff --check` — passed.

Tests and long checks ran under `bin/run-bounded.sh` with a 45-second timeout.
The full local suite was not run; PR-head CI remains the merge gate.
