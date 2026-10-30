import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const payload = Buffer.from(JSON.stringify({
  sub: 'synthetic-user', email: 'synthetic@example.invalid',
  'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
})).toString('base64url');
export const dummyCodexAuth = {
  auth_mode: 'chatgpt',
  tokens: {
    id_token: `e30.${payload}.synthetic`,
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-source-refresh-token',
    account_id: 'synthetic-account',
  },
};

export function writeDummyCodexAuth(authPath) {
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify(dummyCodexAuth), { mode: 0o600 });
  return authPath;
}

// Supported CLI file-store boundary: deliberately ignores CODEX_AUTH_PATH.
// Every caller must present credentials through CODEX_HOME/auth.json.
export function serviceFixtureExec(_command, args, { env }) {
  const auth = JSON.parse(readFileSync(join(env.CODEX_HOME, 'auth.json'), 'utf8'));
  assert.equal(auth.auth_mode, 'chatgpt');
  assert.ok(auth.tokens.access_token);
  assert.equal(auth.tokens.refresh_token, 'agent-os-per-worker-placeholder-no-rotate');
  if (args[0] === 'login') return 'Logged in using ChatGPT';
  assert.deepEqual(args, ['debug', 'models']);
  const config = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');
  const model = JSON.parse(config.match(/^model = (.+)$/m)[1]);
  return JSON.stringify({ models: [{ slug: model }] });
}
