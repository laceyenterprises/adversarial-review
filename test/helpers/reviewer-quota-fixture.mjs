// Synthetic public CLI responses for policy fixtures; not producer recordings.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnReviewer as spawn, readReviewerQuotaDecision} from '../../src/reviewer-spawn-settle.mjs';
export function spawnReviewer(args) {
  return spawn({...args, readReviewerQuotaDecisionImpl: args.readReviewerQuotaDecisionImpl ?? (options =>
    readReviewerQuotaDecision({...options, execFileImpl: async (_command, argv) => {
      if (argv.join(' ') !== 'fleet quota status --json') throw new Error('unexpected fixture transport');
      const env = options.env || {};
      const directory = env.AGENT_OS_REVIEWER_QUOTA_STATUS_DIR || (env.HQ_ROOT || env.AGENT_OS_HQ_ROOT ? join(env.HQ_ROOT || env.AGENT_OS_HQ_ROOT, 'quota') : null);
      let names = []; try { names = directory ? readdirSync(directory) : []; } catch {}
      const providerStatuses = names.filter(name => name.endsWith('.status.json')).map(name => {
        const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        const provider = name.split('-oauth')[0];
        return {...value, provider, authPath: value.authPath || (name.includes('oauth-corp') ? 'oauth-corp' : 'oauth'), state: String(value.state || 'unknown').toLowerCase()};
      });
      return {stdout: JSON.stringify({providerStatuses})};
    }}))});
}
