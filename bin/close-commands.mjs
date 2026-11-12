#!/usr/bin/env node
// HAMCONTROLLERSCRIPT-01: the merge-agent's validation commands are data. Read
// the commands file and print one shell-quoted hammer-validate argv per line
// for the shipped close controller. The controller runs each validator as its
// own direct child (the hammer controller admits only that process shape), so
// this helper never runs a command itself.
//
//   {"validations": [{"pytest": true, "args": ["tests/test_example.py"]},
//                    {"args": ["npm", "test", "--", "test/example.test.mjs"]}]}
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function parseCloseCommands(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('commands file is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => key !== 'validations')) {
    throw new Error('commands file must be {"validations": [...]}');
  }
  const { validations } = parsed;
  if (!Array.isArray(validations) || validations.length === 0) {
    throw new Error('validations must list at least one validation');
  }
  return validations.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['pytest', 'args'].includes(key))) {
      throw new Error(`validations[${index}] must hold only "args" and optional "pytest"`);
    }
    if (entry.pytest !== undefined && typeof entry.pytest !== 'boolean') {
      throw new Error(`validations[${index}].pytest must be a boolean`);
    }
    if (!Array.isArray(entry.args) || entry.args.length === 0
      || entry.args.some(arg => typeof arg !== 'string' || arg === '' || /[\0\r\n]/.test(arg))) {
      throw new Error(`validations[${index}].args must be non-empty single-line strings`);
    }
    return [...(entry.pytest ? ['--pytest'] : []), '--', ...entry.args];
  });
}

export function renderCloseCommands(argvs) {
  return argvs.map(argv => argv.map(shellQuote).join(' ')).join('\n') + '\n';
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length) {
    process.stderr.write('usage: close-commands.mjs <commands.json>\n');
    process.exit(64);
  }
  try {
    process.stdout.write(renderCloseCommands(parseCloseCommands(readFileSync(path, 'utf8'))));
  } catch (error) {
    process.stderr.write(`close-commands-invalid: ${error.code === 'ENOENT' ? 'commands file is missing' : error.message}\n`);
    process.exit(65);
  }
}
