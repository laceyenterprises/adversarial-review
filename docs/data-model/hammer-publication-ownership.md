# Hammer publication ownership

Owner: `src/ama/hammer-publication-ownership.mjs`.
Store: `data/hammer-publication-ownership/<sha256(repo#pr)>.json`, mode 0600,
with a persistent sibling flock inode. Schema version 1 stores repo, prNumber,
controllerRecord, controllerPid, startedAt, recordedAt, heads, publishing and
optional closed and uncertain. The controller token is never copied to this store.

The publisher takes an exclusive PR lock and writes intent before mutating the
remote ref. A known Git head is recorded before push. For API-created commits
and server rebases, the returned exact head is recorded before releasing the
lock. Reviewer ownership reads take the shared lock before testing exact heads.
An old-head acknowledgment retains the lock through visibility polling and
the existing exact full-tree replay proof. An ambiguous failure retains typed
`closer-publication-unconfirmed` deferral only while its controller is active.
A conflicting read defers with `closer-publication-in-progress`; it confers no
head ownership. A publisher crash that releases flock with `publishing: true`
retains the unconfirmed deferral until its controller ends. Subsequent passes
classify the exact returned head, while a
foreign push retains normal review admission.
Probe deferrals leave queued automatic requests pending; they never record a
permanent closer-head re-review decline.

`active-closer-published-head` requires a matching running controller registration,
a live controller PID and a receipt younger than six hours. Controller exit or
confirmed merged lease release ends this custody; `merge-lease release --merged`
marks the record closed and empties heads. An exact live closer merge lease also
provides `active-closer-merge-lease`; a daemon lease does not. These reasons are
scheduling evidence only, never a verdict, validation certificate or merge
permission. Explicit operator re-review keeps its existing bypass.
