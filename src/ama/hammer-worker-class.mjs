// Worker classes that engage the AMA hammer (terminal-remediation + merge) route.
// `hammer` = codex harness (default); `hammer-claude` = claude-opus-5 harness used
// when codex quota is exhausted (PR #786). Both must engage every route gate that
// previously keyed on the literal string 'hammer'.
export const HAMMER_WORKER_CLASSES = Object.freeze(['hammer', 'hammer-claude']);
export function isHammerWorkerClass(workerClass) {
  return HAMMER_WORKER_CLASSES.includes(String(workerClass || '').trim());
}
