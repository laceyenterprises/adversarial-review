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
    headSha: event?.headSha || event?.head_sha || null,
    codeScopedAt: event?.codeScopedAt || event?.code_scoped_at || null,
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

function normalizeTimelineActor(actor) {
  return actor?.login || actor?.name || null;
}

function normalizeTimelineLabelEvent(node, labelName) {
  if (node?.__typename !== 'LabeledEvent') return null;
  const label = node?.label?.name || null;
  if (normalizeGithubLabelName(label) !== normalizeGithubLabelName(labelName)) {
    return null;
  }
  const actor = normalizeTimelineActor(node.actor);
  return {
    id: node.id || null,
    nodeId: node.id || null,
    label: String(label),
    actor: actor ? String(actor) : null,
    createdAt: node.createdAt || null,
  };
}

function normalizeTimelineCodeAnchor(node, currentHeadSha) {
  const expectedHead = String(currentHeadSha || '');
  if (!expectedHead) return null;
  if (node?.__typename === 'PullRequestCommit') {
    const commit = node.commit || {};
    if (String(commit.oid || '') !== expectedHead) return null;
    return {
      id: node.id || null,
      kind: 'pull-request-commit',
      headSha: commit.oid,
      codeScopedAt: commit.committedDate || null,
    };
  }
  if (node?.__typename === 'HeadRefForcePushedEvent') {
    const commit = node.afterCommit || {};
    if (String(commit.oid || '') !== expectedHead) return null;
    return {
      id: node.id || null,
      kind: 'head-ref-force-pushed',
      headSha: commit.oid,
      codeScopedAt: node.createdAt || commit.committedDate || null,
    };
  }
  return null;
}

function latestMatchingScopedTimelineLabelEvent(nodes, labelName, currentHeadSha) {
  if (!Array.isArray(nodes)) return null;
  let currentHeadAnchor = null;
  let latestScopedLabel = null;

  for (const node of nodes) {
    const anchor = normalizeTimelineCodeAnchor(node, currentHeadSha);
    if (anchor) {
      currentHeadAnchor = anchor;
      latestScopedLabel = null;
      continue;
    }

    const labelEvent = normalizeTimelineLabelEvent(node, labelName);
    if (labelEvent && currentHeadAnchor) {
      latestScopedLabel = {
        ...labelEvent,
        headSha: currentHeadAnchor.headSha,
        codeScopedAt: currentHeadAnchor.codeScopedAt,
        codeScopeEventId: currentHeadAnchor.id,
        codeScopeEventKind: currentHeadAnchor.kind,
      };
    }
  }

  return latestScopedLabel;
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

  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          headRefOid
          timelineItems(
            last: 100
            itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT]
          ) {
            nodes {
              __typename
              ... on PullRequestCommit {
                id
                commit {
                  oid
                  committedDate
                }
              }
              ... on HeadRefForcePushedEvent {
                id
                createdAt
                afterCommit {
                  oid
                  committedDate
                }
              }
              ... on LabeledEvent {
                id
                createdAt
                actor {
                  login
                }
                label {
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const { stdout } = await execFileImpl('gh', [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${Number(prNumber)}`,
  ], { maxBuffer: 5 * 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '{}'));
  const pullRequest = parsed?.data?.repository?.pullRequest || null;
  return latestMatchingScopedTimelineLabelEvent(
    pullRequest?.timelineItems?.nodes || [],
    labelName,
    pullRequest?.headRefOid || null
  );
}

export {
  fetchLatestLabelEvent,
  latestMatchingLabelEvent,
  latestMatchingScopedTimelineLabelEvent,
  normalizeGithubLabelName,
};
