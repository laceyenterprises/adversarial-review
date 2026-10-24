// RCV-07 ExecutionVerdict.export consumer. This validates the wire contract;
// execution classification and evidence interpretation belong to its producer.
export const VERDICT_SCHEMA_VERSION = 1;
export function validNoWorkVerdict(value, launchRequestId) {
  return value?.schemaVersion === VERDICT_SCHEMA_VERSION
    && value.producer === 'cwp-execution/1'
    && value.launchRequestId === launchRequestId
    && value.attempt === 1
    && typeof value.verdictId === 'string' && value.verdictId.length > 0
    && value.verdict === 'no_work'
    && ['credential_before_work', 'boot_killed_before_work', 'hard_quota_before_work'].includes(value.reason)
    && Number.isFinite(Date.parse(value.observedAt))
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0
    && value.evidenceRefs.every(ref => typeof ref === 'string' && ref.startsWith('ledger:'));
}
