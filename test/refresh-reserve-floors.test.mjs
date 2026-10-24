import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('reserve-floor refresh accepts hex revisions in any case and rejects invalid CLI arguments without writing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'reserve-refresh-'));
  try {
    mkdirSync(join(scratch, 'scripts/contracts'), { recursive: true });
    mkdirSync(join(scratch, 'test/fixtures/producer-contracts'), { recursive: true });
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(scratch, 'node_modules'), 'dir');
    const script = join(scratch, 'scripts/contracts/refresh-reserve-floors.mjs');
    copyFileSync(new URL('../scripts/contracts/refresh-reserve-floors.mjs', import.meta.url), script);
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/producer-contracts/reserve-floors.json', import.meta.url)));
    // Synthetic export envelope around the captured public examples.
    const bytes = JSON.stringify({
      contractVersion: fixture.contractVersion, exportCommand: fixture.exportCommand,
      statusVocabulary: { statuses: [], terminal: [], succeeded: [] },
      producers: { 'reserve-floors': { schema: {}, examples: fixture.examples } },
    });
    const input = join(scratch, 'export.json');
    const output = join(scratch, 'test/fixtures/producer-contracts/reserve-floors.json');
    writeFileSync(input, bytes);
    const revision = fixture.producerRevision;
    const run = args => {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      return result;
    };
    for (const producerRevision of [revision, revision.toUpperCase(), revision.slice(0, 20).toUpperCase() + revision.slice(20)]) {
      const result = run([input, producerRevision]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(output)), {
        contractVersion: fixture.contractVersion, exportCommand: fixture.exportCommand,
        producerRevision, exportSha256: createHash('sha256').update(bytes).digest('hex'),
        examples: fixture.examples,
      });
    }
    const retained = readFileSync(output, 'utf8');
    for (const args of [[], [input], [input, revision.slice(1)], [input, revision + 'a'],
      [input, 'g'.repeat(40)], [input, revision, 'extra']]) {
      const result = run(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /usage: node scripts\/contracts\/refresh-reserve-floors\.mjs/);
      assert.equal(readFileSync(output, 'utf8'), retained);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
