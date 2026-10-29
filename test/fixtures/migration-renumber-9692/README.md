# LAC-2127 immutable history corpus

`history.json.gz` contains read-only GitHub REST evidence captured on
2026-10-29 for `laceyenterprises/agent-os` PR9692, pinned to protected primary
`60dc71289dcf307a1703576f5c5eab041c4826c0` and diagnostic head
`065b0c7e7aeb03af64392c711526d9f104e166b0`. It is inert data. The test helper
only reads this local file; no token, GitHub, Agent OS checkout, migration
execution or network is needed. Gzip uses a zero timestamp for reproducibility.

The selected immutable base and the independently returned merge base are
`0cf82b3374ad736db2a68701cf1c6128686f9780`. The native saved refusal is
`/private/tmp/os-rescue-20261029-1413/9692-primary-details.json`: protected
primary selection and `chain-non-increasing`. The fixture starts at that
trusted collector boundary (`hasHammerCommits` and protected primary); it
proves the mechanical-history exception and ordinary primary-change predicate,
not a replacement for native protected-primary selection or author provenance.
No HAM/Reversal trailers, stored proof or production record was created or edited.

| Snapshot | Filename slot | Declared revision | Parent slot | Module |
|---|---:|---:|---:|---|
| `60dc71289dcf307a1703576f5c5eab041c4826c0` | 309 | 309 | 308 | absent |
| `3c58a608bc53e9073951e30018e1bcca21a5928e` | 310 | 309 | 309 | absent |
| `e1e63540fd7b662c5c1e793f8f8b035d03923378` | 311 | 311 | 310 | absent |
| `e8e354f70a24dd4841df40bd5f6a46f2436bb719` | 311 | 311 | 310 | absent |
| `ffbfc07236d832c4dd7a0c8dc92ea10b34010767` | 309 | 312 | 311 | r312 |
| `e306e2c5451322833b64033bf9376a1dd454bb9a` | 312 | 312 | 311 | r312 |
| `b936ab99aff4d91dc2084890902f5f8b17ff46ba` | 312 | 312 | 311 | r312 |
| `065b0c7e7aeb03af64392c711526d9f104e166b0` | 312 | 312 | 311 | r312 |

The `primary...head` comparison is `ahead`, merge base equals primary, and all
seven commits have exactly the preceding row as their parent. Every adjacent
comparison independently returns one commit ahead. The decreasing filename at
`ffbfc072` is real; a correction accepting only equal slots is insufficient.

The author/final SQL blob is `346898f38e23455674143c898997a7f738dd276a`.
Wrapper blobs are respectively `fdc10710cdcbad2c4b1c7bfc539613b612f86fd7`,
`7e8145ae686565ff4bea438ada8dabe939b2ca2a`,
`f209dbdb3771b862f985d2d09c3a42a58134488e`, then
`eeb608ccc5657a775a47211133c915edba0fc285`.
The r312 blob is `753d318a0b4d730621f502627e36487f59783428`; registry insertion
changes `e27233b424f1a1d6932ed391402e8f8de8c15257` to
`f0cff7255cbfb3b7327960fea6dd0af51468431c`.

Transport projections keep the fixture bounded and reviewable when decompressed:

- Blob base64 is decoded to UTF-8 `text`; the helper restores encoding and size.
  Production proof verifies each reconstructed blob's Git SHA and bytes.
- Complete non-recursive trees retain path, mode, type and SHA, including all
  unrelated entries; they are never filtered to create false absence evidence.
- The first recursive tree has 20,513 entries. Only its original truncation flag
  and entry count are retained; the helper reconstructs that oversized array.
  Production rejects its size and walks the complete non-recursive trees.
- Compare records retain status, counts, merge-base SHA, commit SHA/parent graph
  and complete file lists (filename/status/SHA/previous filename). Primary and
  final evidence additionally retain original patches and line counts for the
  ordinary primary-change predicate. HTTP URLs, commit messages and transport
  metadata are omitted. The final and primary lists have 21 and 19 files.
- Every snapshot comparison has fewer than 300 files; no capped list is asserted
  complete. No precomputed passing migration proof is stored in this corpus.

`test/primary-change-migration-metadata-repair.test.mjs` starts with a fresh
copy for every test. Counterfactual mutations are synthetic adversarial test
inputs, including copied tree paths so changing a snapshot never changes its
shared base object. They do not describe changes to the real PR.
