import { attestationRecorded, resolveSubjectKey } from '../../../finalization/ledger-events.mjs';
import { openFinalizationLedgerStore } from '../../../finalization/ledger-store.mjs';

const DEFAULT_ATTESTATION_KIND = 'produced';
const DEFAULT_PRINCIPAL = 'research-finding-attestor';

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function subjectRef(subject) {
  return subject?.ref && typeof subject.ref === 'object' ? subject.ref : subject;
}

function subjectRevisionRef(subject) {
  return subjectRef(subject)?.revisionRef ?? subject?.revisionRef ?? null;
}

function decisionAccepted(decision) {
  return decision?.kind === 'finalize-now' || decision?.state === 'success';
}

function decisionSourceRef(decision) {
  return decision?.sourceRef ?? decision?.source?.sourceRef ?? null;
}

function decisionObservedAt(decision) {
  return decision?.observedAt ?? decision?.postedAt ?? decision?.at ?? null;
}

function maybeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/**
 * Non-GitHub SoR gate provider for research-finding style subjects.
 *
 * `gate(subject, revisionRef, decision)` records an attestation event for the
 * exact current revision only. The append-only finalization ledger is the
 * durable store; an optional injected `execFileImpl` can also call the existing
 * `hq attest sign` surface for deployments that have the signer configured.
 */
export function createAttestationLogGateProvider({
  rootDir,
  ledgerStore = null,
  execFileImpl = null,
  hqBin = 'hq',
  hqRoot = null,
  hqAttestSubject = null,
  principal = DEFAULT_PRINCIPAL,
  kind = DEFAULT_ATTESTATION_KIND,
} = {}) {
  if (!ledgerStore && !rootDir) {
    throw new TypeError('attestation-log gate provider requires rootDir or ledgerStore');
  }
  if (!nonEmptyString(principal)) {
    throw new TypeError('attestation-log gate provider requires a principal');
  }
  if (!nonEmptyString(kind)) {
    throw new TypeError('attestation-log gate provider requires an attestation kind');
  }

  const ownStore = !ledgerStore;
  const store = ledgerStore ?? openFinalizationLedgerStore({ rootDir });

  return {
    providerId: 'attestation-log',

    async gate(subject, revisionRef, decision) {
      const ref = subjectRef(subject);
      resolveSubjectKey(ref);
      if (!nonEmptyString(revisionRef)) {
        throw new TypeError('attestation-log gate requires a revisionRef');
      }

      const currentRevisionRef = subjectRevisionRef(subject);
      if (currentRevisionRef && currentRevisionRef !== revisionRef) {
        return {
          gated: false,
          reason: 'stale-revision',
          revisionRef,
          currentRevisionRef,
        };
      }

      if (!decisionAccepted(decision)) {
        return { gated: false, reason: 'decision-not-accepted', revisionRef };
      }

      const at = decisionObservedAt(decision);
      if (!nonEmptyString(at)) {
        throw new TypeError('attestation-log gate requires decision.observedAt');
      }
      const sourceRef = decisionSourceRef(decision);
      if (!nonEmptyString(sourceRef)) {
        throw new TypeError('attestation-log gate requires decision.sourceRef');
      }

      const payload = {
        provider: 'attestation-log',
        subject: {
          domainId: ref.domainId,
          subjectExternalId: ref.subjectExternalId,
        },
        revisionRef,
        decisionKind: decision?.kind ?? null,
        decisionState: decision?.state ?? null,
        sourceRef,
      };

      let signed = null;
      if (typeof execFileImpl === 'function') {
        const repo = hqAttestSubject?.repo ?? subject?.repo ?? ref?.repo;
        const pr = hqAttestSubject?.prNumber ?? hqAttestSubject?.pr ?? subject?.prNumber ?? subject?.pr_number;
        if (!nonEmptyString(repo) || !Number.isInteger(Number(pr))) {
          throw new TypeError('attestation-log hq signer requires repo and numeric prNumber');
        }
        const args = [
          'attest',
          'sign',
          '--repo',
          repo,
          '--pr',
          String(pr),
          '--head-sha',
          revisionRef,
          '--kind',
          kind,
          '--payload-json',
          JSON.stringify(payload),
        ];
        if (hqRoot) args.push('--root', hqRoot);
        const result = await execFileImpl(hqBin, args);
        signed = maybeParseJson(result?.stdout) ?? { stdout: String(result?.stdout ?? '') };
      }

      const event = store.append(attestationRecorded(ref, {
        at,
        revisionRef,
        kind,
        principal,
        sourceRef,
      }));

      return {
        gated: true,
        providerId: 'attestation-log',
        revisionRef,
        sourceRef,
        attestation: event,
        ...(signed ? { signed } : {}),
      };
    },

    close() {
      if (ownStore) store.close();
    },
  };
}

export default createAttestationLogGateProvider;
