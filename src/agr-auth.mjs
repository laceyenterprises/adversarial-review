#!/usr/bin/env node
import {
  AntigravityAuthError,
  assertAntigravityCredsReadable,
  getAccessToken,
  listCredentialAccounts,
  login,
  resolveBridgeDir,
} from './auth/antigravity-bridge.mjs';

function usage() {
  return `Usage:
  agr-auth login <account-id> [--project-id <project-id>]
  agr-auth status [account-id]

Environment:
  GEMINI_ANTIGRAVITY_BRIDGE_DIR  Override credential directory
  GEMINI_ANTIGRAVITY_CLIENT_ID   OAuth client id for Antigravity login/refresh
  GEMINI_ANTIGRAVITY_CLIENT_SECRET OAuth client secret for Antigravity login/refresh
`;
}

function parseArgs(argv) {
  const [command, maybeAccountId, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--project-id') {
      options.projectId = rest[i + 1];
      i += 1;
    } else {
      throw new AntigravityAuthError('invalid-arguments', `unknown argument: ${arg}`);
    }
  }
  return { command, accountId: maybeAccountId, options };
}

function formatStatusLine(accountId, result) {
  const email = result.email ? `${result.email.replace(/^(.{2}).*(@.*)$/, '$1...$2')}` : 'unknown';
  if (result.ok) {
    const minutes = Math.max(0, Math.floor((result.expiresAt - Date.now()) / 60000));
    return `${accountId}\t${email}\trefresh ok\taccess valid ${minutes}m`;
  }
  return `${accountId}\t${email}\trefresh ${result.code || 'error'}\taccess unavailable`;
}

async function status(accountId) {
  const accountIds = accountId ? [accountId] : listCredentialAccounts();
  if (accountIds.length === 0) {
    process.stdout.write(`No Antigravity credential files found in ${resolveBridgeDir()}\n`);
    return 1;
  }

  process.stdout.write('account\temail\trefresh\taccess-token\n');
  let exitCode = 0;
  for (const id of accountIds) {
    let email = '';
    try {
      const readable = assertAntigravityCredsReadable(id);
      email = readable.email;
      const token = await getAccessToken(id);
      process.stdout.write(`${formatStatusLine(id, { ok: true, email, expiresAt: token.expiresAt })}\n`);
    } catch (err) {
      exitCode = 1;
      process.stdout.write(`${formatStatusLine(id, { ok: false, email, code: err.code })}\n`);
    }
  }
  return exitCode;
}

async function main(argv = process.argv.slice(2)) {
  const { command, accountId, options } = parseArgs(argv);
  if (command === 'login') {
    if (!accountId) throw new AntigravityAuthError('invalid-arguments', 'login requires <account-id>');
    const result = await login(accountId, options);
    process.stdout.write(`Antigravity credentials saved for ${accountId} (${result.email}) at ${result.path}\n`);
    return 0;
  }
  if (command === 'status') {
    return status(accountId);
  }
  process.stderr.write(usage());
  return 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  if (err instanceof AntigravityAuthError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err?.message || String(err)}\n`);
  }
  process.exitCode = 1;
});
