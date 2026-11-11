// Logical remediation routes are distinct from HQ admission classes.
export function normalizeRemediationWorkerClass(workerClassInput) {
  const workerClass = String(workerClassInput || '').trim().toLowerCase();
  if (!workerClass) return null;
  switch (workerClass) {
    case 'grok-remediation':
      return 'remediator-grok';
    case 'remediator-grok':
    case 'remediator-codex':
    case 'remediator-codex-corp':
    case 'remediator-claude':
    case 'remediator-claude-corp':
      return workerClass;
    case 'codex-corp':
      return 'remediator-codex-corp';
    case 'codex':
    case 'codex-remediation':
      return 'codex';
    case 'claude':
    case 'claude-code':
    case 'claude-code-remediation':
      return 'claude-code';
    case 'remediator-gemini':
    case 'gemini':
    case 'gemini-remediation':
      return 'gemini';
    default:
      return null;
  }
}

// Family detection does not grant dispatch admission. Keep legacy actor aliases
// fenced too, while canonical remediation routes use the normalizer above.
export function isGrokRemediationWorkerClass(workerClassInput) {
  if (normalizeRemediationWorkerClass(workerClassInput) === 'remediator-grok') return true;
  const workerClass = String(workerClassInput || '').trim().toLowerCase();
  return ['grok', 'grok-api', 'grok-reviewer', 'hammer-grok'].includes(workerClass);
}

// Only remediation dispatch translates this route. Builder/reviewer callers must
// continue using their own classes and identity admission.
export function hqRemediationWorkerClass(workerClass) {
  return normalizeRemediationWorkerClass(workerClass) === 'gemini'
    ? 'remediator-gemini' : workerClass;
}
