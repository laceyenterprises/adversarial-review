import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGeminiQuotaCooldown, readGeminiQuotaCooldownForIdentities, startGeminiQuotaCooldown } from '../src/gemini-quota-cooldown.mjs';

const hqOwner = 'owner-identity';
const added = 'reviewer-b';
const nowMs = Date.parse('2026-10-14T00:00:00Z');
const log = { info() {} };

test('AGYCOOLDOWN-01: independent records retain both reset times and expire separately', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'identity-cooldown-'));
  const options = { rootDir, env: { ADVERSARIAL_REVIEW_STATE_DIR: rootDir }, nowMs, hqOwner, log };
  try {
    const first = startGeminiQuotaCooldown({ ...options, signal: { resetAt: new Date(nowMs + 50 * 3600000).toISOString() } });
    assert.equal(readGeminiQuotaCooldown({ ...options, identityUser: added }), null);
    assert.equal(readGeminiQuotaCooldownForIdentities({ ...options, identities: [hqOwner, added] }), null);
    const second = startGeminiQuotaCooldown({ ...options, identityUser: added, signal: { resetAt: new Date(nowMs + 60 * 3600000).toISOString() } });
    assert.deepEqual(readGeminiQuotaCooldownForIdentities({ ...options, identities: [hqOwner, added] }), {
      identities: [{ user: hqOwner, ...first }, { user: added, ...second }],
    });
    const afterReset = { ...options, nowMs: Date.parse(first.resetAt) };
    assert.equal(readGeminiQuotaCooldown(afterReset), null);
    assert.deepEqual(readGeminiQuotaCooldown({ ...afterReset, identityUser: added }), second);
    assert.equal(readGeminiQuotaCooldownForIdentities({ ...afterReset, identities: [hqOwner, added] }), null);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('AGYCOOLDOWN-01: a legacy global record belongs only to the HQ owner and survives migration', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-cooldown-'));
  const options = { rootDir, env: { ADVERSARIAL_REVIEW_STATE_DIR: rootDir }, nowMs, hqOwner, log };
  try {
    const legacy = { resetAt: new Date(nowMs + 50 * 3600000).toISOString() };
    writeFileSync(join(rootDir, 'gemini-quota-cooldown.json'), JSON.stringify(legacy));
    assert.deepEqual(readGeminiQuotaCooldown(options), legacy);
    assert.equal(readGeminiQuotaCooldown({ ...options, identityUser: added }), null);
    assert.equal(readGeminiQuotaCooldownForIdentities({ ...options, identities: [added] }), null);
    startGeminiQuotaCooldown({ ...options, identityUser: added, signal: {} });
    assert.deepEqual(readGeminiQuotaCooldown(options), legacy);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
