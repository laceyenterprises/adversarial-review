// Age predicate for watcher-autonomous phantom-completion recovery.
//
// Extracted from follow-up-merge-agent.mjs to keep that module under the
// ARC-19 decrease-only line ceiling (see test/arc19-boundary-gate.test.mjs).
//
// Age is measured from `dispatchedAt` (LRQ admission time), NOT from when the
// terminal state was first durably observed, because HQ records no per-dispatch
// `completedAt` (adversarial review #856). Paired with the caller's
// `diedWithoutHandoff` gate — the `merge-agent-dispatched` marker is still
// present, i.e. the worker has already terminated without a clean handoff — a
// `>= minAge` admission age is a conservative floor: it avoids re-dispatching
// brand-new admissions while still recovering genuinely-stranded phantom
// completions. The min-age threshold is passed explicitly by the caller.
export function isRecordedDispatchAtLeastStuckMinAge(recordedDispatch, now, minAgeMinutes) {
  const dispatchedAtMs = Date.parse(String(recordedDispatch?.dispatchedAt || ''));
  if (!Number.isFinite(dispatchedAtMs)) return false;
  const nowMs = Date.parse(String(now || ''));
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (effectiveNowMs - dispatchedAtMs) / 60_000 >= minAgeMinutes;
}
