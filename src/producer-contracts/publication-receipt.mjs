/**
 * ResultEnvelope evidence shared by adapter reads and publication mutations.
 * Diagnostics do not tighten the callers' historical acceptance/complete rules.
 * @returns {{payload: any, accepted: boolean, complete: boolean|null, diagnostics: string[]}}
 */
export function readAdapterReceipt(payload) {
  const diagnostics = [];
  for (const key of ['ok', 'complete']) {
    if (typeof payload?.[key] !== 'boolean') diagnostics.push(`agent_os_github_adapter.ResultEnvelope: $.${key} missing/invalid boolean`);
    else if (!payload[key]) diagnostics.push(`agent_os_github_adapter.ResultEnvelope: $.${key}=false`);
  }
  return { payload, accepted: payload?.ok === true,
    complete: typeof payload?.complete === 'boolean' ? payload.complete : null, diagnostics };
}

/**
 * Remote acceptance can precede failed local completion; never infer delivery.
 * @returns {{accepted: boolean, url: unknown, output: unknown, diagnostics: string[]}}
 */
export function readPrCreateReceipt(payload) {
  const accepted = payload?.ok === true;
  const diagnostics = [];
  if (!accepted) diagnostics.push(`agent_os_github_adapter.create_pr: $.ok=${JSON.stringify(payload?.ok)}; $.failureClass=${JSON.stringify(payload?.failureClass)}`);
  if (accepted && (typeof payload?.url !== 'string' || !payload.url)) diagnostics.push('agent_os_github_adapter.create_pr: $.url missing/invalid after remote acceptance');
  return { accepted, url: payload?.url || '', output: payload?.output || '', diagnostics };
}
