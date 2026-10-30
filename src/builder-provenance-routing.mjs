import { repositoryObservationCache } from './repository-state-cache.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { normalizeBuilderClass } from './adapters/subject/github-pr/routing.mjs';
import { readPrBuilderProvenance, readPrBuilderProvenanceAsync } from './session-ledger-read-adapter.mjs';

export function reconcileBuilderClass(subject, provenance) {
  const actual = provenance?.ok && normalizeBuilderClass(provenance.actualHarness);
  if (!actual) {
    return {
      subject,
      // Inconclusive public observations retain the title route for review
      // intake only. This finding supplies no merge or ownership authority.
      deferClaim: provenance?.deferClaim === true || provenance?.reason === 'ledger-read-failed',
      finding: { name: 'builder_class_inconclusive', reason: provenance?.reason || 'unknown-builder-harness',
        ...(provenance?.detail ? { detail: provenance.detail } : {}) },
    };
  }
  const titleBuilderClass = normalizeBuilderClass(subject.builderClass);
  return {
    subject: { ...subject, builderClass: actual },
    finding: actual !== titleBuilderClass ? {
      name: 'builder_class_mismatch',
      titleBuilderClass,
      actualBuilderClass: actual,
      launchRequestId: provenance.launchRequestId,
    } : null,
  };
}

export function resolveBuilderProvenanceRouting(subject, {
  repo, prNumber, rootDir, readProvenance = readPrBuilderProvenance,
} = {}) {
  let provenance;
  try {
    provenance = readProvenance({ repo, prNumber, headSha: subject.headSha, rootDir });
  } catch (error) {
    provenance = { ok: false, reason: 'ledger-read-failed', detail: error.message || String(error), deferClaim: true };
  }
  return finishBuilderProvenanceRouting(subject, provenance, { repo, prNumber, rootDir });
}

const routingFindings = repositoryObservationCache(new Map());
function finishBuilderProvenanceRouting(subject, provenance, { repo, prNumber, rootDir }) {
  const result = reconcileBuilderClass(subject, provenance);
  const key = `${rootDir}:${repo}:${prNumber}:${subject.headSha}`;
  if (routingFindings.size >= 1000) routingFindings.delete(routingFindings.keys().next().value);
  if (!result.finding) routingFindings.set(key, null);
  if (result.finding && rootDir) {
    const audit = { repo, prNumber, headSha: subject.headSha, ...result.finding };
    const serialized = JSON.stringify(audit, null, 2);
    const auditPath = join(rootDir, 'data', 'builder-routing', `${encodeURIComponent(repo)}-${prNumber}-${subject.headSha}.json`);
    let previous = routingFindings.get(key);
    if (!routingFindings.has(key)) {
      try { previous = readFileSync(auditPath, 'utf8'); } catch { /* First observation. */ }
    }
    if (routingFindings.size >= 1000) routingFindings.delete(routingFindings.keys().next().value);
    routingFindings.set(key, serialized);
    if (previous === serialized) return result;
    // Audit failure does not alter the routing or claim-deferral decision.
    try {
      const dir = join(rootDir, 'data', 'builder-routing');
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(auditPath, serialized);
    } catch {
      console.warn('[builder-routing] could not persist provenance finding');
    }
    console.warn(`[builder-routing] ${JSON.stringify(audit)}`);
  }
  return result;
}

export async function resolveBuilderProvenanceRoutingAsync(subject, {
  repo, prNumber, rootDir, readProvenance = readPrBuilderProvenanceAsync,
} = {}) {
  let provenance;
  try { provenance = await readProvenance({ repo, prNumber, headSha: subject.headSha, rootDir }); }
  catch (error) { provenance = { ok: false, reason: 'ledger-read-failed', detail: error.message || String(error), deferClaim: true }; }
  return finishBuilderProvenanceRouting(subject, provenance, { repo, prNumber, rootDir });
}
