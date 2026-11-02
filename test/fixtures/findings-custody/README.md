# Native findings publication custody fixture

`native-status.json` was regenerated on 2026-11-02 through installed native
`resolve_status` / `StatusCard.to_dict` and the public SDK producer view
`fetch_app_dispatch_reads`. The factory writes only disposable temporary SQLite
through public ledger models and worker observation APIs. All identities,
paths, terminal and push evidence are explicitly synthetic. No production
ledger, provider, dispatch, push or PR is used.

The launch fixture comes from the actual public projection, not a raw launch
row. It omits `target_worktree`, as production does. The status fixture displays
absolute workspace paths. That combination reproduces the old consumer's slug
rejection. Repository authority comes from exact keyed launch identity and the
independent remote tested-head / marked-PR evidence; display paths confer none.

Producer hashes at capture:

- Native watch serializer SHA-256: `1595ff015d66ecf83d60b48b6e9647e09e895b2e2ad0cb5d24ddfc9a4e20fae0`.
- Public dispatch projection SHA-256: `8d2666827b439199218a4751e19648e3b0668bf3c7dcd18c68a65f4f23c45530`.

With an explicitly prepared native Python package environment, regenerate into
a scratch file and inspect it before replacing the committed fixture:

```sh
python3 test/fixtures/findings-custody/capture.py > /tmp/native-status.json
```

The regressions reject foreign repository, LRQ, ticket/key, failed preparation,
failed push and wrong remote/PR evidence while preserving original artifacts.
A relocated display path cannot authorize or deny a repository on its own.
Invalid historical outcome/reason artifacts remain unresolved. Offline success
establishes neither deployed activation nor production backlog recovery.
