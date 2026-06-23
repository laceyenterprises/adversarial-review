const GATE_CONTEXT = 'agent-os/adversarial-gate';

const PASSING_CHECK_STATES = new Set(['SUCCESS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const HARD_STOP_LABELS = new Set([
  'merge-agent-stuck',
  'merge-agent-recovery-in-flight',
  'paused-for-redesign',
  'reviewer-cycle-cap-reached',
]);
const UNADDRESSABLE_CATEGORIES = new Set(['auth', 'schema-migration', 'external-system', 'policy']);

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function extractSection(reviewBody, heading) {
  const text = String(reviewBody ?? '').replace(/\r\n/g, '\n');
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const match = text.match(pattern);
  if (!match) return null;
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const nextHeading = remainder.search(/^##\s+/m);
  return nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
}

function parseVerdict(reviewBody) {
  const section = extractSection(reviewBody, 'Verdict');
  if (section == null) return null;
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let verdict = null;
  for (const line of lines) {
    if (/^Approved(?:\s*$|[\s:.,;!?()\-–—])/.test(line)) verdict = 'Approved';
    else if (/^Comment only(?:\s*$|[\s:.,;!?()\-–—])/.test(line)) verdict = 'Comment only';
    else if (/^Request changes(?:\s*$|[\s:.,;!?()\-–—])/.test(line)) verdict = 'Request changes';
  }
  return verdict;
}

function topLevelBulletIndexes(lines) {
  const indexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-\s+/.test(lines[i])) indexes.push(i);
  }
  return indexes;
}

function sectionIsNone(lines) {
  const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
  if (nonEmpty.length === 0) return true;
  if (!/^-\s+None\.(?:\s+.*)?$/.test(nonEmpty[0].trim())) return false;
  return nonEmpty.slice(1).every((line) => /^\s+/.test(line));
}

function parseNestedField(blockLines, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s+-\\s+\\*\\*${escaped}:\\*\\*\\s*(.*)$`);
  for (const line of blockLines) {
    const match = line.match(pattern);
    if (match) return normalizeOptionalString(match[1]);
  }
  return null;
}

function parseFindingBlock(blockLines, kind) {
  const category = parseNestedField(blockLines, 'Category');
  return {
    kind,
    category: category == null ? null : category.toLowerCase(),
    file: parseNestedField(blockLines, 'File'),
    lines: parseNestedField(blockLines, 'Lines'),
    problem: parseNestedField(blockLines, 'Problem'),
    recommendedFix: parseNestedField(blockLines, 'Recommended fix'),
  };
}

function parseIssueSection(reviewBody, heading, kind) {
  const section = extractSection(reviewBody, heading);
  if (section == null) {
    return { missing: true, count: 0, findings: [] };
  }
  const lines = section.replace(/\r\n/g, '\n').split('\n');
  if (sectionIsNone(lines)) {
    return { missing: false, count: 0, findings: [] };
  }

  const indexes = topLevelBulletIndexes(lines);
  if (indexes.length === 0) {
    return { missing: false, count: section.trim() ? 1 : 0, findings: section.trim() ? [parseFindingBlock([], kind)] : [] };
  }

  const findings = indexes.map((start, index) => {
    const end = index + 1 < indexes.length ? indexes[index + 1] : lines.length;
    return parseFindingBlock(lines.slice(start, end), kind);
  });
  return { missing: false, count: findings.length, findings };
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => String(label ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function hasHardStopLabel(labels) {
  return normalizeLabels(labels).some((label) => HARD_STOP_LABELS.has(label));
}

function isGateRow(row) {
  return String(row?.context ?? '').trim().toLowerCase() === GATE_CONTEXT;
}

function checkRowsForHead(statusCheckRollup, headSha) {
  if (!Array.isArray(statusCheckRollup)) return [];
  return statusCheckRollup.filter((row) => {
    const rowOid = normalizeOptionalString(row?.commit?.oid);
    return (!rowOid || !headSha || rowOid === headSha) && !isGateRow(row);
  });
}

function checkState(row) {
  return String(row?.conclusion || row?.status || row?.state || '').trim().toUpperCase();
}

function checksPass(input) {
  const rows = checkRowsForHead(input?.statusCheckRollup, input?.headSha);
  if (rows.length === 0) return false;
  for (const row of rows) {
    const state = checkState(row);
    if (!state || PENDING_CHECK_STATES.has(state)) return false;
    if (!PASSING_CHECK_STATES.has(state)) return false;
  }
  return true;
}

function hasValidOperatorApproval(input) {
  return Boolean(
    input?.operatorApprovalLabelEventId
    && input?.operatorApprovalActor
    && input?.operatorApprovalLabeledAt
    && input?.operatorApprovalHeadSha
    && input?.headSha
    && String(input.operatorApprovalHeadSha) === String(input.headSha)
  );
}

function isMergeable(input) {
  return String(input?.mergeable ?? '').trim().toUpperCase() === 'MERGEABLE';
}

function classify(input = {}) {
  const verdict = parseVerdict(input.reviewBody);
  const blocking = parseIssueSection(input.reviewBody, 'Blocking issues', 'blocking');
  const nonBlocking = parseIssueSection(input.reviewBody, 'Non-blocking issues', 'non-blocking');
  const parsedFindings = [...blocking.findings, ...nonBlocking.findings].map(({ kind: _kind, ...finding }) => finding);
  const blockingFindings = blocking.count;
  const nonBlockingFindings = nonBlocking.count;
  const hardStop = hasHardStopLabel(input.labels);
  const checksArePassing = checksPass(input);
  const mergeable = isMergeable(input);

  if (hasValidOperatorApproval(input) && mergeable && checksArePassing && !hardStop) {
    return {
      decision: 'merge-eligible',
      reason: 'operator-approved',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (input.reviewHeadSha != null && input.headSha != null && String(input.reviewHeadSha) !== String(input.headSha)) {
    return {
      decision: 'escalate-stale-review',
      reason: 'review-head-stale',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (!verdict || blocking.missing || nonBlocking.missing) {
    return {
      decision: 'inconclusive',
      reason: 'malformed-review',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if ((verdict === 'Approved' || verdict === 'Comment only') && (blockingFindings > 0 || nonBlockingFindings > 0)) {
    return {
      decision: 'inconclusive',
      reason: 'clean-verdict-with-findings',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (
    (verdict === 'Approved' || verdict === 'Comment only')
    && blockingFindings === 0
    && (verdict !== 'Comment only' || nonBlockingFindings === 0)
    && mergeable
    && checksArePassing
    && !hardStop
  ) {
    return {
      decision: 'merge-eligible',
      reason: 'clean-review',
      blockingFindings,
      nonBlockingFindings,
      parsedFindings,
    };
  }

  if (verdict === 'Request changes') {
    const blockerCategories = blocking.findings
      .map((finding) => finding.category)
      .filter(Boolean);
    if (blockerCategories.some((category) => UNADDRESSABLE_CATEGORIES.has(category))) {
      return {
        decision: 'escalate-blockers',
        reason: 'unaddressable-blocker',
        blockingFindings,
        nonBlockingFindings,
        parsedFindings,
      };
    }
    if (blockingFindings > 0 || (blockingFindings === 0 && nonBlockingFindings > 0)) {
      return {
        decision: 'remediation-eligible',
        reason: 'addressable-findings',
        blockingFindings,
        nonBlockingFindings,
        parsedFindings,
      };
    }
  }

  return {
    decision: 'inconclusive',
    reason: 'no-matching-decision-rule',
    blockingFindings,
    nonBlockingFindings,
    parsedFindings,
  };
}

function parseReviewBody(reviewBody) {
  const blocking = parseIssueSection(reviewBody, 'Blocking issues', 'blocking');
  const nonBlocking = parseIssueSection(reviewBody, 'Non-blocking issues', 'non-blocking');
  return {
    verdict: parseVerdict(reviewBody),
    blocking,
    nonBlocking,
    parsedFindings: [...blocking.findings, ...nonBlocking.findings].map(({ kind: _kind, ...finding }) => finding),
  };
}

export {
  HARD_STOP_LABELS,
  UNADDRESSABLE_CATEGORIES,
  checkRowsForHead,
  checksPass,
  parseReviewBody,
  parseVerdict,
};

export default classify;
