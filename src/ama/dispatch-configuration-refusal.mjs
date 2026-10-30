import { repositoryObservationCache } from '../repository-state-cache.mjs';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

export function dispatchConfigurationRefusal(error) {
  const detail = [error?.code, error?.message, error?.stderr, error?.stdout, typeof error === 'string' ? error : ''].filter(Boolean).join('\n');
  // Explicit admission codes take precedence over incidental timeout/retry text.
  return /\brepo_unregistered\b/i.test(detail) ? 'repo_unregistered' : null;
}

const delivered = repositoryObservationCache(new Set());
export async function pageDispatchConfigurationRefusal({ rootDir, repo, refusal, deliverAlertImpl, logger, now }) {
  const dir = join(rootDir, 'data', 'ama-dispatch-configuration');
  const path = join(dir, `${createHash('sha256').update(repo.toLowerCase()).digest('hex')}.json`);
  const lock = `${path}.lock`;
  let claimed = false;
  try {
    mkdirSync(dir, { recursive: true });
    try { if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock); } catch { /* absent claim */ }
    try { closeSync(openSync(lock, 'wx')); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    let prior;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first refusal */ }
    if (prior?.alertedAt || delivered.has(path)) return;
    await deliverAlertImpl(`AMA closure blocked for ${repo}: hq dispatch refused ${refusal}. Operator action: register the repository with hq repo register https://github.com/${repo}.git (see RUNBOOK-ama-closure.md, Dispatch configuration refusals). Closure rechecks on the normal re-walk backoff and resumes automatically after a successful dispatch.`, {
      event: 'ama_closer.dispatch_configuration_refused', payload: { repo, refusal },
    });
    delivered.add(path);
    writeFileAtomic(path, JSON.stringify({ repo, refusal, alertedAt: now || new Date().toISOString() }));
  } catch (error) { logger?.warn?.(`Dispatch configuration page failed: ${error.message}`); }
  finally { if (claimed) { try { unlinkSync(lock); } catch { /* expired claim */ } } }
}
