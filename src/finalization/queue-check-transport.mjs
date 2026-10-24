// Explicit entitled credentials only. Reuse the supported broker export parser
// and held-credential fallback; neither gh's login cache nor ambient GH_TOKEN
// can provide a queue identity.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hammerTokenSession } from '../hammer-token.mjs';
import { buildAllowlistedGhEnv } from '../gh-cli.mjs';
import { queueWaitMs } from './queue-wait.mjs';

const execAsync = promisify(execFile);
export function createEntitledQueueCheckRequest({ credentialEnv, execFileImpl = execAsync,
  now = () => new Date().toISOString(), load } = {}) {
  return { name: 'entitled-gh-read-v1', async read({ path, deadline, timeoutMs, signal }) {
    if (!credentialEnv || (!['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN'].some(key =>
      credentialEnv[key] || credentialEnv[`${key}_REFRESH_COMMAND`]) && !credentialEnv.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND)
      || !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commits\/[a-f0-9]{40}\/(check-runs|statuses)\?/.test(path)) {
      throw new Error('entitled-check-reader-unavailable');
    }
    const callDeadline = new Date(Math.min(Date.parse(deadline), Date.parse(now()) + timeoutMs)).toISOString();
    const wait = () => queueWaitMs(5_000, { ceilingMs: 30_000, deadline: callDeadline, now: now(), load });
    const session = hammerTokenSession({ credentialEnv, hammerToken: true, env: buildAllowlistedGhEnv(credentialEnv) });
    for (;;) {
      signal?.throwIfAborted();
      const refreshBudget = wait();
      if (!refreshBudget) throw new Error('checks-deadline-expired');
      const active = session.prepare({ timeoutMs: refreshBudget });
      const remaining = wait();
      if (!remaining) throw new Error('checks-deadline-expired');
      let result;
      try {
        result = await execFileImpl('gh', ['api', '--include', '--method', 'GET', path], {
          ...active, timeout: remaining, signal, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL',
        });
      } catch (error) { session.retry(error); continue; }
      // Only accept a single successful response with explicit pagination.
      const output = session.redact(String(result.stdout));
      const match = /^HTTP\/[^\r\n]+ 200[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(output);
      if (!match) throw new Error('checks-response-unreadable');
      const links = match[1].split(/\r?\n/).filter(line => /^link:/i.test(line));
      let nextPage = null;
      if (links.length > 1) throw new Error('checks-pagination-unreadable');
      if (links.length) {
        for (const link of links[0].slice(5).split(',')) {
          const part = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(link);
          if (!part) throw new Error('checks-pagination-unreadable');
          if (part[2] === 'next') {
            const url = new URL(part[1]);
            const expected = new URL(path, 'https://api.github.com');
            if (url.origin !== expected.origin || url.pathname !== expected.pathname
              || url.searchParams.get('per_page') !== '100' || url.searchParams.get('filter') !== expected.searchParams.get('filter')) throw new Error('checks-pagination-unreadable');
            nextPage = Number(url.searchParams.get('page'));
            if (!Number.isSafeInteger(nextPage) || nextPage < 2) throw new Error('checks-pagination-unreadable');
          }
        }
      }
      return { body: JSON.parse(match[2]), nextPage, sourceRef: `github:${path}` };
    }
  } };
}
