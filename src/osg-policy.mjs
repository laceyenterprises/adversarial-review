/** OSG-18 read-only policy contract. Availability and route authority stay with callers. */
import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { readFileSync } from 'node:fs';

const armFields = JSON.parse(readFileSync(new URL('./osg-config-schema.v1.json', import.meta.url), 'utf8')).__keys.arms.__item.__keys;
const roles = ['builder', 'reviewer', 'remediator'];
const taskTypes = ['build', 'fix', 'refactor/chore', 'docs/config'];
const maxBytes = 131072;
const reportPattern = /^docs\/reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
const checkpointPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function requireValue(ok) {
  if (!ok) throw new Error('osg.policy: invalid contract value');
}
function fullMatch(pattern, value) {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function object(value, fields) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)));
  return value;
}
function readArm(value) {
  object(value, Object.keys(armFields));
  for (const [key, spec] of Object.entries(armFields)) {
    requireValue(fullMatch(new RegExp(spec.__pattern), value[key]));
    if (spec.__enum) requireValue(spec.__enum.includes(value[key]));
  }
  return Object.freeze({ ...value });
}
function readStratum(value) {
  object(value, ['task_type', 'size']);
  requireValue(taskTypes.includes(value.task_type) && ['small', 'large'].includes(value.size));
  return Object.freeze({ ...value });
}
function sameArm(a, b) {
  return a !== 'current' && b !== 'current' && Object.keys(armFields).every(k => a[k] === b[k]);
}

export function readPolicy(value) {
  object(value, ['version', 'entries']);
  requireValue(value.version === 1 && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 24);
  const keys = new Set();
  const checkpoints = new Set();
  const entries = value.entries.map(raw => {
    object(raw, ['role', 'stratum', 'arm', 'promotions']);
    requireValue(roles.includes(raw.role));
    const stratum = readStratum(raw.stratum);
    const arm = raw.arm === 'current' ? 'current' : readArm(raw.arm);
    requireValue(arm === 'current' || arm.role === raw.role);
    requireValue(Array.isArray(raw.promotions) && raw.promotions.length <= 128);
    const promotions = raw.promotions.map(item => {
      object(item, ['checkpoint', 'report', 'arm']);
      requireValue(fullMatch(checkpointPattern, item.checkpoint) && fullMatch(reportPattern, item.report));
      const key = JSON.stringify([raw.role, item.checkpoint]);
      requireValue(!checkpoints.has(key));
      checkpoints.add(key);
      const priorArm = readArm(item.arm);
      requireValue(priorArm.role === raw.role);
      return Object.freeze({ checkpoint: item.checkpoint, report: item.report, arm: priorArm });
    });
    requireValue((arm === 'current' && promotions.length === 0) || (promotions.length > 0 && sameArm(promotions.at(-1).arm, arm)));
    const key = JSON.stringify([raw.role, stratum.task_type, stratum.size]);
    requireValue(!keys.has(key));
    keys.add(key);
    return Object.freeze({ role: raw.role, stratum, arm, promotions: Object.freeze(promotions) });
  });
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

export function loadPolicy(policyPath) {
  // Nonblocking open plus regular-file validation also rejects FIFOs/devices.
  const fd = openSync(policyPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    requireValue(fstatSync(fd).isFile());
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    requireValue(length <= maxBytes);
    return readPolicy(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))));
  } finally { closeSync(fd); }
}

export function resolveDefault({ enabled, mode, policyPath, role, stratum, current, allowArm, load = loadPolicy }) {
  if (enabled !== true || mode !== 'apply') return { arm: current, reason: 'policy-inactive' };
  try {
    readStratum(stratum);
    const policy = readPolicy(load(policyPath));
    const entry = policy.entries.find(e => e.role === role && e.stratum.task_type === stratum.task_type && e.stratum.size === stratum.size);
    if (!entry) return { arm: current, reason: 'policy-missing-entry' };
    if (entry.arm === 'current') return { arm: current, reason: 'policy-current' };
    if (typeof allowArm !== 'function' || allowArm(entry.arm) !== true) return { arm: current, reason: 'policy-unavailable' };
    return { arm: entry.arm, reason: 'policy-promoted' };
  } catch {
    return { arm: current, reason: 'policy-error' };
  }
}
