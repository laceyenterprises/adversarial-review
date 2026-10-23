import { delimiter, join } from 'node:path';

export const LEASE_VALIDATION_IDLE_MS = 120_000;

// Remove live runtime routing, never explicit disposable test-DB opt-ins.
// The repository's real fixtures still decide which tests require Postgres.
export function pytestValidationEnvironment(env, scratch, pluginDir) {
  const result = { ...env };
  for (const key of [
    'AGENT_OS_SESSION_LEDGER_DSN', 'AGENT_OS_SESSION_LEDGER_DSN_DIRECT',
    'AGENT_OS_SESSION_LEDGER_SERVICE_ROOT', 'AGENT_OS_SESSION_LEDGER_DUAL_WRITE',
    'AGENT_OS_SESSION_LEDGER_BACKEND_SHADOW_READ',
  ]) delete result[key];
  return { ...result,
    AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite',
    AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off',
    AGENT_OS_SESSION_LEDGER_VDB: 'false',
    AGENT_OS_SESSION_LEDGER_DB_PATH: join(scratch, 'ledger.db'),
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: [pluginDir, env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
}
