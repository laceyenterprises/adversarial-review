// Synthetic, offline CLI. Flag names and envelope shapes follow the adapter's
// README, CLI parser and UNSUPPORTED-OPERATION-CONTRACT.md.
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('./read-contract.json', import.meta.url)));
const [unsupportedCommand, command, ...args] = process.argv.slice(2);
const entry = contract[command];
function refuse(failureClass, code, requested) {
  console.log(JSON.stringify({ ok: false, complete: false, failureClass, code, requested,
    supported: Object.keys(contract) }));
  process.exit(failureClass === 'unsupported' ? 78 : 64);
}
if (!entry || command === unsupportedCommand) refuse('unsupported', 'unsupported_command', command);
if (!args.includes('--json')) refuse('input', 'missing_json', '--json');
const authFlags = ['--auth', '--auth-mode', '--pat-env', '--expected-login',
  '--broker-provider', '--expected-app-id', '--expected-installation-id'];
for (let i = 0; i < args.length; i++) {
  if (['--json', '--no-graphql'].includes(args[i])) continue;
  if (![...entry.flags, ...authFlags].includes(args[i]) || args[i + 1] === undefined) {
    refuse('input', 'invalid_argument', args[i]);
  }
  i++;
}
console.log(JSON.stringify({ ok: true, complete: true, source: 'fixture',
  failureClass: null, auth: { mode: 'fixture' }, ...entry.payload }));
