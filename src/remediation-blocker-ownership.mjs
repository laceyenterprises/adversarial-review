import { isDeclaredOperationalBlockerCode } from './kernel/remediation-reply.mjs';

// Presentation and completion routing share this conservative classification.
// Unknown blockers still need a person; worker text never grants merge authority.
export function operationalBlockerOwner(entry) {
  const text = [entry?.title, entry?.finding, entry?.reasoning].filter(Boolean).join(' ');
  const humanInput = String(entry?.needsHumanInput || '').trim();
  // Older workers used this field for the pipeline's CI -> review sequence.
  // Accept that entire sentence only, never an appended request for access.
  const legacyCiFollowup = /^Confirm (?:CI|[\w-]+|required checks?) (?:succeeds?|pass(?:es)?|completes?) for the pushed head, then request (?:another )?(?:adversarial )?review pass\.?$/i.test(humanInput);
  if ((humanInput && !legacyCiFollowup) || isDeclaredOperationalBlockerCode(entry)
    || /\b(?:credentials?|auth(?:entication|orization)?|permissions?|operator|human|decision|conflicting requirements?|approval|tokens?)\b/i.test(text)
    || /\b(?:fetch|rebase|push)\b[^.]{0,30}\b(?:failed|rejected|conflict)\b/i.test(text)) return 'human';
  if (entry?.kind === 'pending-ci') return 'CI';
  if (entry?.kind !== undefined) return 'human';
  // Legacy replies have no ownership field. Accept only explicit wait language.
  if (/\b(?:pending-ci|ci-pending|pr-head-ci-pending)\b/i.test(entry?.title || '')
    || /\b(?:required checks?|PR[- ]head CI|CI checks?|CI)\b (?:is |are |remains? |still )?(?:pending|queued|running|in[ -]progress)\b/i.test(text)) return 'CI';
  if (/\b(?:AMA )?closer (?:retains?|owns?) (?:closure authority|(?:PR )?closure|(?:the )?close)\b/i.test(text)) return 'AMA closer';
  if (/\b(?:re-review|adversarial review) (?:is |already )?(?:queued|pending)\b/i.test(text)
    || /\b(?:watcher|pipeline) will (?:run|queue) (?:the |a )?(?:re-review|adversarial review)\b/i.test(text)) return 'review pipeline';
  return 'human';
}

export function classifyRemediationBlockers(reply) {
  const owners = (reply?.operationalBlockers || []).map(operationalBlockerOwner);
  const humanRequired = Boolean(reply?.blockers?.length) || owners.includes('human')
    || (reply?.outcome === 'blocked' && owners.length === 0);
  return { humanRequired, pipelineOwners: [...new Set(owners.filter(owner => owner !== 'human'))] };
}

export function reportsCompletedPipelineWait(reply) {
  const { humanRequired, pipelineOwners } = classifyRemediationBlockers(reply);
  return !humanRequired && pipelineOwners.length > 0 && (reply?.outcome === 'completed'
    || /^Remediation (?:is )?complete[.;:]?(?:\s|$)/i.test(reply?.summary || ''));
}
