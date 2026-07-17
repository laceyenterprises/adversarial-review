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
  return JSON.parse(readFileSync(join(rootDir, 'domains', `${domainId}.json`), 'utf8'));
}

export { loadDomainConfig };
