# Native findings publication custody fixture

`native-status.json` is a selected projection produced on 2026-11-02 by
`capture.py` using the installed native `cwp_dispatch.watch.resolve_status`,
`StatusCard.to_dict`, `session_ledger` public models and `WorkerObservability`.
The factory migrates and writes only a disposable temporary SQLite database.
It does not dispatch, push, open a PR, contact a provider or open a live ledger.
All IDs, paths, repository and evidence are synthetic inputs; terminal success
and the done milestone are explicitly seeded through the public owner APIs.
The test substitutes only batch-specific ticket/key values and the manifest's
preparation LRQ. Ordinary tests read this checked-in JSON fully offline.

Native `watch.py` SHA-256 at capture:
`1595ff015d66ecf83d60b48b6e9647e09e895b2e2ad0cb5d24ddfc9a4e20fae0`.
This is separate from the SDK's hash-pinned producer recordings; none of those
recordings are edited. The factory requires an operator-provided native Python
package environment only for deliberate refresh:

```sh
python3 test/fixtures/findings-custody/capture.py > /tmp/native-status.json
```

Inspect a refreshed capture before replacing the checked-in fixture. The current
native serializer emits absolute `repo_path` as `repo`, and `worktree_path` as
`workspacePath`, with launch `target_repo`/`target_worktree` fallbacks. Original
consumer reproduction:

```sh
node -e 'const f=require("./test/fixtures/findings-custody/native-status.json"); console.log(![f.launch.target_repo,f.launch.target_repo.split("/").at(-1)].includes(f.status.repo))'
```

The observed result is `true`: the old slug predicate rejects the native shape.
`test/findings-batch.test.mjs` replays it through the collector and tests foreign
same-basename workspaces, foreign repository/ticket/key, missing workspace proof,
failed preparation/push, wrong head/marker, malformed outcome custody and the
existing publication fences. The capture establishes no production recovery.
