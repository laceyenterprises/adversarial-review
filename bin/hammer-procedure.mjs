#!/usr/bin/env node
// Run the versioned HAM shell procedures with dispatch values supplied as HAM_* env.
// Keep the transcript small even if a GitHub or git command is noisy.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const phases = new Set(['hammer-verify-head', 'hammer-publish', 'hammer-merge']);
const phase = process.argv[2];
if (!phases.has(phase) || process.argv[3] !== '--render' || process.argv.length !== 4) {
  process.stderr.write('usage: hammer-procedure.mjs <hammer-verify-head|hammer-publish|hammer-merge> --render\n');
  process.exit(64);
}
const path = join(dirname(fileURLToPath(import.meta.url)), `${phase}.sh`);
let source = readFileSync(path, 'utf8');
// These defaults belong to the versioned procedure, never the renderer's
// caller environment. Embed each floor at the assignment's original site.
source = source.replace(
  /^(HAM_[A-Z_]*(?:WAIT_SECONDS|POLL_SECONDS|RETRY_CAP|ATTEMPT_CAP|FAILURE_LIMIT|BACKOFF_BASE_SECONDS|NOMINAL_SECONDS))="\$\{\1:-([0-9]+)\}"$/gm,
  (_match, name, floor) => `ham_procedure_floor ${name} ${floor}`,
);
source = `# Waits are fixed by the procedure; do not export or shorten them.
# A hammer that has only the lease left waits for it.
ham_procedure_floor() {
  local name="$1" floor="$2" given used
  given="\${!name-}"
  used="$floor"
  if [[ "$given" =~ ^[0-9]+$ ]] && [ "\${#given}" -le 9 ] && [ "$((10#$given))" -ge "$floor" ]; then
    used="$((10#$given))"
  elif [ -n "$given" ]; then
    echo "HAM procedure floor: $name given=$given used=$used" >&2
  fi
  printf -v "$name" '%s' "$used"
}
${source}`;
const missing = new Set();
source = source.replace(/<<([A-Z_]+)>>/g, (_match, key) => {
  const value = process.env[`HAM_${key}`];
  if (value === undefined || value === '') {
    missing.add(key);
    return '';
  }
  return value;
});
if (missing.size) {
  process.stderr.write(`missing dispatch values: ${[...missing].join(', ')}\n`);
  process.exit(64);
}
process.stdout.write(source);
