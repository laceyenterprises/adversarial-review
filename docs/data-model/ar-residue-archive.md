# AR residue archive

**Source of truth:** `src/ar-residue.mjs` (CLI `bin/ar-residue-export.mjs`)

Owner: the operator who runs the export. Store:
`$HQ_ROOT/archive/ar-residue/<UTC date>/`, written once per date. The tool
refuses to write into a directory that is not empty.

Contents:

- `<table>.csv`, one per exported `reviews.db` residue table. The first record
  is the column names and each later record is one row in `rowid` order. The
  file is RFC 4180. SQL `NULL` is an empty unquoted field, the empty string is
  `""`, and a BLOB is `\x<hex>`.
- `files/<fossil directory>/...` holds byte copies of each fossil directory's
  files.
- `manifest.json` (`schemaVersion: 1`) records `createdAt` and `dbPath`. For each
  table it records `tables[]` with `name`, `sql` (the original `CREATE TABLE`),
  `columns`, `rowCount`, `csv`, `sha256` and `bytes`. It also records
  `zeroByteDbFiles[]` (absolute paths) and `fossilDirs[]` with `path`,
  `archive` and `files[]` (`path`, `sha256`, `bytes`).

Only `operator_*` tables whose names carry a hand-repair stamp token are
residue. The token is `<YYYYMMDD>T<HHMM>`, optionally followed by seconds and
`Z`, and is delimited by underscores. Examples are
`operator_20260727T0902_review_flow_rearm_reviewed_prs` and
`operator_reviewer_pass_reset_20260727T062342Z`. Any other name is refused, including the
live `operator_hold_releases`. Zero-byte DB files are regular `*.db`, `*.sqlite`
and `*.sqlite3` files of size 0 in the checkout root or `data/`. The live
`data/reviews.db` is never one of them. The only fossil directory is
`data/follow-export HAM_RUN_DIR=`.

Verification re-reads the archive. Each CSV's sha256 and record count must
match the manifest, and each copied file's sha256 must match. Drop verifies
again against the live store: a fresh CSV rendering of every remaining table must
be byte-identical to the export, and every remaining fossil file must be exported
and byte-identical to its archived copy. Drop permits already-absent tables,
DB files and fossil files/directories so the same `--execute --drop` command
(with the original archive date) can resume after a partial filesystem failure.
Standalone `verifyExport` remains strict about missing live tables and fossil
files unless `allowRemovedResidue` is explicitly enabled, as it is by drop.
The archive is always verified in full, including copies of removed live files.
Drop then checks that every remaining listed DB file is still empty. Any
mismatch refuses before the first `DROP TABLE` or removal. All drops run in one
transaction with `IF EXISTS`; subsequent filesystem removals can fail independently
and are safe to retry. No cleanup receipt or manifest schema change is required.

Rollback: create each table from its manifest `sql` and import its CSV. The
removed DB files were empty. Copy the fossil directory back from `files/`.
Retention is the operator's decision; QWV-15 keeps the export for 30 days.
