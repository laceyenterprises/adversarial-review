# BASELINE — v1 working snapshot

Phase 0 of the adversarial-review v2 migration (ticket **ARC-01**). This doc
records the rollback floor every later v2 phase gate stands on: the snapshot
tag, the maintenance branch, and the green fixture-e2e baseline captured at the
tag.

See the migration plan in
[`docs/SPEC-adversarial-review-v2-app-architecture.md`](SPEC-adversarial-review-v2-app-architecture.md)
§10 (Phase 0) and the freeze scope in
[`src/ama/FREEZE.md`](../src/ama/FREEZE.md) /
[`docs/SPEC-merge-authority-v2.md`](SPEC-merge-authority-v2.md).

## Snapshot refs

| Ref | Kind | Commit |
|---|---|---|
| `v1-working-snapshot` | annotated tag | `99305e4710eeee3b8cf225018151d5497414e339` |
| `v1-maintenance` | branch | `99305e4710eeee3b8cf225018151d5497414e339` |

The snapshot commit is `99305e4` — *"prompts: operator-policy guard for
code-pr remediators (#612)"* — the tip of `main` immediately before ARC-01.
Both refs are pushed to `origin`. `v1-maintenance` is the branch for
**bug-fix-only** emergency fixes to frozen v1 merge authority (see
`src/ama/FREEZE.md`); all v2 work lands on `main` behind config gates, so no
long-lived fork.

Rollback recipe for any later phase: `git checkout v1-working-snapshot` (or
branch off `v1-maintenance`), flip the offending v2 gate off, bounce the
watcher.

## Toolchain

The validation gate is not pre-provisioned in a fresh worker tree:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # node@22 (repo engines: >=20 <26)
npm ci
npm rebuild better-sqlite3 fs-ext                   # native bindings npm ci does not build
```

- Node `v22.22.3`, npm `10.9.8`.

## Command list + results (at the tag)

Run from the repo root on the snapshot commit. Additive ARC-01 changes (this
doc, `src/ama/FREEZE.md`, the `RUNBOOK-ama-closure.md` cross-reference, and
`test/ama-freeze-note.test.mjs`) touch no runtime source, so they do not move
this baseline.

| # | Command | Result |
|---|---|---|
| 1 | `npm run lint` | **pass** (exit 0) |
| 2 | `npm run typecheck:contracts` | **pass** (exit 0) |
| 3 | `bash demo/research-finding-walkthrough.sh` | **pass** (exit 0) — fixture domain e2e walkthrough converges with byte-stable transcript deliveries |
| 4 | `node --test test/research-finding-end-to-end.test.mjs test/replay-harness.test.mjs test/adapters/*.test.mjs` | **green** — `# tests 104 / # pass 104 / # fail 0` |
| 5 | `npm test` (full unit suite) | `# tests 3618 / # pass 3610 / # fail 4 / # skipped 4` — see caveat |

**Fixture-e2e baseline is green:** the domain fixture end-to-end path — the
research-finding walkthrough (command 3) and the fixture-domain + adapter
suites (command 4, `# fail 0`) — passes clean at the tag. This is the Phase 0
gate subject.

### Caveat — 4 environment-dependent `fs.watch` wake failures (command 5)

The full `npm test` suite reports 4 failures at the tag, all in one mechanism:

- `test/handoff-wake.test.mjs` — *handoff wake interrupts a listening sleep
  within two seconds*; *handoff wake marker carries PR head metadata for rate
  limiting*; *timer still fires normally after prior wakes*
- `test/follow-up-remediation.test.mjs` — *review-to-remediation wake lets
  daemon consume a queued job within five seconds*

All four exercise the **marker-file wake path** (`sleepUntilTimerOrHandoffWake`
/ `waitForHandoffWake`), which uses `fs.watch` on a temp-dir marker file. On
this worker host the watcher never delivers the change event, so the sleep
falls through to its timer (`reason: 'timer'` instead of `'wake'`) and the
sub-2s/5s wake-latency assertions fail. This is `fs.watch`/FSEvents latency on
the host's `/var/folders` tmpfs, **not** a domain-logic regression: the
failures reproduce identically in isolation and when running these two files
alone, and ARC-01 touches none of this source. They are recorded here as the
known baseline delta so later phases can tell a real regression from this
pre-existing environmental flake.
