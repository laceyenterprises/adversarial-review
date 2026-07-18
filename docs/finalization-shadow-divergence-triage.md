# Merge Authority v2 — shadow divergence triage (bidirectional)

**Status:** operating guide for the MA-v2 shadow cutover (ARC-16).
**Companion:** [`SPEC-merge-authority-v2.md`](SPEC-merge-authority-v2.md) §5
(shadow-mode cutover), SPEC §1 Win 3 (the shadow-report output).

Shadow mode runs the ground-up v2 finalization fold against the **live**,
**frozen** v1 merge authority. For every finalization tick, the recorder logs a
`(v1 action, v2 decision)` pair — v2 **never acts** (log-only) — and the
divergence classifier proposes a triage. This doc is how a human dispositions
those divergences and clears the promotion gate.

## The one rule: a divergence is evidence, in both directions

v1 is the **known-buggy** system. Its failure history is documented
(`SPEC-merge-authority-v2.md` §1): phantom die-before-merge, identity head-pin,
ceiling+head-move deadlock, LHA premature cutover, CI-impatience,
verdict-at-wrong-head. So when v1 and v2 disagree, the base rate says v1 is more
likely wrong.

That is a prior, **not** a verdict. The discipline the SPEC requires (§5.2) is
that every divergence is triaged **in both directions**:

- A divergence is **not automatically a v2 defect** — do not "fix" v2 to match
  v1 without first asking whether v1 is exhibiting one of its known bugs.
- A divergence is **not automatically a v1 defect** either — v2 is new code and
  can be wrong. Auto-blaming v1 would launder a v2 bug straight through the
  promotion gate.

The classifier encodes exactly this. It **auto-attributes to v1 only** when a
divergence matches a precise, documented v1 failure-family fingerprint (each has
an ARC-15 regression fixture). **Everything else defaults to `open`** — a human
must triage it. `open` is the only disposition that blocks promotion.

## What the classifier decides (and what it leaves to you)

`classifyDivergence({ v1Action, v2Decision, state, foldError })` →
`{ relation, direction, class, ref, disposition, reason }`.

- `relation`: `agree` (same coarse bucket — land / remediate / close / wait /
  stop) or `diverge`.
- `direction`: `v1-defect` (auto-attributed, dispositioned `resolved`),
  `v2-suspect`, `benign`, or `open` (needs you; dispositioned `open`).
- Only `disposition: 'open'` blocks the promotion gate.

Coarse buckets mean v1 `escalate` vs v2 `halt` is **concurrence** (both page,
neither mutates), and v1 `none` (held authority, did nothing) concurs with v2
`wait`.

### Auto-attributed v1-defect fingerprints

| class | v1 did | v2 decided | why it is a v1 defect | ref |
|---|---|---|---|---|
| `ci-impatience` | merged | wait/escalate (reason mentions checks) | v1 read "checks I can see are green" as "checks green"; required checks were not present-and-settled at head | AR#550 |
| `verdict-at-wrong-head` | merged | wait/escalate (reason mentions verdict) | v1 merged on a verdict from a stale revision; v2 matches verdicts to the head by construction | verdict-at-wrong-head |
| `identity-head-pin` | merged (detail mentions identity/head-pin) after a head move | wait/escalate | v1's worker-identity lookup was pinned to a head that moved | #603 |
| `lha-premature-cutover` | wait (stalled on attestations) | escalate (attestation patience) | v1 required a `produced` attestation no producer writes → permanent stall; v2 escalates on bounded patience | LHA |
| `phantom-die-before-merge` | wait (detail marks stranded/crash) | finalize-now (clean@head) | v1's progress lived in process state; a crash stranded a converged PR; v2 re-folds the durable ledger | HCM-01 |
| `ceiling-head-move-deadlock` | wait/none, head moved | finalize-now (clean@head) | v1's round ceiling and head pointer lived in different actors → a clean green PR became un-landable; v2 counts budget per-stage, eligibility per-revision | LAC-1559 |

The fold-error / ledger-unavailable path is its own case: v2 **fails closed to
`escalate`** (§5.5 — never a guess). If v1 also paged, that concurs (`benign`).
If v1 acted while v2 could not even fold, that is `open` — triage the ledger
**and** v1.

### Divergences that stay `open` (you decide)

These are deliberately **not** auto-attributed, because each is genuinely
bidirectional:

- **v1 `hammer-dispatch` vs v2 `finalize-now (verdict@head clean)`** — either v1
  is over-remediating a PR that is already landable (v1 defect), or v2 is
  finalizing prematurely (v2 defect). Read the ledger: is there a real unaddressed
  finding at head? If not → v1 defect; annotate `resolved`. If yes → v2 defect;
  file it against the fold and keep the gate closed.
- **v1 `close` vs v2 `finalize-now`/`remediate`** — v1 abandoned; v2 wants to
  continue. Could be a legitimate operator close (benign) or v1 abandoning a
  landable PR (v1 defect). Check for an `operator_override(close)` in the ledger.
- **Any `unclassified` divergence** — no known fingerprint. Investigate before
  disposing.

## How to disposition (recording the call)

The classifier proposes; **you dispose**. Record a human override on the
observation — it supersedes the classifier's proposal in the report:

```js
import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
const store = openFinalizationShadowStore({ rootDir });
store.annotate(observationId, {
  disposition: 'resolved',            // or 're-open a wrongly auto-resolved one: 'open'
  note: 'ledger shows no finding at head; v1 hammer was spurious — LAC-1559-adjacent',
  principal: 'operator',
  at: new Date().toISOString(),
});
```

Use `disposition: 'open'` to **re-open** a divergence the classifier
auto-resolved if you disagree with the attribution — that is the bidirectional
escape hatch, and it re-blocks the gate.

## The promotion gate (§5.3)

`node src/cli.mjs finalization shadow-report --days 7` prints the verdict.
`promotable` requires **all** of:

1. **≥ N days of shadow coverage** (default 7) — the oldest observation is at
   least N days old.
2. **Every divergence dispositioned** — zero `open` divergences in the window.
3. **At least one organic head-move** observed in shadow (`sawHeadMove`).
4. **At least one budget-exhaustion close** observed in shadow
   (`sawExhaustion`).

Any unmet condition is listed as a blocker. Promotion itself is an **operator
action** (ARC-17 ships the executor gated off); this gate only reports
readiness.
