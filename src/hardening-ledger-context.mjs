import { readWorkerObservation } from './dispatch-read-client.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';

const DEFAULT_RECORD_LIMIT = 8;

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function uniqueStrings(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function changedPathsFromDiff(diffText) {
  return uniqueStrings(
    parseDiffFiles(diffText).flatMap((file) => [file.oldPath, file.newPath, file.path])
      .filter((path) => path && path !== '/dev/null')
  );
}

function pathTouchesLocation(changedPath, locationPath) {
  const changed = normalizeText(changedPath);
  const location = normalizeText(locationPath);
  if (!changed || !location) return false;
  if (changed === location) return true;
  return changed.startsWith(`${location.replace(/\/+$/, '')}/`);
}

function touchedContractsForPaths(paths, contracts) {
  const touched = [];
  for (const contract of contracts || []) {
    const locations = Array.isArray(contract?.locations) ? contract.locations : [];
    const matchedPaths = uniqueStrings(
      paths.filter((path) => locations.some((location) => pathTouchesLocation(path, location?.path)))
    );
    if (matchedPaths.length === 0) continue;
    touched.push({
      contract_id: normalizeText(contract.contract_id),
      summary: normalizeText(contract.summary),
      locations,
      matchedPaths,
    });
  }
  return touched.filter((contract) => contract.contract_id);
}

async function sdkRows(selector, args) {
  const result = await readWorkerObservation(selector, args);
  if (!result.ok) throw new Error('hardening evidence unavailable');
  return result.rows;
}
async function loadContractsFromSdk(args = {}) {
  return sdkRows({observation:'hardening_contracts',limit:100}, args);
}
async function listHardeningRecordsFromSdk(contractId, args = {}) {
  const rows = await sdkRows({observation:'hardening_records',contract_id:contractId,limit:100}, args);
  return rows.slice(0, args.limit ?? DEFAULT_RECORD_LIMIT);
}
async function getExposureRollupFromSdk(contractId, args = {}) {
  const rows = await sdkRows({observation:'hardening_exposure',contract_id:contractId,limit:100}, args);
  return rows[0] ?? null;
}

function isLowOrNoExposure(exposure) {
  if (!exposure || typeof exposure !== 'object' || Array.isArray(exposure)) return true;
  const haystack = [
    exposure.level,
    exposure.tier,
    exposure.class,
    exposure.status,
    exposure.coverage,
    exposure.signal,
  ].map((value) => String(value ?? '').trim().toLowerCase());
  if (haystack.some((value) => ['low', 'none', 'no', 'zero', 'unknown', 'unexercised'].includes(value))) {
    return true;
  }
  for (const key of ['count', 'samples', 'sample_count', 'executions', 'execution_count', 'observations']) {
    if (Object.prototype.hasOwnProperty.call(exposure, key) && Number(exposure[key]) <= 0) {
      return true;
    }
  }
  return false;
}

function isLowExposureRollup(rollup) {
  if (!rollup || typeof rollup !== 'object' || Array.isArray(rollup)) return false;
  const score = Number(rollup.exposure_score);
  if (!Number.isFinite(score)) return true;
  return score < 25;
}

function summarizeExposure(records, rollup = null) {
  if (rollup && typeof rollup === 'object') {
    const score = Number(rollup.exposure_score);
    const label = Number.isFinite(score)
      ? `live exposure_score=${score}`
      : 'live exposure_score unavailable';
    return {
      harsherReview: isLowExposureRollup(rollup),
      label,
    };
  }
  if (!records.length) return { harsherReview: true, label: 'no exposure snapshot' };
  const low = records.some((record) => isLowOrNoExposure(record?.exposure));
  return {
    harsherReview: low,
    label: low ? 'low/no exposure snapshot present' : 'exposure snapshot present',
  };
}

function formatHardeningReviewContext(entries) {
  const sections = entries.filter((entry) => entry.records.length > 0 || isLowExposureRollup(entry.exposureRollup));
  if (sections.length === 0) return '';

  const body = sections.map((entry) => {
    const exposure = summarizeExposure(entry.records, entry.exposureRollup);
    const failureModes = uniqueStrings(entry.records.map((record) => record.failure_mode));
    const tests = uniqueStrings(entry.records.map((record) => record.regression_test_ref));
    const incidentRefs = uniqueStrings(entry.records.map((record) => record.incident_ref));
    const lines = [
      `### ${entry.contract.contract_id}${entry.contract.summary ? ` - ${entry.contract.summary}` : ''}`,
      `Touched paths: ${entry.contract.matchedPaths.map((path) => `\`${path}\``).join(', ')}`,
      `Exposure: ${exposure.label}${exposure.harsherReview ? ' - apply harsher review; scars may be under-exercised.' : '.'}`,
      '',
      'Failure modes to review against:',
      ...(failureModes.length > 0 ? failureModes.map((mode) => `- ${mode}`) : ['- No hardening scars recorded yet; review the contract as under-exposed.']),
    ];
    if (tests.length > 0) {
      lines.push('', 'Traveling regression refs:', ...tests.map((testRef) => `- ${testRef}`));
    }
    if (incidentRefs.length > 0) {
      lines.push('', `Incident refs: ${incidentRefs.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  return `\n\n---\n\nHardening Ledger contract context:\n\nA changed registered contract has prior hardening records. Treat each failure mode below as an additional adversarial review dimension. For low/no-exposure contracts, use a harsher threshold: look for missing tests, silent fail-open behavior, and assumptions that only pass because the contract has not been exercised enough.\n\n${body}`;
}

async function buildHardeningReviewContext(diffText, {
  repoRoot = null,
  limit = DEFAULT_RECORD_LIMIT,
  loadContracts = loadContractsFromSdk,
  listRecords = listHardeningRecordsFromSdk,
  getExposureRollup = getExposureRollupFromSdk,
  logger = console,
  ...transport
} = {}) {
  const changedPaths = changedPathsFromDiff(diffText);
  if (changedPaths.length === 0) return '';

  let contracts;
  try {
    contracts = await loadContracts({ repoRoot, ...transport });
  } catch (err) {
    logger?.warn?.(`[reviewer] WARN: failed to load hardening-ledger contract registry: ${err?.message || err}`);
    return '';
  }

  const touched = touchedContractsForPaths(changedPaths, contracts);
  if (touched.length === 0) return '';

  const entries = [];
  for (const contract of touched) {
    let exposureRollup = null;
    try {
      exposureRollup = await getExposureRollup(contract.contract_id, { repoRoot, ...transport });
    } catch (err) {
      logger?.warn?.(
        `[reviewer] WARN: failed to load exposure rollup for ${contract.contract_id}: ${err?.message || err}`
      );
    }
    try {
      const records = await listRecords(contract.contract_id, { repoRoot, ...transport, limit });
      entries.push({ contract, records: Array.isArray(records) ? records : [], exposureRollup });
    } catch (err) {
      logger?.warn?.(
        `[reviewer] WARN: failed to load hardening records for ${contract.contract_id}: ${err?.message || err}`
      );
      entries.push({ contract, records: [], exposureRollup });
    }
  }

  return formatHardeningReviewContext(entries);
}

export {
  changedPathsFromDiff,
  touchedContractsForPaths,
  isLowOrNoExposure,
  formatHardeningReviewContext,
  buildHardeningReviewContext,
  loadContractsFromSdk,
  listHardeningRecordsFromSdk,
  getExposureRollupFromSdk,
  isLowExposureRollup,
};
