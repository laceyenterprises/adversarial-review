import { readLaunchRequestStatus } from './launch-status.mjs';

const producer = 'cwp_dispatch.dispatch';

/** @returns {{payload: any, rawIdentity: unknown, launchRequestId: string|null, identityDiagnostic: string|null, status: ReturnType<typeof readLaunchRequestStatus>}} */
export function readDispatchReceipt(value, { identityFields = ['launchRequestId', 'dispatchId', 'lrq'], allowNonObject = false } = {}) {
  if (typeof value === 'string' && !allowNonObject) {
    try { value = JSON.parse(value); }
    catch { throw new Error(`${producer}: $stdout invalid JSON`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const diagnostic = `${producer}: $stdout invalid type; expected object`;
    if (!allowNonObject) throw new Error(diagnostic);
    return { payload: value, rawIdentity: null, launchRequestId: null, identityDiagnostic: diagnostic, status: readLaunchRequestStatus(null) };
  }
  const selected = identityFields.find(key => typeof value[key] === 'string' ? value[key].trim() : value[key]);
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

// Status probes describe dispatch/worker records, not launch_requests rows.
// Keep their vocabulary and producer diagnostics intact.
export function parseHqJsonObject(text, label) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error(`cwp_dispatch.dispatch: $stdout empty; ${label} produced empty output`);
  try { return JSON.parse(raw); }
  catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); }
      catch (cause) { throw new Error(`cwp_dispatch.dispatch: $stdout invalid JSON; ${label} did not return JSON`, { cause }); }
    }
    throw new Error(`cwp_dispatch.dispatch: $stdout invalid JSON; ${label} did not return JSON`);
  }
}

export function parseHqDispatchStatus(stdout, { normalize = true } = {}) {
  const payload = parseHqJsonObject(stdout, 'hq dispatch status');
  const status = String(payload?.status || '').trim().toLowerCase();
  if (!status) throw new Error('cwp_dispatch.dispatch: $.status missing/invalid; hq dispatch status payload missing status');
  if (!normalize) return { ...payload };
  return { ...payload, status, health: String(payload?.health || '').trim().toLowerCase() || null };
}
