import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

const [trashDir, lockPath, rootDir, workspaceRootDir] = process.argv.slice(2);

function recordDeleteFailure(entryPath, err) {
  const now = new Date();
  const name = basename(entryPath).replace(/-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu, '');
  const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : null;
  let workspace;
  try {
    const stat = statSync(entryPath);
    workspace = {
      uid: stat.uid, gid: stat.gid, mode: `0${(stat.mode & 0o777).toString(8)}`,
      runtimeUidMatchesOwner: Number.isInteger(runtimeUid) ? stat.uid === runtimeUid : null,
    };
  } catch (statErr) {
    workspace = { statError: { code: statErr?.code || null, message: statErr?.message || String(statErr) } };
  }
  const anomaly = {
    ts: now.toISOString(),
    type: ['EACCES', 'EPERM'].includes(err?.code)
      ? 'terminal-workspace-reap-permission-denied' : 'terminal-workspace-trash-delete-failed',
    name,
    workspacePath: workspaceRootDir ? join(workspaceRootDir, name) : null,
    trashPath: entryPath,
    hqRoot: process.env.HQ_ROOT || '(unset)',
    runtime: { user: process.env.LOGNAME || process.env.USER || 'unknown', uid: runtimeUid },
    error: { code: err?.code || null, message: err?.message || String(err) },
    workspace,
    action: 'left-workspace-in-trash',
  };
  const record = `${JSON.stringify(anomaly, null, 2)}\n`;
  try {
    if (!rootDir) throw new Error('missing anomaly root');
    const anomalyDir = join(rootDir, 'data', 'archive-anomalies');
    mkdirSync(anomalyDir, { recursive: true });
    writeFileSync(join(anomalyDir, `${now.toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.json`), record, { flag: 'wx', mode: 0o640 });
  } catch (recordErr) {
    // Preserve a visible failure even when the shared anomaly directory is unavailable.
    appendFileSync(join(trashDir, 'delete-failures.jsonl'), JSON.stringify({ ...anomaly, anomalyWriteError: String(recordErr) }) + '\n');
  }
}
try {
  for (const entry of readdirSync(trashDir)) {
    if (entry === 'delete-failures.jsonl') continue;
    try {
      rmSync(join(trashDir, entry), { recursive: true, force: true });
    } catch (err) {
      recordDeleteFailure(join(trashDir, entry), err);
    }
  }
} finally {
  try {
    if (Number(readFileSync(lockPath, 'utf8')) === process.pid) unlinkSync(lockPath);
  } catch { /* stale lock can be recovered by the next launch */ }
}
