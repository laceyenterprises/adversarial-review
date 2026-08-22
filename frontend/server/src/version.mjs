/**
 * Build identity for the version endpoint.
 *
 * Read from package.json at runtime rather than duplicated in a constant, so the
 * reported version cannot drift from the package it was built from.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/** API contract version — bumped when a read projection's shape changes. */
export const API_VERSION = 1;

let cached = null;

export function versionInfo() {
  if (cached) return cached;
  let name = '@arf/server';
  let version = '0.0.0-unknown';
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    name = String(pkg.name ?? name);
    version = String(pkg.version ?? version);
  } catch {
    // A package.json that cannot be read is not worth failing a boot over; the
    // sentinel version says "unknown" instead of claiming a version it isn't.
  }
  cached = { name, version, apiVersion: API_VERSION, node: process.version };
  return cached;
}
