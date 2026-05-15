import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectEnvSecrets } from './env.mjs';

function parseDotenv(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function injectDotenvSecrets({
  path = '.env',
  env = process.env,
  fsImpl = { readFileSync },
} = {}) {
  const values = parseDotenv(fsImpl.readFileSync(resolve(path), 'utf8'));
  return {
    ...injectEnvSecrets({ env, values }),
    source: 'dotenv',
    path: resolve(path),
  };
}

export {
  injectDotenvSecrets,
  parseDotenv,
};
