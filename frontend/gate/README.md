# The ARF arm/disarm gate

A load-independent governance gate for autonomous merge. ARF writes it; the
merge paths read it. A flip takes effect on the **next merge decision** in an
already-running daemon — no config edit, no `launchctl bootout`, no bounce.

This directory is the *honoring* side: the contract, and a client for each
runtime a merge path runs in. It is deliberately free of everything else in
ARF, so it can be imported across trees or copied into a pipeline repo verbatim.

| File | What it is |
|---|---|
| `gate-contract.mjs` | The contract as data: version, merge paths, decision codes, exit codes. |
| `gate-client.mjs` | The Node reader (`node:fs` only). |
| `arf_gate.py` | The Python reader (stdlib only) and a CLI. |

The writer lives in [`../server/src/governance/`](../server/src/governance/), and
the operator surfaces are `arf gate …` and `POST /v1/governance/gate/…`.

## What problem this replaces

Merge authority today is two config keys under
`roles.adversarial.merge_authority`, read by daemons that cache their config and
their environment at boot. Flipping one is an edit plus a bounce, the canonical
env override silently outranks every YAML file, and on 2026-07-26 two config-flag
halts *with* bounces did not stop live merges.

The gate is the opposite shape:

| | config flag | the gate |
|---|---|---|
| where the value lives | YAML, plus an env override that wins | one small JSON document |
| when a daemon reads it | at boot | at each merge decision |
| what a flip costs | edit + bootout + bootstrap, per daemon | one atomic write |
| read cost | n/a (cached) | one `open`/`fstat`/`read`/`close` |
| when the state is unclear | the daemon keeps its cached value | refuse |

## The merge paths

Three, matching ARF-04's Screen B derivation:

| id | MSM | executor | what it is |
|---|---|---|---|
| `hammer` | yes | `adversarial-watcher` | Remediates every final finding, rebases, revalidates CI, merges under its own lease. |
| `daemon-clean` | yes | `adversarial-watcher` | Inline merge of a fully-clean settled review with green checks and a matching head. |
| `python-backstop` | no | `auto-merge-daemon` | The worker-pool lane that merges CLEAN + MERGEABLE once the AMA deferral lapses. |

The backstop is in the gate because **neither existing kill-switch key stops
it**: it never reads `autonomous_merge_execution_enabled`, and `enabled: false`
removes its deferral to the AMA closer rather than disabling it — so the "off"
position of that switch makes the backstop merge *sooner*. A gate that armed
only the two MSM paths would let an operator disarm everything it knew about,
read "stopped", and watch merges continue.

## Honoring the gate

Three integration styles. All three fail closed and all three agree, because the
Node client and `arf gate check` share one implementation and the Python client
is diffed against the same contract by
[`server/test/gate-parity.test.mjs`](../server/test/gate-parity.test.mjs).

**Node** — construct once at startup, decide per merge:

```js
import { ArfGate } from './gate-client.mjs';

const gate = new ArfGate(process.env.ARF_GATE_FILE);   // once, at boot

// ...at the merge decision:
const decision = gate.decide('hammer');
if (!decision.allowed) {
  return refuse({ code: decision.code, reason: decision.reason, failClosed: decision.failClosed });
}
```

**Python** — the same, for the auto-merge backstop:

```python
from arf_gate import ArfGate

GATE = ArfGate(os.environ["ARF_GATE_FILE"])            # once, at boot

decision = GATE.decide("python-backstop")
if not decision["allowed"]:
    return refuse(decision["code"], decision["reason"])
```

**Shell** — no code change at all:

```sh
arf gate check --path hammer || exit          # 0 armed, 3 disarmed, 4 refused
python3 arf_gate.py --gate "$ARF_GATE_FILE" --path python-backstop || exit
```

Do **not** cache the decision, and do not wrap the client in one. The read is
four syscalls against a page the OS already has; a cache keyed on mtime cannot
see two writes inside one filesystem timestamp tick (one second on HFS+) and
would serve a pre-disarm answer for the life of the process — reintroducing, one
layer down, exactly the staleness this replaces.

Under a standalone ARF the supervisor exports `ARF_GATE_FILE` into every child
it spawns, so a supervised daemon needs no further configuration.

## Decisions

`decide(pathId)` returns:

```js
{
  path: 'hammer',
  allowed: false,
  code: 'disarmed-path',
  failClosed: false,                     // an operator did this, not a broken gate
  reason: 'this merge path is disarmed',
  gate: { path, version, seq, updatedAt },
  setBy: 'ada', setAt: '…', setReason: 'PR 5543 rebase storm'
}
```

| code | allowed | failClosed | meaning |
|---|---|---|---|
| `armed` | yes | — | the gate arms this path |
| `disarmed-path` | no | no | this path is disarmed |
| `disarmed-master` | no | no | every path is disarmed (emergency stop) |
| `gate-missing` | no | **yes** | no document at the configured path |
| `gate-unreadable` | no | **yes** | it could not be opened or read |
| `gate-oversize` | no | **yes** | larger than a gate can legitimately be |
| `gate-malformed` | no | **yes** | not a well-formed gate — including bytes that are not valid UTF-8 |
| `gate-version-unsupported` | no | **yes** | a version this client does not speak |
| `path-absent` | no | **yes** | no entry for this path |
| `unknown-path` | no | **yes** | not a path the contract defines |

`failClosed` separates "governance is working" from "ARF or its state root is
broken". Both stop the merge; only one needs an operator. Page on the second.

Exit codes for the shell integration: `0` allowed, `3` disarmed, `4` fail-closed
refusal, `2` usage. Asking about every path returns the **worst** of them, so a
wrapper cannot read a zero as "all clear".

## The document

```json
{
  "gateVersion": 1,
  "seq": 12,
  "updatedAt": "2026-08-19T18:04:11.000Z",
  "master": { "armed": true, "actor": "paul", "reason": "all clear", "at": "…" },
  "paths": {
    "hammer":          { "armed": false, "actor": "ada",  "reason": "rebase storm", "at": "…" },
    "daemon-clean":    { "armed": true,  "actor": "paul", "reason": "install",      "at": "…" },
    "python-backstop": { "armed": true,  "actor": "paul", "reason": "install",      "at": "…" }
  }
}
```

`master` is checked **before** the per-path entry, so an emergency stop covers a
path the document does not enumerate — including one a newer ARF would add. It
is also independent of the per-path entries: arming back out of a stop restores
exactly the posture that was in force before it, rather than arming paths an
operator had deliberately left off.

`seq` increments on every write, including a repeat of the value already held —
"disarmed again at 04:12" is a real event, and a second operator confirming a
stop is worth having in the record.

### Why a file and not a table

- **No sidecars.** SQLite in WAL mode creates `-wal` / `-shm` beside the
  database, owned by the *reading* process, so a cross-uid reader locks the
  writer out of its own file — the outage class the ARF store adapter already
  guards against (SPEC §6). A plain read creates nothing and takes no lock.
- **Constant size.** One entry per merge path, a fixed three. Nothing in the
  document grows with PRs, reviews, findings, or rounds in flight.
- **Cross-uid readable.** Written `0644` in a `0755` directory, because the
  pipeline daemons may run as `agentos-worker` while ARF runs as the HQ owner,
  and a gate the honoring side cannot open fail-closes the pipeline the first
  time an operator installs it.

### Reader tolerant, writer strict

Readers ignore fields they do not know, so a newer ARF can add one without
stopping a pipeline that has not updated. The writer refuses unknown keys, so a
hand-edited `armd: false` is rejected at write time instead of becoming a path
that reads as absent.

Both readers decode the document with a **strict** UTF-8 decoder. This is a
parity property rather than a pedantic one: Node's `Buffer#toString('utf8')`
substitutes U+FFFD for a malformed byte and hands back a string that parses, so a
lenient reader would answer `armed` for a document CPython's `bytes.decode` — and
therefore the Python backstop — refuses outright. One merge path merging under a
gate the other calls broken is exactly the drift this contract exists to stop.

A version the reader does not recognise is a **refusal**, not a best-effort
parse: a v2 field's absence must never be read as "armed".

## Two implementations, one contract

The Node and Python clients are separate implementations of one document, which
is the `config-schema.multi-loader-parity` shape — the class that put the
adversarial watcher into a respawn crash loop for over an hour on 2026-07-17 and
broke the default 1Password install on 2026-07-20.

`server/test/gate-parity.test.mjs` is the parity gate those RCAs asked for. It
deep-diffs `contract()` between the two and then drives both over the same
documents, comparing every decision. **A constant changed in one and not the
other fails a test**, rather than showing up at 3am as one merge path honouring a
disarm and the other not.

If you add a field a decision depends on, it goes in `contract()` in both files.
A constant left out of that payload is a constant the parity gate cannot protect.
