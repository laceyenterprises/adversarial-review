# Local merge lease reclaim coverage

The capped-polling CLI test proves the waiting caller reclaims a holder on the
first poll after its process dies, before the existing lease deadline. The
original non-progress case, where the holder is already dead on the first
poll, remains covered separately. Both cases use a deterministic clock and
run offline without production state. The other findings in this batch were
addressed in #1949 and #1950; this change adds the remaining regression guard.
