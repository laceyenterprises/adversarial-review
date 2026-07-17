import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load a domain configuration document (`domains/<id>.json`).
 *
 * Kept dependency-free (no adapter/DB imports) so the reviewer and remediator
 * can resolve their domain-declared `promptSet` at module load without pulling
 * the reviewer-runtime adapter graph into their import chains.
 *
 * @param {string} rootDir - repository root containing the `domains/` directory
 * @param {string} domainId - domain id, e.g. `code-pr`
 * @returns {object} parsed domain config
 */
function loadDomainConfig(rootDir, domainId) {
  let raw;
  try {
    raw = readFileSync(join(rootDir, 'domains', `${domainId}.json`), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Let resolvePromptSet throw its classified missing-domain-config
      // PromptSetResolutionError instead of a bare ENOENT (review finding
      // on #614): the error-classification contract is the caller's.
      return null;
    }
    throw err;
  }
  return JSON.parse(raw);
}

export { loadDomainConfig };
