import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const form of ['absolute path', 'file URL']) {
  test(`absence composition accepts an SDK ${form} with URL-sensitive characters`, t => {
    const root = mkdtempSync(join(tmpdir(), 'absence-composition-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sdkRoot = join(root, 'sdk with spaces # and %');
    mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
    writeFileSync(join(sdkRoot, 'package.json'), JSON.stringify({ version: '0.8.0-synthetic' }));
    const entry = join(sdkRoot, 'dist/index.mjs');
    // Synthetic public envelope; real producer HTTP composition remains in its
    // owning suite. Exercise native audited settlement in disposable stores.
    writeFileSync(entry, `
      export async function readSessionDispatchLookup(selector) {
        return { schema_version: 1, status: 'not_found', complete: true,
          roots: [], items: [], retry_edges: [], scope_complete: true,
          absence_proof: { version: 1, kind: 'canonical-exact-selector-absence',
            selector, grant_id: 'incident-synthetic-attempt', observed_at: '2026-01-01T01:00:00Z' } };
      }
    `);
    const input = { scenario: 'absent', root: join(root, 'state'),
      sdk_entry: form === 'absolute path' ? entry : pathToFileURL(entry).href };
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('./helpers/absence-settlement-composition.mjs', import.meta.url)),
      JSON.stringify(input),
    ], { encoding: 'utf8', timeout: 15000 });
    const result = JSON.parse(output);
    assert.equal(result.scenario, 'absent');
    assert.equal(result.sdkVersion, '0.8.0-synthetic');
    assert.ok(result.calls > 0);
  });
}
