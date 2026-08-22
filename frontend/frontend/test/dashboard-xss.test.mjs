import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '../dashboard.mjs'), 'utf8');

describe('review dashboard XSS guard', () => {
  it('renders dashboard API payloads without innerHTML sinks', () => {
    assert.ok(source.includes('textContent'));
    assert.ok(source.includes('replaceChildren'));
    assert.ok(!source.includes('innerHTML'));
  });

  it('keeps accessibility and malformed-round guards explicit', () => {
    assert.ok(source.includes("heading.id = 'dashboard-heading'"));
    assert.ok(source.includes('Array.isArray(r.passes)'));
  });
});
