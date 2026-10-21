// Producer text is evidence, but must not grow durable audits on every hold.
export function diagnosticValue(value) {
  let text;
  try { text = JSON.stringify(value) ?? String(value); }
  catch { text = '[unserializable]'; }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export function boundedDiagnostics(values) {
  const result = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string' || !value) continue;
    result.add(value.length > 500 ? `${value.slice(0, 499)}…` : value);
    if (result.size === 20) break;
  }
  return [...result];
}
