import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetStopReason } from '../src/fleet-stop.mjs';

test('file stop is uncached, accepts no content and preserves merge-only holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-stop-'));
  const directory = join(root, 'control', 'halt');
  const env = { HQ_ROOT: root, AGENT_OS_HQ_ROOT: join(root, 'unused') };
  try {
    assert.equal(fleetStopReason({ env }), null);
    mkdirSync(directory, { recursive: true });
    const active = join(directory, 'active.json');
    writeFileSync(active, 'corrupt', { mode: 0o600 });
    assert.equal(fleetStopReason({ env }), 'fleet-stop-armed');
    rmSync(active);
    symlinkSync(join(root, 'missing'), active);
    assert.equal(fleetStopReason({ env }), 'fleet-stop-armed');
    rmSync(active);
    writeFileSync(join(directory, 'merge-kill.json'), '', { mode: 0o600 });
    assert.equal(fleetStopReason({ env }), 'fleet-stop-armed');
    rmSync(join(directory, 'merge-kill.json'));
    assert.equal(fleetStopReason({ env: { AGENT_OS_HQ_ROOT: root } }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable and invalid latch paths fail closed; only ENOENT permits work', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'ELOOP']) {
    assert.equal(fleetStopReason({ env: { HQ_ROOT: '/fixture' },
      lstatImpl: () => { throw Object.assign(new Error('fixture'), { code }); } }), 'fleet-stop-unreadable');
  }
});
