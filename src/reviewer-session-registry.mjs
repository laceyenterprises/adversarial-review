// Track durable reviewer runtime session UUIDs for observability on exit.
// Routine daemon bounces must not cancel these children: reviewer
// subprocesses are launched as bounce survivors and startup reconciliation
// re-adopts them via the durable review row plus PGID identity checks.
//
// ARC-18: these two module-level mutable collections are shared by the
// reviewer spawn/settle cluster AND the fence/sigterm cluster. They are
// extracted here so both leaf modules mutate the same live references
// (importing a binding shares the collection object, exactly like a normal
// shared object). They are only ever method-mutated (add/set/delete/has/
// clear/iteration) and never reassigned.
export const inFlightReviewerSessions = new Set();
export const activeReviewerSpawns = new Map();
