#!/usr/bin/env node
import {
  AntigravityBridgeError,
  credentialStatus,
  getAccessToken,
  login,
} from '../src/auth/antigravity-bridge.mjs';

function usage() {
  return `Usage:
  agr-auth login <account-id> [--project-id <project-id>]
  agr-auth status <account-id>

Environment:
  GEMINI_ANTIGRAVITY_BRIDGE_DIR  Override credential directory
  GEMINI_ANTIGRAVITY_CLIENT_ID    OAuth client id for Antigravity login/refresh
  GEMINI_ANTIGRAVITY_CLIENT_SECRET OAuth client secret for Antigravity login/refresh
`;
}

function parseArgs(argv) {
  const [command, accountId, ...rest] = argv;
  const parsed = { command, accountId, projectId: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--project-id') {
      parsed.projectId = rest[i + 1] || '';
      i += 1;
    } else {
      throw new AntigravityBridgeError('CLI_USAGE', `unknown argument: ${arg}`);
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
  console.log('account           email             refresh   access-token   project');
  console.log('----------------  ----------------  -------   ------------   -------');
  if (status.refresh === 'ok') {
    console.log(`${status.accountId.padEnd(16)}  ${redactEmail(status.email).padEnd(16)}  ok        ${tokenStatus.padEnd(12)}   ${status.projectId || '-'}`);
    return;
  }
  console.log(`${status.accountId.padEnd(16)}  ${'unknown'.padEnd(16)}  missing   unavailable    -`);
}

async function main() {
  const { command, accountId, projectId } = parseArgs(process.argv.slice(2));
  if (!command || !accountId || command === '--help' || command === '-h') {
    console.error(usage());
    process.exitCode = command && !accountId ? 1 : 0;
    return;
  }

  if (command === 'login') {
    const result = await login(accountId, { projectId });
    console.log(`logged in account ${result.accountId}`);
    console.log(`email: ${redactEmail(result.email)}`);
    console.log(`credential file: ${result.path}`);
    return;
  }

  if (command === 'status') {
    const status = credentialStatus(accountId);
    let tokenStatus = 'unavailable';
    if (status.refresh === 'ok') {
      try {
        await getAccessToken(accountId);
        tokenStatus = 'valid';
      } catch (err) {
        tokenStatus = err instanceof AntigravityBridgeError && err.code === 'REFRESH_TOKEN_EXPIRED'
          ? 'reauth'
          : 'refresh-failed';
        process.exitCode = 2;
      }
    } else {
      process.exitCode = 1;
    }
    printStatus(status, tokenStatus);
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
