// Keep dependencies built-ins-only: the read-only report avoids the writer's startup graph.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function nextActionShadowLogPath(rootDir) {
  return join(rootDir, 'data', 'next-action-shadow', 'disagreements.jsonl');
}

export function caseKeyOf(record) {
  return createHash('sha256').update(JSON.stringify([record.subjectKey, record.head,
    record.legacy?.action, record.legacy?.actor, record.legacy?.reason,
    record.next?.action, record.next?.actor, record.next?.reason])).digest('hex').slice(0, 24);
}
