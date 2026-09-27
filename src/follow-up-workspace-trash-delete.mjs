import { readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [trashDir, lockPath] = process.argv.slice(2);
try {
  for (const entry of readdirSync(trashDir)) {
    try {
      rmSync(join(trashDir, entry), { recursive: true, force: true });
    } catch {
      // Leave this entry for a later tick without blocking other workspaces.
    }
  }
} finally {
  try {
    if (Number(readFileSync(lockPath, 'utf8')) === process.pid) unlinkSync(lockPath);
  } catch { /* stale lock can be recovered by the next launch */ }
}
