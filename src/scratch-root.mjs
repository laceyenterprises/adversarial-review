import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_NAME = '.metadata_never_index';
const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function ensureSpotlightExcludedScratchRoot(rootDir, scope = 'runtime') {
  const scratchRoot = resolve(rootDir || MODULE_ROOT, 'data', 'scratch', scope);
  mkdirSync(scratchRoot, { recursive: true });
  try {
    writeFileSync(join(scratchRoot, MARKER_NAME), '');
  } catch {
    // Best-effort marker: scratch placement is still safer here than under an
    // inherited per-user TMPDIR, and the OJO health assertion reports drift.
  }
  return scratchRoot;
}

function scratchPrefix(rootDir, scope, prefix) {
  return join(ensureSpotlightExcludedScratchRoot(rootDir, scope), prefix);
}

export { MARKER_NAME, ensureSpotlightExcludedScratchRoot, scratchPrefix };
