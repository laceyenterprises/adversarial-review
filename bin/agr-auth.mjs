#!/usr/bin/env node
import {
  AntigravityBridgeError,
  credentialStatus,
  getAccessToken,
  listCredentialAccounts,
  login,
  resolveBridgeDir,
} from '../src/auth/antigravity-bridge.mjs';

function usage() {
  return `Usage:
  agr-auth login <account-id> [--project-id <project-id>]
  agr-auth status [account-id] [--check-token]

Environment:
  GEMINI_ANTIGRAVITY_BRIDGE_DIR  Override credential directory
  GEMINI_ANTIGRAVITY_CLIENT_ID    OAuth client id for Antigravity login/refresh
  GEMINI_ANTIGRAVITY_CLIENT_SECRET OAuth client secret for Antigravity login/refresh
`;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  const parsed = { command, accountId: '', projectId: '', checkToken: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--project-id') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new AntigravityBridgeError('CLI_USAGE', '--project-id requires a value');
      parsed.projectId = args[i + 1];
      i += 1;
    } else if (arg === '--check-token') {
      parsed.checkToken = true;
    } else if (arg.startsWith('--')) {
      throw new AntigravityBridgeError('CLI_USAGE', `unknown argument: ${arg}`);
    } else if (!parsed.accountId) {
      parsed.accountId = arg;
    } else {
      throw new AntigravityBridgeError('CLI_USAGE', `unexpected extra argument: ${arg}`);
    }
  }
  return parsed;
}

function redactEmail(email) {
  if (!email || !email.includes('@')) return email || 'unknown';
  const [local, domain] = email.split('@');
  const safeLocal = local.length <= 2 ? `${local[0] || ''}...` : `${local.slice(0, 2)}...`;
  return `${safeLocal}@${domain}`;
}

function printStatus(status, tokenStatus) {
  if (status.refresh === 'ok') {
    console.log(`${status.accountId.padEnd(16)}  ${redactEmail(status.email).padEnd(16)}  ok        ${tokenStatus.padEnd(12)}   ${status.projectId || '-'}`);
    return;
  }
  const refreshStatus = status.errorCode === 'CREDS_MISSING' ? 'missing' : 'invalid';
  console.log(`${status.accountId.padEnd(16)}  ${'unknown'.padEnd(16)}  ${refreshStatus.padEnd(7)}   unavailable    -`);
}

async function statusAccounts(accountIds, { checkToken = false } = {}) {
  if (accountIds.length === 0) {
    console.log(`No Antigravity credential files found in ${resolveBridgeDir()}`);
    return 1;
  }
  console.log('account           email             refresh   access-token   project');
  console.log('----------------  ----------------  -------   ------------   -------');
  let exitCode = 0;
  for (const accountId of accountIds) {
    const status = credentialStatus(accountId);
    let tokenStatus = checkToken ? 'unavailable' : 'not-checked';
    if (status.refresh === 'ok' && checkToken) {
      try {
        await getAccessToken(accountId);
        tokenStatus = 'valid';
      } catch (err) {
        tokenStatus = err instanceof AntigravityBridgeError && err.code === 'REFRESH_TOKEN_EXPIRED'
          ? 'reauth'
          : 'refresh-failed';
        exitCode = 2;
      }
    } else if (status.refresh !== 'ok') {
      exitCode = 1;
    }
    printStatus(status, tokenStatus);
  }
  return exitCode;
}

async function main() {
  const { command, accountId, projectId, checkToken } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h') {
    console.error(usage());
    process.exitCode = 0;
    return;
  }

  if (command === 'login') {
    if (!accountId) throw new AntigravityBridgeError('CLI_USAGE', 'login requires <account-id>');
    const result = await login(accountId, { projectId });
    console.log(`logged in account ${result.accountId}`);
    console.log(`email: ${redactEmail(result.email)}`);
    console.log(`credential file: ${result.path}`);
    return;
  }

  if (command === 'status') {
    const accountIds = accountId ? [accountId] : listCredentialAccounts();
    process.exitCode = await statusAccounts(accountIds, { checkToken });
    return;
  }

  throw new AntigravityBridgeError('CLI_USAGE', `unknown command: ${command}`);
}

main().catch((err) => {
  if (err instanceof AntigravityBridgeError && err.code === 'CLI_USAGE') {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
  }
  console.error(err.message);
  process.exit(1);
});
