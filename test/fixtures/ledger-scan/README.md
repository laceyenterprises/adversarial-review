`legacy-summaries.json` records the unmodified implementation's output for
`test/helpers/ledger-scan-fixture.mjs`, captured before the LEDGERSCAN-01 source
changes. It contains full and refund-only summaries for every fixture subject.
The regression compares every field, including ordered arrays, with that
baseline. All records are synthetic.

The fixture covers active and terminal buckets, archived stopped jobs,
duplicate archive copies, schema version 1, missing domains, other domains,
PRs 87 and 8776, other repositories, sanitized repository-name collisions,
never-spawned jobs, single-review stops, refunds, published rounds and recorded
final-round heads. A malformed JSON file and a directory ending in `.json`
exercise parse and read failures without depending on process permissions.
