function normalizeGithubLabelName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeGithubLabelEvent(event, labelName) {
  const label = event?.label?.name || event?.label || event?.name || null;
  if (normalizeGithubLabelName(label) !== normalizeGithubLabelName(labelName)) {
    return null;
  }
  const actor = event?.actor?.login || event?.actor?.name || event?.user?.login || null;
  return {
    id: event?.id == null ? null : String(event.id),
    nodeId: event?.node_id || event?.nodeId || null,
    label: String(label),
    actor: actor ? String(actor) : null,
    createdAt: event?.created_at || event?.createdAt || null,
  };
}

function latestMatchingLabelEvent(events, labelName) {
  if (!Array.isArray(events)) return null;
  return events
    .filter((event) => String(event?.event || 'labeled').trim().toLowerCase() === 'labeled')
    .map((event) => normalizeGithubLabelEvent(event, labelName))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .at(-1) || null;
}

async function fetchLatestLabelEvent(repo, prNumber, labelName, {
  execFileImpl,
} = {}) {
  if (typeof execFileImpl !== 'function') {
    throw new Error('fetchLatestLabelEvent requires execFileImpl');
  }
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }

  const { stdout } = await execFileImpl('gh', [
    'api',
    `repos/${owner}/${name}/issues/${Number(prNumber)}/events?per_page=100`,
  ], { maxBuffer: 5 * 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '[]'));
  return latestMatchingLabelEvent(parsed, labelName);
}

export {
  fetchLatestLabelEvent,
  latestMatchingLabelEvent,
  normalizeGithubLabelName,
};
