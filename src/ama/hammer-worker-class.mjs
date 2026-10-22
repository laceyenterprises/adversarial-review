// Worker classes that engage the AMA hammer (terminal-remediation + merge) route.
// `hammer` = codex harness (default); `hammer-claude` = claude-opus-5 harness used
// when codex quota is exhausted (PR #786). CCX-11 adds the codex-corp account
// twin. All three engage every route gate previously keyed on literal hammer.
import { expandClassAliases } from '../worker-class-aliases.mjs';
export const HAMMER_WORKER_CLASSES = Object.freeze(expandClassAliases(['hammer', 'hammer-claude']));
export function isHammerWorkerClass(workerClass) {
  return HAMMER_WORKER_CLASSES.includes(String(workerClass || '').trim());
}
