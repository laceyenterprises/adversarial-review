import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolve at call time so callers can supply their own environment.
export function resolveHqRoot(env = process.env) {
  return env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
}
