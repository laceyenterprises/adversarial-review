import { readLaunchRequestStatus } from './launch-status.mjs';

const producer = 'cwp_dispatch.dispatch';

/** @returns {{payload: object, rawIdentity: unknown, launchRequestId: string|null, identityDiagnostic: string|null, status: ReturnType<typeof readLaunchRequestStatus>}} */
export function readDispatchReceipt(value, { identityFields = ['launchRequestId', 'dispatchId', 'lrq'], allowNonObject = false } = {}) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { throw new Error(`${producer}: $stdout invalid JSON`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const diagnostic = `${producer}: $stdout invalid type; expected object`;
    if (!allowNonObject) throw new Error(diagnostic);
    return { payload: value, rawIdentity: null, launchRequestId: null, identityDiagnostic: diagnostic, status: readLaunchRequestStatus(null) };
  }
  const selected = identityFields.find(key => value[key]);
  const rawIdentity = value[selected || identityFields.at(-1)];
  const launchRequestId = typeof rawIdentity === 'string' && rawIdentity.trim() ? rawIdentity : null;
  const identityDiagnostic = launchRequestId ? null : `${producer}: ${(selected ? [selected] : identityFields)
    .map(key => `$.${key} ${Object.hasOwn(value, key) ? 'invalid; expected non-empty string' : 'missing'}`).join('; ')}`;
  const status = readLaunchRequestStatus(value.status);
  if (status.diagnostic) status.diagnostic = `${producer}: $.status ${Object.hasOwn(value, 'status') ? `unrecognized value ${JSON.stringify(value.status)}` : 'missing'}`;
  return { payload: value, rawIdentity, launchRequestId, identityDiagnostic, status };
}

// Compatibility transport shim for stdout banners. Receipt interpretation stays
// in readDispatchReceipt; this function preserves the old last-JSON behavior.
export function parseDispatchJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('cwp_dispatch.dispatch: $stdout empty; hq dispatch returned empty stdout');
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error('cwp_dispatch.dispatch: $stdout invalid JSON; hq dispatch did not return machine-readable JSON');
}
