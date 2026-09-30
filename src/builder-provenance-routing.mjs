import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { normalizeBuilderClass } from './adapters/subject/github-pr/routing.mjs';
import { readPrBuilderProvenance } from './session-ledger-read-adapter.mjs';

export function reconcileBuilderClass(subject, provenance) {
  const actual = provenance?.ok && normalizeBuilderClass(provenance.actualHarness);
  if (!actual) {
    return {
      subject,
      // Missing provenance may use title routing; an unsuccessful query may
      // not turn an infrastructure failure into a durable reviewer choice.
      deferClaim: provenance?.deferClaim === true || provenance?.reason === 'ledger-read-failed',
      finding: { name: 'builder_class_inconclusive', reason: provenance?.reason || 'unknown-builder-harness' },
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
  } catch {
    provenance = { ok: false, reason: 'ledger-read-failed', deferClaim: true };
  }
  const result = reconcileBuilderClass(subject, provenance);
  if (result.finding && rootDir) {
    const audit = { repo, prNumber, headSha: subject.headSha, ...result.finding };
    // Audit failure does not alter the routing or claim-deferral decision.
    try {
      const dir = join(rootDir, 'data', 'builder-routing');
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(join(dir, `${encodeURIComponent(repo)}-${prNumber}-${subject.headSha}.json`), JSON.stringify(audit, null, 2));
    } catch {
      console.warn('[builder-routing] could not persist provenance finding');
    }
    console.warn(`[builder-routing] ${JSON.stringify(audit)}`);
  }
  return result;
}
