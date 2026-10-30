#!/usr/bin/env node
// Offline subprocess double for the supported file credential store. Never
// inspect the caller's source path, keychain, HOME or any network endpoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
try {
  const config = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
  if (!/cli_auth_credentials_store = "file"/.test(config)
    || auth.auth_mode !== 'chatgpt' || !auth.tokens.access_token
    || !auth.tokens.id_token) throw new Error();
  if (args.join(' ') === 'login status') {
    console.error('Logged in using ChatGPT');
  } else if (args.join(' ') === 'debug models') {
    console.log(JSON.stringify({ models: [{ slug: JSON.parse(config.match(/^model = (.+)$/m)[1]) }] }));
  } else {
    throw new Error();
  }
} catch {
  console.error('Not logged in');
  process.exitCode = 1;
}
