// GUARDREVERT-01: authority comes from live required check runs, never from a
// hammer trailer or a PR body. Keep this evidence outside the history cache:
// required contexts and check reruns can change without a head move.
const SHA = /^[0-9a-f]{40}$/i;
const forbidden = /\b(?:forbidden|not allowed|must not|cannot|do not|reject(?:ed)?)\b.*\b(?:pull requests?|PRs?)\b|\b(?:pull requests?|PRs?)\b.*\b(?:forbidden|not allowed|must not|cannot|do not|reject(?:ed)?)\b/i;

async function pages(get, path, field = null) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = field ? result[field] : result;
    if (!Array.isArray(batch)) throw new Error('incomplete guard evidence');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error('capped guard evidence');
}

function latest(runs, head) {
  const result = new Map();
  for (const run of runs) {
    if (run.head_sha !== head || !Number.isSafeInteger(run.id) || !run.app?.id) continue;
    const key = `${run.name}:${run.app.id}`;
    if (!result.has(key) || result.get(key).id < run.id) result.set(key, run);
  }
  return result;
}

function statements(text) {
  return String(text || '').split(/\n|;|\.\s+|\s+(?:but|whereas|while|except)\s+/i)
    .map(line => line.trim()).filter(Boolean);
}

function namesPath(text, path) {
  // Bind the prohibition to this literal path's statement. Merely mentioning
  // an allowed file beside a different forbidden file grants no authority.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = '[`"\']?' + escaped + '[`"\']?';
  const subject = new RegExp('^(?:[-*]\\s+)?(?:in\\s+(?:pull requests?|PRs?),?\\s+)?(?:the\\s+(?:file|path)\\s+)?' + token
    + '(?:\\s*:\\s*|\\s+(?:is\\s+)?(?:generated\\s+and\\s+)?(?=forbidden|not allowed|must not|cannot|do not|rejected))', 'i');
  const command = new RegExp('^(?:do not|must not|cannot)\\s+(?:edit|modify|change|include|regenerate)\\s+' + token + '(?:\\s|$)', 'i');
  const label = new RegExp('^forbidden in (?:pull requests?|PRs?)\\s*:\\s*' + token + '[.!]?$', 'i');
  return statements(text).some(line => forbidden.test(line)
      && (subject.test(line) || command.test(line) || label.test(line)));
}

export function verifiedGuardReversals(evidence, headSha) {
  if (evidence?.headSha !== headSha || !Array.isArray(evidence.primaryFiles)
    || !Array.isArray(evidence.finalFiles)
    || (evidence.completeFileLists !== true && Math.max(evidence.primaryFiles.length, evidence.finalFiles.length) >= 300)) return [];
  return (evidence.guardReversals || []).filter(proof => {
    const { failedRun, passingRun, requiredCheck, path } = proof;
    return typeof path === 'string' && path !== '' && !path.split('/').includes('..')
      && proof.baseSha === evidence.baseSha && SHA.test(proof.baseSha || '')
      && failedRun?.head_sha === evidence.primaryHead
      && passingRun?.head_sha === headSha && SHA.test(headSha || '')
      && failedRun.status === 'completed' && failedRun.conclusion === 'failure'
      && passingRun.status === 'completed' && passingRun.conclusion === 'success'
      && Number.isSafeInteger(failedRun.id) && Number.isSafeInteger(passingRun.id)
      && failedRun.app?.id && failedRun.app.id === passingRun.app?.id
      && requiredCheck?.context === failedRun.name && passingRun.name === failedRun.name
      && (requiredCheck.app_id == null || requiredCheck.app_id === -1 || requiredCheck.app_id === failedRun.app.id)
      && proof.restoredToBase === true
      && namesPath(proof.prohibition, path)
      && evidence.primaryFiles.some(file => file.filename === path && ['added', 'modified'].includes(file.status)
        && typeof file.patch === 'string')
      && !evidence.finalFiles.some(file => file.filename === path || file.previous_filename === path);
  });
}

export async function fetchGuardReversals({ repo, prNumber, headSha, get }, evidence) {
  if (evidence.hasHammerCommits !== true || !evidence.baseRef || !Array.isArray(evidence.finalFiles)) return {};
  const paths = (evidence.primaryFiles || []).filter(file => ['added', 'modified'].includes(file.status)
    && !evidence.finalFiles.some(final => final.filename === file.filename || final.previous_filename === file.filename))
    .map(file => file.filename);
  if (!paths.length) return {};
  try {
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha || pr.base?.sha !== evidence.baseSha
      || !SHA.test(pr.base?.sha || '') || !pr.base.ref) return {};
    const protection = await get(`repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection/required_status_checks`);
    const required = [...(protection.checks || []), ...(protection.contexts || [])
      .filter(context => !(protection.checks || []).some(check => check.context === context)).map(context => ({ context }))];
    if (!required.length) return {};
    const before = latest(await pages(get, `repos/${repo}/commits/${evidence.primaryHead}/check-runs`, 'check_runs'), evidence.primaryHead);
    const after = latest(await pages(get, `repos/${repo}/commits/${headSha}/check-runs`, 'check_runs'), headSha);
    // Base movement must not make a merge-base restoration masquerade as a
    // restoration to the live base. Complete immutable tree comparisons supply
    // this proof in production through createHistoryReader.
    const baseDelta = pr.base.sha === evidence.mergeBase ? []
      : (await get(`repos/${repo}/compare/${evidence.mergeBase}...${pr.base.sha}`)).files;
    if (!Array.isArray(baseDelta) || baseDelta.length >= 300) return {};
    const guardReversals = [];
    for (const failedRun of before.values()) {
      const requiredCheck = required.find(check => check.context === failedRun.name
        && (check.app_id == null || check.app_id === -1 || check.app_id === failedRun.app.id));
      const passingRun = after.get(`${failedRun.name}:${failedRun.app.id}`);
      if (!requiredCheck || failedRun.conclusion !== 'failure' || passingRun?.conclusion !== 'success') continue;
      const annotations = await pages(get, `repos/${repo}/check-runs/${failedRun.id}/annotations`);
      for (const path of paths) {
        if (baseDelta.some(file => file.filename === path || file.previous_filename === path)) continue;
        const annotationProhibition = annotations.map(item => {
          const text = [item.title, item.message].filter(Boolean).join('\n');
          // GitHub's annotation path binds every diagnostic statement, even
          // after a punctuated title or an introductory message sentence.
          return item.path === path ? statements(text).map(line => `${path}: ${line}`).join('\n') : text;
        }).find(text => namesPath(text, path));
        const prohibition = annotationProhibition
          || [failedRun.output?.summary, failedRun.output?.text].filter(Boolean).join('\n');
        if (!namesPath(prohibition, path)) continue;
        guardReversals.push({ path, baseSha: pr.base.sha, restoredToBase: true,
          requiredCheck, failedRun, passingRun, prohibition,
          authorization: `Reversal-Authorized-By: guard:${failedRun.name}` });
      }
    }
    const finalPr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (finalPr.head?.sha !== headSha || finalPr.base?.sha !== pr.base.sha) return {};
    return { baseSha: pr.base.sha, guardReversals };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    // An unavailable waiver never weakens the ordinary preservation gate.
    return { guardReversalReadError: String(error.message || error) };
  }
}
