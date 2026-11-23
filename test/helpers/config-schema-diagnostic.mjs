const SCHEMA_DIAGNOSTIC = /^\[adversarial-config\] schema source=(?:bundled sha256=[a-f0-9]{64} fallback=|contract sha256=[a-f0-9]{64} path=)[^\r\n]+$/;

export function isConfigSchemaDiagnostic(line) {
  return SCHEMA_DIAGNOSTIC.test(line);
}

export function withoutConfigSchemaDiagnostics(stderr) {
  return stderr.split('\n').filter(line => !isConfigSchemaDiagnostic(line)).join('\n');
}
