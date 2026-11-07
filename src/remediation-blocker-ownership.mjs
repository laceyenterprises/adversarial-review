import { isDeclaredOperationalBlockerCode } from './kernel/remediation-reply.mjs';

// Presentation and completion routing share this conservative classification.
// Unknown blockers still need a person; worker text never grants merge authority.
export function operationalBlockerOwner(entry) {
  const humanInput = String(entry?.needsHumanInput || '').trim();
  // Older workers used this field for the pipeline's CI -> review sequence.
  // Accept that entire sentence only, never an appended request for access.
  const legacyCiFollowup = /^Confirm (?:CI|[\w-]+|required checks?) (?:succeeds?|pass(?:es)?|completes?) for the pushed head, then request (?:another )?(?:adversarial )?review pass\.?$/i.test(humanInput);
  if ((humanInput && !legacyCiFollowup) || isDeclaredOperationalBlockerCode(entry)) return 'human';
  // Structured ownership is authoritative. Prose cannot override a pending-CI
  // tag; an actual input request belongs in needsHumanInput (checked above).
  if (entry?.kind === 'pending-ci') return 'CI';
  if (entry?.kind !== undefined) return 'human';
  const fields = [entry?.title, entry?.finding, entry?.reasoning].filter(Boolean);
  const text = fields.join(' ');
  // Legacy prose alone needs a conservative heuristic. Remove only explicit
  // negated need phrases, never a whole sentence that could also request access.
  // Only strip a standalone negated-need clause. Embedded "no credentials"
  // can describe a missing prerequisite. Commas are accepted only in an
  // enumerated list ending in ", or", never across a new approval clause.
  const needItem = '(?:additional|human|operator|finding|input|decision|approval|intervention|action|credentials?|permissions?|authentication|authorization|access|adversarial|review)';
  const listItem = `${needItem}(?:\\s+${needItem})*`;
  const negatedNeed = new RegExp(`\\bno (?:${listItem}(?:,\\s*${listItem})*,\\s*or\\s+${listItem}|${needItem}(?:\\s+(?:${needItem}|or|and))*)\\s+(?:(?:is|are)\\s+)?(?:needed|required|necessary)\\b`, 'gi');
  const legacyNeeds = fields.map(field => String(field).replace(negatedNeed, (phrase, offset, value) =>
    /(?:^|[.!?;:]|\n)\s*(?:[-*>]\s+)?$/.test(value.slice(0, offset)) ? '' : phrase)).join(' ');
  if (/\b(?:credentials?|auth(?:entication|orization)?|permissions?|operator|human|decision|conflicting requirements?|approval|(?:auth|access|api|session|bearer|github)[ -]tokens?)\b/i.test(legacyNeeds)
    || /\b(?:fetch|rebase|push)\b[^.]{0,30}\b(?:failed|rejected|conflict)\b/i.test(text)) return 'human';
  if (legacyCiFollowup) return 'CI';
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
