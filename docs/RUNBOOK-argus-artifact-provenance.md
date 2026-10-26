# Existing immutable artifact upgrades — LAC-2117

The Argus Python rubric in Agent OS owns source/provenance classification.
`src/argus-artifact-evidence.mjs` gathers its evidence; no model, comment or
consumer-supplied `releaseStatus` can establish producer authority.

For each manifest directory, `vendor/argus-artifacts.json` has schema version 1
and a `packages` map keyed by package name. Each entry names `producerRepo`
(`owner/repo`), `producerPr` (positive number), `producerCommit` (full merged
40-hex commit), `producerPath` (relative `.tgz` path) and `sha256`. See the
reviewed base's 0.8.0 record and this upgrade's 0.9.0 record for the existing SDK.
The 0.8.0 enrollment reached main independently in PR #1554; the later record
names the immutable release merged in Agent OS PR #9435. Neither record alone
approves a dependency or authorizes runtime activation.

The base must already establish the file dependency and producer record. A
normal independently reviewed enrollment may add the record for an existing
artifact. A later upgrade supplies its new record alongside manifest, lock and
immutable archive. Do not combine first introduction of a source and producer
record expecting automatic approval. No package or first-party whitelist exists.

The collector reads both sides at exact PR refs, reads the producer PR through
GitHub's authoritative pull endpoint, checks merged state and exact merge
commit, requires the PR's `base.ref` to match the repository endpoint's current
`default_branch`, and reads producer bytes at that commit. Missing branch
metadata or a merge into another branch supplies no proof. The head's producer
repository must match the base record. It never uses a checkout,
release label, npm installation, or an external URL from a record. It accepts
only confined relative paths and inline GitHub contents up to 1 MiB, for at
most four changed local releases per manifest. Excess entries lack proof and
retain their source high. Larger
artifacts need separate policy review. Missing PRs/repositories/artifacts (404),
directory responses, absent inline base64, size mismatches and over-budget files
are absent/invalid proof and retain the source high. Failed reads (for example
5xx, timeouts or TLS errors) hold/retry instead of deciding without evidence.

Python compares producer/consumer bytes, record SHA-256, lock SHA-512, archive
name/version, manifest route and both old/new producer and consumer directories.
Only dependency-free tarballs without install execution or unsafe members can
qualify. New sources, changed origins, repacks, missing/mismatched hashes and
credential/install risks remain blocking. The canonical details are in Agent
OS `modules/argus/SECURITY-REVIEW-RUBRIC.md` and the external SDK consumption ADR.

The model must tag a **protocol-only** claim with `provenanceClaim:
"source_protocol"`, exact `packagePath` and lockfile `path`. Only independently
verified exact entries can reconcile that claim to an explanatory low. This
retains the original finding; it does not suppress integrity, origin,
credential, install or ambiguous claims. Category spelling uses the existing
normalizer and severity ceilings. Summaries use composed findings, with the
actual evidence/ceiling downgrade reason rendered beside a demotion.

On retry/CI deferral the collector runs again. `evidenceFingerprint` binds
head, repo/PR, diff, lockfile facts, artifact digests, authoritative proof and
rubric facts. Raw base SHA, CI, best-effort release notes and local-checkout
usage text are excluded: base movement reuses model work when these bound
security facts remain identical. Deterministic collection, including the rubric
and artifact reads, still runs on every retry. Older fingerprint generations
rerun model review once. Completed historical results are preserved. No live
record migration or queue state transition changes are required.

Deploy the reviewed Agent OS Python owner before or with this collector, then
use the established operator service rollout and loaded-build verification.
An older owner continues blocking, so a partial rollout fails closed. Both PRs
need ordinary cross-model convergence and hosted required checks. Do not
admin-merge or activate a service from this RCA worker.

For #1550, let the rescue owner refresh its normal reviewed head after the
0.8.0 enrollment reaches main, supply the merged 0.9.0 producer record and
inspect the native current-head verdict and artifact bindings. Do not modify
its queue/results, stop jobs, add `operator-approved` or bypass code review.
#9439 is also owned by that rescue lane. Source fixes and synthetic tests do
not establish live incident closure.
