import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseDiffFiles } from './reviewer-util.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_AGENT_OS_ROOT = resolve(__dirname, '..', '..', '..');
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

function pythonEnv(repoRoot, env = process.env) {
  const srcPath = resolve(repoRoot || DEFAULT_AGENT_OS_ROOT, 'platform', 'session-ledger', 'src');
  return {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${srcPath}:${env.PYTHONPATH}` : srcPath,
  };
}

async function loadContractsFromPython({
  repoRoot = DEFAULT_AGENT_OS_ROOT,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const script = `
import json
from session_ledger.hardening_contracts import list_contract_identities

print(json.dumps([
    {
        "contract_id": contract.contract_id,
        "summary": contract.summary,
        "locations": [
            {"path": location.path, "symbol": location.symbol, "notes": location.notes}
            for location in contract.locations
        ],
    }
    for contract in list_contract_identities()
], sort_keys=True))
`.trim();
  const { stdout } = await execFileImpl('python3', ['-c', script], {
    env: pythonEnv(repoRoot, env),
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

async function listHardeningRecordsFromPython(contractId, {
  repoRoot = DEFAULT_AGENT_OS_ROOT,
  ledgerTarget = null,
  limit = DEFAULT_RECORD_LIMIT,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const script = `
import json
import os
import sys
from session_ledger.db_runtime import open_ledger_for_runtime_readonly
from session_ledger.db_stores.hardening_records import hardening_record_row_to_dict
from session_ledger.hardening_contracts import require_contract_identity

contract_id = sys.argv[1]
limit = int(sys.argv[2])
target = os.environ.get("HLG_LEDGER_TARGET") or None
require_contract_identity(contract_id)
conn = open_ledger_for_runtime_readonly(target, timeout=10.0)
try:
    rows = conn.execute(
        """
        SELECT *
        FROM hardening_records
        WHERE contract_id = ?
        ORDER BY created_at DESC, recorded_at DESC, record_id DESC
        LIMIT ?
        """,
        (contract_id, limit),
    ).fetchall()
    print(json.dumps([
        hardening_record_row_to_dict(row)
        for row in rows
    ], sort_keys=True))
finally:
    conn.close()
`.trim();
  const childEnv = pythonEnv(repoRoot, env);
  if (ledgerTarget) childEnv.HLG_LEDGER_TARGET = String(ledgerTarget);
  const { stdout } = await execFileImpl('python3', ['-c', script, contractId, String(limit)], {
    env: childEnv,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

async function getExposureRollupFromPython(contractId, {
  repoRoot = DEFAULT_AGENT_OS_ROOT,
  ledgerTarget = null,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const script = `
import json
import os
import sys
from session_ledger.db_runtime import open_ledger_for_runtime_readonly
from session_ledger.db_stores.exposure_events import empty_exposure_rollup
from session_ledger.db_stores.exposure_events import exposure_rollup_row_to_dict
from session_ledger.hardening_contracts import require_contract_identity

contract_id = sys.argv[1]
target = os.environ.get("HLG_LEDGER_TARGET") or None
require_contract_identity(contract_id)
conn = open_ledger_for_runtime_readonly(target, timeout=10.0)
try:
    row = conn.execute(
        """
        SELECT *
        FROM exposure_rollups
        WHERE contract_id = ?
        """,
        (contract_id,),
    ).fetchone()
    rollup = (
        empty_exposure_rollup(contract_id)
        if row is None
        else exposure_rollup_row_to_dict(row, now=None)
    )
    print(json.dumps(rollup, sort_keys=True))
finally:
    conn.close()
`.trim();
  const childEnv = pythonEnv(repoRoot, env);
  if (ledgerTarget) childEnv.HLG_LEDGER_TARGET = String(ledgerTarget);
  const { stdout } = await execFileImpl('python3', ['-c', script, contractId], {
    env: childEnv,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || 'null');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
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
  repoRoot = DEFAULT_AGENT_OS_ROOT,
  ledgerTarget = null,
  limit = DEFAULT_RECORD_LIMIT,
  loadContracts = loadContractsFromPython,
  listRecords = listHardeningRecordsFromPython,
  getExposureRollup = getExposureRollupFromPython,
  logger = console,
} = {}) {
  const changedPaths = changedPathsFromDiff(diffText);
  if (changedPaths.length === 0) return '';

  let contracts;
  try {
    contracts = await loadContracts({ repoRoot });
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
      exposureRollup = await getExposureRollup(contract.contract_id, { repoRoot, ledgerTarget });
    } catch (err) {
      logger?.warn?.(
        `[reviewer] WARN: failed to load exposure rollup for ${contract.contract_id}: ${err?.message || err}`
      );
    }
    try {
      const records = await listRecords(contract.contract_id, { repoRoot, ledgerTarget, limit });
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
  DEFAULT_AGENT_OS_ROOT,
  changedPathsFromDiff,
  touchedContractsForPaths,
  isLowOrNoExposure,
  formatHardeningReviewContext,
  buildHardeningReviewContext,
  loadContractsFromPython,
  listHardeningRecordsFromPython,
  getExposureRollupFromPython,
  isLowExposureRollup,
};
