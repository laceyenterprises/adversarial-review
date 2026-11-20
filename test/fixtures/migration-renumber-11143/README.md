# LAC-2127 Agent OS #11143 witness

`history.json.gz` contains immutable Git object reads and the migration-file
subset of the captured primary-change input for
[Agent OS #11143](https://github.com/laceyenterprises/agent-os/pull/11143).
The fixture retains the actual file records and patches for the child wrapper,
revision helpers, registry and SQL. The cost-gate input comes from the same
evaluation. Unrelated file records are omitted from this replay.

| Role | Commit |
| --- | --- |
| Protected author | `19aa526cb45eab79ec61a96a86e90bbe1536c77c` |
| Old merge base | `b7df294fd2426c621fb1e4b506bcb55354ee88b5` |
| First intervening snapshot | `89dfa3f394682d6a85d1cf448586b7a184932398` |
| Second intervening snapshot | `065d37a4b796ab9f8fe4c5aa1418556dce600fd1` |
| Third intervening snapshot | `72250e9cd3026fe33f56626786743bbff6e3900c` |
| Main integration parent | `283d06e47679a91f6802f729a418746608f1e180` |
| Two-parent integrated head | `46d027a4024cdb502381a0376cacb74e54da3e38` |
| First continuation snapshot | `aee9c0cbf89b65dc52cab3ad24acaa886c019f61` |
| Second continuation snapshot | `375e755c091bdccc06f404b1fe43838386891499` |

Commit and tree responses come from the corresponding `git show` and
`git ls-tree` objects. Trees retain their complete direct entries, modes and
object IDs. The legacy recursive lookup projects the measured entry count
above its walk threshold. Blob responses store the exact UTF-8 bytes from
`git cat-file blob`, with the test transport supplying base64 and size. The
main-to-author comparison records the verified divergence and merge base.

The applied parent declares `successful_rss_index_339` in slot 340. The child
uses slot 340 through the three linear snapshots and moves to slot 341 at
integration. The SQL blob stays `41d730aa7930408ac743273a122d41556e0211c5`.
The test checks the native verdict before and after collection and mutates
individual objects and ancestry edges to exercise refusal paths. Replay is
offline and runs no migration code. The continuation test reuses only the
migration-file records for the same objects. Their directory trees are
unchanged across those two commits, as verified by the recorded Git objects.
