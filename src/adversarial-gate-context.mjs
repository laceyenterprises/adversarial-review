const DEFAULT_ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';
const ADVERSARIAL_GATE_CONTEXT_ENV_VAR = 'ADV_GATE_STATUS_CONTEXT';

function resolveGateStatusContext(env = process.env) {
  const raw = env?.[ADVERSARIAL_GATE_CONTEXT_ENV_VAR];
  if (typeof raw !== 'string') {
    return DEFAULT_ADVERSARIAL_GATE_CONTEXT;
  }
  if (/[\r\n]/.test(raw)) {
    throw new Error(
      `${ADVERSARIAL_GATE_CONTEXT_ENV_VAR} must not contain CR or LF characters`
    );
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return DEFAULT_ADVERSARIAL_GATE_CONTEXT;
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(
      `${ADVERSARIAL_GATE_CONTEXT_ENV_VAR} must not contain control characters`
    );
  }
  return trimmed;
}

export {
  ADVERSARIAL_GATE_CONTEXT_ENV_VAR,
  DEFAULT_ADVERSARIAL_GATE_CONTEXT,
  resolveGateStatusContext,
};
