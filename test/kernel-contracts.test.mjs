import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function runContractsTypecheck() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSC_BIN, '-p', 'tsconfig.contracts.json', '--pretty', 'false'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('kernel adapter contracts type-check', async () => {
  await assert.doesNotReject(() => access(TSC_BIN, constants.F_OK), `Missing ${TSC_BIN}; run npm install first.`);
  const { code, signal, stderr } = await runContractsTypecheck();
  assert.equal(signal, null, `TypeScript typecheck exited via signal ${signal ?? 'unknown'}.\n${stderr}`.trim());
  assert.equal(code, 0, `TypeScript typecheck failed with exit code ${code}.\n${stderr}`.trim());
});
