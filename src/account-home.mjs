import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

// os.homedir() also consults the process HOME. userInfo() reads the OS
// account record, which lets callers bypass missing or relative HOME values.
export function resolveHomeDir(env = process.env) {
  const home = env?.HOME;
  if (typeof home === 'string' && isAbsolute(home)) return home;
  try {
    const accountHome = userInfo().homedir;
    return typeof accountHome === 'string' && isAbsolute(accountHome) ? accountHome : null;
  } catch {
    return null;
  }
}

export function resolveHomePath(env, ...segments) {
  const home = resolveHomeDir(env);
  return home ? join(home, ...segments) : null;
}
