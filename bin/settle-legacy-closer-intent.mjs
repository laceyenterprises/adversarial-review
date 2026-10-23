#!/usr/bin/env node
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { amaCloserDispatchDir } from '../src/ama/dispatch-record-read.mjs';
import { reconcilePreReceiptIntent } from '../src/ama/pre-receipt-intent.mjs';
import { appendOperatorMutationAuditRow } from '../src/operator-mutation-audit.mjs';

const usage = `Usage: node bin/settle-legacy-closer-intent.mjs
  --root-dir <review-root> --hq-root <hq-root> --ledger-target <canonical-target>
  --repo <owner/repo> --pr <number> --head <dispatch-head-sha>
  [--apply --reason <operator-reason>]
Dry-run is the default. Apply requires the dispatch directory owner. Supports legacy and expired keyed intents.
`;

export async function main(args = process.argv.slice(2), options = {}) {
  const { values } = parseArgs({ args, options: {
    'root-dir': { type: 'string' }, 'hq-root': { type: 'string' },
    'ledger-target': { type: 'string' }, repo: { type: 'string' },
    pr: { type: 'string' }, head: { type: 'string' }, reason: { type: 'string' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  const print = options.print || console.log;
  if (values.help) { print(usage); return; }
  for (const key of ['root-dir', 'hq-root', 'ledger-target', 'repo', 'pr', 'head']) {
    if (!values[key]) throw new Error(`--${key} is required\n${usage}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(values.repo) || !/^[a-f0-9]{40}$/i.test(values.head)
    || !/^\d+$/.test(values.pr) || !Number.isSafeInteger(Number(values.pr)) || Number(values.pr) <= 0) {
    throw new Error('Expected owner/repo, a positive PR number and a full dispatch head SHA');
  }
  const rootDir = resolve(values['root-dir']);
  const dryRun = !values.apply;
  if (!dryRun) {
    if (!values.reason?.trim()) throw new Error('--apply requires --reason');
    if (typeof process.getuid !== 'function') {
      throw new Error('Apply requires POSIX UID verification; process.getuid is unavailable');
    }
    const owner = statSync(amaCloserDispatchDir(rootDir)).uid;
    if (owner !== process.getuid()) {
      throw new Error(`Apply requires dispatch directory owner uid ${owner}`);
    }
  }
  const identity = { repo: values.repo, prNumber: Number(values.pr), headSha: values.head.toLowerCase() };
  const now = options.now || new Date().toISOString();
  const auditBase = { ts: now, verb: 'settle-legacy-closer-intent', repo: identity.repo,
    pr: identity.prNumber, revisionRef: identity.headSha, actor: userInfo().username,
    reason: values.reason, idempotencyKey: randomUUID() };
  const audit = row => appendOperatorMutationAuditRow(rootDir, { ...auditBase, ...row });
  const result = await reconcilePreReceiptIntent(rootDir, identity, {
    ...options, now, dryRun, operatorSettlement: true, hqRoot: resolve(values['hq-root']),
    ledgerTarget: values['ledger-target'],
    beforeSettlement: next => audit({ outcome: 'settlement-authorized',
      evidence: next.preReceiptReconciliation.query }),
  });
  const conclusive = result.status === 'no-launch';
  const output = { dryRun, ...identity, conclusive, status: result.status,
    reason: result.reason || result.record?.preReceiptReconciliation?.reason || 'not-a-pre-receipt-intent',
    evidence: result.evidence || null };
  if (!dryRun) output.auditPath = audit({ outcome: conclusive ? 'settled-no-dispatch'
    : `refused:${output.reason}`, evidence: output.evidence });
  print(JSON.stringify(output));
  if (!conclusive) throw new Error(`Closer intent settlement refused: ${output.reason}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
