import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { deliverAlert } from './alert-delivery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const execFileAsync = promisify(execFile);

const ACTIVATION_KIND = 'adversarial-review-c5-tel11-activation';
const SCHEMA_VERSION = 1;

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safePathPart(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function parseJsonMaybe(text, fallback = null) {
  const raw = Buffer.isBuffer(text) ? text.toString('utf8') : typeof text === 'string' ? text : text == null ? null : String(text);
  const cleaned = cleanString(raw);
  if (!cleaned) return fallback;
  try {
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function normalizeActivationResult(raw) {
  const result = raw && typeof raw === 'object' ? raw : {};
  const live = result.live === true || result.status === 'live';
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    live,
    status: live ? 'live' : 'not-live',
    reason: cleanString(result.reason) || (live ? 'tel11-live' : 'tel11-not-live'),
    detectorRef: cleanString(result.detectorRef) || cleanString(result.detector_ref) || null,
    checkedAt: cleanString(result.checkedAt) || cleanString(result.checked_at) || new Date().toISOString(),
    findings,
    raw: result,
  };
}

function activationRecordPath(rootDir, { c5RunId, c5DeployId, activatedAt }) {
  return join(
    rootDir,
    'data',
    'runtime-cutover',
    'c5-tel11-activations',
    `${safePathPart(c5RunId)}-${safePathPart(c5DeployId)}-${safePathPart(activatedAt)}.json`
  );
}

function requireC5Identity({ c5RunId, c5DeployId }) {
  const missing = [];
  if (!cleanString(c5RunId)) missing.push('c5RunId');
  if (!cleanString(c5DeployId)) missing.push('c5DeployId');
  if (missing.length > 0) {
    throw new Error(`C5 TEL-11 activation missing required identity: ${missing.join(', ')}`);
  }
}

function buildActivationRecord({
  c5RunId,
  c5DeployId,
  c5RemovalArtifact = null,
  sourceRepo = 'adversarial-review',
  rcdG7aPr = null,
  adversarialReviewPr = null,
  activation,
  activatedAt = new Date().toISOString(),
}) {
  requireC5Identity({ c5RunId, c5DeployId });
  const live = activation.live === true;
  return {
    kind: ACTIVATION_KIND,
    schemaVersion: SCHEMA_VERSION,
    activatedAt,
    sourceRepo,
    status: live ? 'live' : 'not-live',
    live,
    c5: {
      runId: c5RunId,
      deployId: c5DeployId,
      removalArtifact: c5RemovalArtifact,
    },
    tel11: {
      status: activation.status,
      live: activation.live,
      reason: activation.reason,
      detectorRef: activation.detectorRef,
      checkedAt: activation.checkedAt,
      findings: activation.findings,
    },
    rollback: live
      ? { required: false, holdClosure: false, reason: null }
      : { required: true, holdClosure: true, reason: activation.reason },
    acceptGate: {
      consumer: 'agent-os RCD-G7A',
      requiredForClosureAcceptance: true,
      rcdG7aPr,
      adversarialReviewPr,
    },
  };
}

async function defaultAlert({ record, alert = deliverAlert }) {
  await alert(
    `TEL-11 standing detection blocked C5 closure: ${record.tel11.reason}`,
    {
      event: 'runtime_cutover.c5_tel11_activation_blocked',
      payload: {
        c5RunId: record.c5.runId,
        c5DeployId: record.c5.deployId,
        status: record.status,
        findingsCount: record.tel11.findings.length,
        recordKind: record.kind,
      },
    }
  );
}

async function defaultReintroductionAlert({ record, detection, alert = deliverAlert }) {
  await alert(
    `TEL-11 standing detection found OpenClaw dependency after C5 activation: ${detection.reason}`,
    {
      event: 'runtime_cutover.tel11_openclaw_reintroduction',
      payload: {
        c5RunId: record.c5.runId,
        c5DeployId: record.c5.deployId,
        status: detection.status,
        findingsCount: detection.findings.length,
        detectorRef: detection.detectorRef,
        activationRecordKind: record.kind,
      },
    }
  );
}

function logAlertDeliveryFailure(scope, err) {
  console.error(`[c5-tel11-activation] Failed to deliver ${scope} alert: ${err?.message || err}`);
}

async function activateTel11ForC5Closure({
  rootDir = ROOT,
  c5RunId,
  c5DeployId,
  c5RemovalArtifact = null,
  sourceRepo = 'adversarial-review',
  rcdG7aPr = null,
  adversarialReviewPr = null,
  runTel11StandingDetections,
  alert = deliverAlert,
  shouldAlert = true,
  activatedAt = new Date().toISOString(),
} = {}) {
  requireC5Identity({ c5RunId, c5DeployId });
  if (typeof runTel11StandingDetections !== 'function') {
    throw new Error('C5 TEL-11 activation requires runTel11StandingDetections');
  }

  const activation = normalizeActivationResult(await runTel11StandingDetections({
    phase: 'post-c5-removal',
    c5RunId,
    c5DeployId,
    c5RemovalArtifact,
  }));

  const record = buildActivationRecord({
    c5RunId,
    c5DeployId,
    c5RemovalArtifact,
    sourceRepo,
    rcdG7aPr,
    adversarialReviewPr,
    activation,
    activatedAt,
  });
  const recordPath = activationRecordPath(rootDir, { c5RunId, c5DeployId, activatedAt });
  writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  if (!record.live && shouldAlert) {
    try {
      await defaultAlert({ record, alert });
    } catch (err) {
      logAlertDeliveryFailure('blocked-closure', err);
    }
  }

  return {
    accepted: record.live,
    holdClosure: !record.live,
    rollbackRequired: !record.live,
    record,
    recordPath,
  };
}

async function enforceTel11StandingDetectionsAfterActivation({
  activationRecord,
  runTel11StandingDetections,
  alert = deliverAlert,
  shouldAlert = true,
} = {}) {
  if (!activationRecord || activationRecord.kind !== ACTIVATION_KIND) {
    throw new Error('TEL-11 standing detection enforcement requires a C5 activation record');
  }
  if (activationRecord.live !== true) {
    return {
      ok: false,
      failLoud: true,
      reason: 'activation-record-not-live',
      detection: null,
    };
  }
  if (typeof runTel11StandingDetections !== 'function') {
    throw new Error('TEL-11 standing detection enforcement requires runTel11StandingDetections');
  }

  const detection = normalizeActivationResult(await runTel11StandingDetections({
    phase: 'post-activation-openclaw-reintroduction-check',
    c5RunId: activationRecord.c5.runId,
    c5DeployId: activationRecord.c5.deployId,
    c5RemovalArtifact: activationRecord.c5.removalArtifact,
    activationRecord,
  }));
  const failed = detection.live !== true || detection.findings.length > 0;
  if (failed && shouldAlert) {
    try {
      await defaultReintroductionAlert({ record: activationRecord, detection, alert });
    } catch (err) {
      logAlertDeliveryFailure('openclaw-reintroduction', err);
    }
  }
  return {
    ok: !failed,
    failLoud: failed,
    reason: failed ? detection.reason : null,
    detection,
  };
}

function splitCommand(command) {
  const text = cleanString(command);
  if (!text) return null;
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (current) parts.push(current);
  return parts.length > 0 ? parts : null;
}

function isTransientExecError(err) {
  const code = err?.code;
  const message = err?.message || '';
  return code === 'EIO'
    || code === 'EAGAIN'
    || code === 'ETIMEDOUT'
    || code === 'ETIME'
    || err?.timedOut === true
    || /timeout|eio|eagain|temporary|tls/i.test(message);
}

function commandFailureResult(err, reason) {
  return {
    live: false,
    reason,
    exitCode: typeof err?.code === 'number' ? err.code : null,
    signal: cleanString(err?.signal) || null,
    stderr: cleanString(Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf8') : err?.stderr) || null,
  };
}

function commandTel11Detector({
  command,
  execFileImpl = execFileAsync,
  env = process.env,
  retryDelayMs = 100,
  maxAttempts = 3,
  timeoutMs = 30000,
} = {}) {
  const parts = Array.isArray(command) ? command : splitCommand(command || env.TEL11_STANDING_DETECTIONS_COMMAND);
  if (!parts || parts.length === 0) {
    return async () => ({
      live: false,
      reason: 'tel11-standing-detections-command-not-configured',
    });
  }
  const [bin, ...baseArgs] = parts;
  return async ({ phase = 'post-c5-removal', c5RunId, c5DeployId, c5RemovalArtifact }) => {
    const args = [
      ...baseArgs,
      '--phase',
      phase,
      '--c5-run-id',
      c5RunId,
      '--c5-deploy-id',
      c5DeployId,
      ...(c5RemovalArtifact ? ['--c5-removal-artifact', c5RemovalArtifact] : []),
      '--json',
    ];
    const attempts = Math.max(1, Number(maxAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { stdout } = await execFileImpl(bin, args, { env, timeout: timeoutMs });
        return parseJsonMaybe(stdout, { live: false, reason: 'tel11-standing-detections-returned-non-json', stdout });
      } catch (err) {
        const parsed = parseJsonMaybe(err?.stdout);
        if (parsed && typeof parsed === 'object') return parsed;
        if (isTransientExecError(err) && attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
          continue;
        }
        return commandFailureResult(
          err,
          isTransientExecError(err)
            ? 'tel11-standing-detections-command-transient-failed'
            : 'tel11-standing-detections-command-failed'
        );
      }
    }
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    c5RunId: null,
    c5DeployId: null,
    c5RemovalArtifact: null,
    rcdG7aPr: null,
    adversarialReviewPr: null,
    tel11Command: null,
    noAlert: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1] || null;
      index += 1;
      return value;
    };
    if (arg === '--c5-run-id') parsed.c5RunId = readValue();
    else if (arg === '--c5-deploy-id') parsed.c5DeployId = readValue();
    else if (arg === '--c5-removal-artifact') parsed.c5RemovalArtifact = readValue();
    else if (arg === '--rcd-g7a-pr') parsed.rcdG7aPr = readValue();
    else if (arg === '--adversarial-review-pr') parsed.adversarialReviewPr = readValue();
    else if (arg === '--tel11-command') parsed.tel11Command = readValue();
    else if (arg === '--no-alert') parsed.noAlert = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  requireC5Identity(parsed);
  return parsed;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await activateTel11ForC5Closure({
      rootDir: ROOT,
      ...args,
      runTel11StandingDetections: commandTel11Detector({ command: args.tel11Command }),
      shouldAlert: !args.noAlert,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.accepted) process.exitCode = 2;
  } catch (err) {
    console.error(`[c5-tel11-activation] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  ACTIVATION_KIND,
  activateTel11ForC5Closure,
  activationRecordPath,
  buildActivationRecord,
  commandTel11Detector,
  enforceTel11StandingDetectionsAfterActivation,
  normalizeActivationResult,
  parseArgs,
};
