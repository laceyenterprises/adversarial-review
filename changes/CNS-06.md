# CNS-06 — Bounded dispatch config visibility

Mirror Python-owned `sentinel.cns.auto_dispatch` settings in the Node reader:
shadow by default, fixed normal priority/claude-code, family and severity policy,
hourly cap, daily token envelope and fingerprint cooldown. Unread CNS sibling
fields remain tolerated. This is configuration visibility only; no review,
paging or worker dispatch behavior changes. Activation belongs to CNS-11.
