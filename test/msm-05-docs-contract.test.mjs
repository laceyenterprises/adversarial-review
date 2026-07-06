import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_AGENT_OS_ROOT = resolve(new URL('..', import.meta.url).pathname, '..', 'agent-os');
const AGENT_OS_ROOT = process.env.AGENT_OS_ROOT || DEFAULT_AGENT_OS_ROOT;

function readAgentOsDoc(relativePath) {
  return readFileSync(resolve(AGENT_OS_ROOT, relativePath), 'utf8');
}

test('MSM-05 docs no longer describe an agent spawned solely to click merge', (t) => {
  if (!existsSync(resolve(AGENT_OS_ROOT, 'CLAUDE.md'))) {
    t.skip('Agent OS checkout unavailable; set AGENT_OS_ROOT to run the cross-repo docs contract');
    return;
  }

  const claude = readAgentOsDoc('CLAUDE.md');
  const autoRemediationSpec = readAgentOsDoc('docs/SPEC-adversarial-review-auto-remediation.md');
  const amaSpec = readAgentOsDoc('projects/adversarial-merge-authority/SPEC.md');

  assert.match(claude, /merges under its own lease/i);
  assert.match(claude, /no agent spawned solely to click merge/i);
  assert.doesNotMatch(claude, /dispatch(?:es)? a closer worker/i);

  assert.match(autoRemediationSpec, /two-path\s+merge model/i);
  assert.match(autoRemediationSpec, /no\s+agent spawned solely to click merge/i);
  assert.doesNotMatch(autoRemediationSpec, /dispatch(?:es)? a closer worker/i);

  assert.match(amaSpec, /Status:\*\* Superseded/i);
  assert.match(amaSpec, /agent-spawn closer described in this document is no longer/i);
});
