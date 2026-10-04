import { setTimeout as delay } from 'node:timers/promises';

function transientReadError(err) {
  const status = Number(err?.status || err?.response?.status);
  return status === 429 || status >= 500
    || (status === 403 && /rate limit|secondary limit/i.test(err?.message || ''))
    || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET)/.test(err?.code || err?.cause?.code || '')
    || (!status && /fetch failed|TLS|socket hang up|timeout/i.test(err?.message || ''));
}

async function readWithRetry(read) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); } catch (err) {
      if (attempt >= 2 || !transientReadError(err)) throw err;
      await delay(100 * (attempt + 1));
    }
  }
}

// Partial or moved-head listings cannot corroborate an advisory hold.
export async function collectDuplicateContent({ octokit, owner, repo, prNumber, headSha }) {
  const paths = [];
  const unavailable = (reason) => ({ headSha, paths: null, reason });
  for (let page = 1; ; page += 1) {
    const { data } = await readWithRetry(() => octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100, page }));
    paths.push(...data.map((file) => file.filename));
    if (data.length < 100) break;
    if (page >= 30) return unavailable('content-truncated');
  }
  const { data: live } = await readWithRetry(() => octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }));
  if (live.head.sha !== headSha) return unavailable('content-head-moved');
  return { headSha, paths };
}
