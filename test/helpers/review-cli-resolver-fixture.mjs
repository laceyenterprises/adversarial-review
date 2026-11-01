import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Existing spawn-mock suites must never consult a host resolver. The fake owns
// synthetic policy; production Node code only consumes the protocol.
const root = mkdtempSync(join(tmpdir(), 'review-resolver-fixture-'));
export const fixtureHq = join(root, 'hq');
export const fixtureCliPath = (cli) => join(root, cli);
for (const cli of ['claude', 'codex', 'gemini', 'agy']) {
  writeFileSync(fixtureCliPath(cli), '#!/bin/sh\nexit 78\n', { mode: 0o700 });
}
writeFileSync(fixtureHq, `#!${process.execPath}
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const args = process.argv.slice(2);
if (args.length !== 7 || args[0] !== 'cli' || args[1] !== 'resolve'
  || args[2] !== '--cli' || args[4] !== '--consumer'
  || args[5] !== 'review' || args[6] !== '--json') process.exit(2);
const cli = args[3], key = cli.toUpperCase();
const override = process.env[key + '_CLI_PATH']
  || (cli === 'claude' && process.env.CLAUDE_CODE_CLI_PATH)
  || process.env[key + '_CLI'];
const fromPath = (process.env.PATH || '').split(':').filter(Boolean)
  .filter(dir => dir.startsWith(${JSON.stringify(tmpdir())} + '/'))
  .map(dir => join(dir, cli)).find(candidate => existsSync(candidate));
if (!override && !fromPath && process.env.PATH === '') process.exit(2);
const candidate = override || fromPath || ${JSON.stringify(root)} + '/' + cli;
const selectedPath = isAbsolute(candidate) ? candidate : (fromPath || ${JSON.stringify(root)} + '/' + cli);
console.log(JSON.stringify({ schemaVersion: 1, cli,
  source: override ? 'override' : 'fallback', selectedPath,
  realPath: selectedPath, version: 'synthetic-1', binarySha256: 'a'.repeat(64) }));
`, { mode: 0o700 });
process.env.HQ_BIN = fixtureHq;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
