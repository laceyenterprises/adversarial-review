# SDK launch-status migration evidence

The existing SDK 0.3.0 tarball is consumed unchanged, with npm lockfile integrity
and the SHA-256 recorded in [the artifact record](../../vendor/README.md).
The standalone repository supplies all runtime evidence readers; the companion
checkout supplies no runtime import or fallback.

`test/helpers/dispatch-status-cases.mjs` reads the public `dispatch-status`
serializer examples bundled in the installed release. They cover all fourteen
canonical statuses. Negative/compatibility mutations are labelled separately:
explicit false, missing booleans, unfamiliar/malformed status, and removed
launch aliases. Both HQ CLI and app-contract runtime consumers are exercised;
the latter also preserves the documented nested `live_status` evidence.

The existing parked/resumed ownership repair is retained. Scheduling capacity,
lease ownership, retry policy, process success and GitHub delivery remain
separate. The clean smoke additionally checks explicit false precedence and
rejected launch-success aliases. No durable store fields, configuration keys,
CI jobs or merge-authority capabilities are added.

All test commands use the provisioned netguard environment:

```bash
NETGUARD_LOG="$PWD/scratch/netguard.log" \
PATH="$NETGUARD_ROOT/bin:$PATH" \
PYTHONPATH="$NETGUARD_ROOT/site${PYTHONPATH:+:$PYTHONPATH}" \
python3 - <<'PY'
import subprocess
subprocess.run(['node', 'test/run-tests.mjs',
    'test/producer-contract-readers.test.mjs',
    'test/hq-dispatch-status-json.test.mjs',
    'test/launch-request-status.test.mjs',
    'test/ama-closer-dispatch-priority.test.mjs',
    'test/smv.test.mjs'], check=True, timeout=240)
PY
```

The wider reader/ownership run selects complete existing test files with this
literal source-reference inventory, excluding only the long merge-agent file
already running in `npm test` and the separately attempted native PostgreSQL
file:

```python
from pathlib import Path
import subprocess
owners = [
    'launch-request-status.mjs', 'dispatch-closer.mjs', 'closer-lease.mjs',
    'closure-owner.mjs', 'closure-capacity.mjs', 'session-ledger-read-adapter.mjs',
    'orphan-watchdog.mjs', 'hammer-scratch-sweep.mjs', 'operator-notice-route.mjs',
    'hammer-wake.mjs', 'remediation-hq-dispatch.mjs', 'remediation-worker-liveness.mjs',
    'producer-contracts/launch-status.mjs', 'producer-contracts/dispatch-receipt.mjs',
    'reviewer-runtime/agent-os-hq/index.mjs', 'agent-runtime/os-dispatch/index.mjs',
]
exclude = {'test/follow-up-merge-agent.test.mjs',
           'test/session-ledger-retry-postgres.test.mjs'}
files = sorted(str(p) for p in Path('test').rglob('*.test.mjs')
               if str(p) not in exclude and any(x in p.read_text() for x in owners))
subprocess.run(['node', 'test/run-tests.mjs', *files], check=True, timeout=600)
```

Additional complete files run:

```bash
node test/run-tests.mjs \
  test/follow-up-merge-agent-stuck-pre-spawn.test.mjs \
  test/follow-up-merge-agent-stuck-round2.test.mjs \
  test/follow-up-merge-agent-proactive-stuck-scan.test.mjs \
  test/follow-up-merge-agent-watcher-ownership.test.mjs \
  test/hq-dispatch-status-json.test.mjs test/smv.test.mjs
node test/run-tests.mjs test/agent-runtime-os-dispatch.test.mjs test/app-sdk-consumption.test.mjs
npm run lint
npm run typecheck:contracts
bash demo/research-finding-walkthrough.sh
```

Those commands use per-command timeouts of 300, 180, 120, 120 and 120 seconds
respectively. The artifact also passed an isolated `npm install --prefix <disposable-project> --offline
--ignore-scripts --no-audit --no-fund` into a disposable directory, followed by
SDK-reader assertions with absent OS roots, refused Node socket connects and
refused fetch. No producer checkout or ledger was needed for that smoke.

Native PostgreSQL was attempted with the unchanged
`test/session-ledger-retry-postgres.test.mjs` file. Five native cases failed
before invoking the readers: `initdb` could not create a shared-memory segment
(`No space left on device`). The companion pure startup tests passed.
No successful native PostgreSQL evidence is claimed. Existing SQLite fixtures
and fake PostgreSQL transport cases remain in the consumer runs; no backend
query or store format changed.

No live dispatch, model/GitHub delivery, configuration change or service restart
was performed. Install the locked dependency during the normal reviewed source
deployment; activation remains operator-owned.

Observed focused results:

- Initial producer/HQ/launch/remediation/reviewer/reconciliation run: 307 passed.
- App-contract runtime plus SDK consumption: 90 passed.
- Merge-agent stale/refusal/ownership, HQ transport and lifecycle smoke: 112 passed.
- Final producer/HQ/launch/closer/lifecycle run: 378 passed.
- Additional wire-only transport coverage: 54 passed.
- Closer/runtime/router/native-PostgreSQL attempt: 277 passed, five native fixture
  initialization failures as described above.
- Lint: zero errors (existing warnings); contract typecheck and the research
  finding walkthrough passed, including byte-equivalent transcript delivery.

The bounded whole-suite command is `npm test` (the repository runner's existing
900-second deadline, with a 920-second outer command limit). Its first run
exposed three migration-related cases: an obsolete cancellation alias
expectation, a sibling async refusal probe still using the removed local set,
and an obsolete `reaped` scratch-cleanup fixture. These were corrected; the
stale-dispatch files passed in the 112-test follow-up, and the complete scratch
file passed all 68 cases. This is not a claim that an initial failed whole-suite run was green.

The final receipt/transport/smoke follow-up passed all 132 cases. This includes
explicit false on real captured receipt stdout and wire-only status probes.
The final scratch run was:

```bash
node test/run-tests.mjs test/hammer-scratch.test.mjs
```

It used a 60-second limit. Final lint again reported zero errors.

The whole-suite runner reported 12,219 cases: 12,165 passed, eight failed,
41 canceled and five skipped before its 900-second deadline. The outer command
also reached its 920-second limit. The eight failures were the three corrected
migration cases above and the five native PostgreSQL initialization failures.
No green whole-suite result is claimed.

The 99-file reader/ownership command reached its 600-second limit, reporting
3,759 passes, two failures and two cancellations. Its scratch alias failure was
corrected as above. Its rendered-shell timeout passed in the isolated follow-up:

```bash
node test/run-tests.mjs test/hamclose-ownership.test.mjs \
  test/hammertrim-contract.test.mjs test/watcher-claim-loop.test.mjs \
  test/hammer-scratch.test.mjs
```

At a 180-second bound that run reported 129 passes, zero failures and two
canceled files: `hamclose-ownership` and `watcher-claim-loop`. Therefore a green
complete watcher-claim-loop run is unavailable in this environment.

The unchanged three-file comparison (`hamclose-ownership`, `hammertrim-contract`,
`watcher-claim-loop`) used a disposable shadow of main at `35164eb65453734761d19b63cb79ee7e8ac4651e`, restoring
every changed production module and the original SDK 0.2.0 artifact. The same
180-second bound produced 61 passes, zero failures and the same two canceled
files at the same test boundaries. The worker checkout's production files were
not replaced for this comparison. These baseline limits were not repaired as
part of the launch-status migration.
