import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const GATE_CONTEXT = 'agent-os/adversarial-gate';

const PASSING_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const HARD_STOP_LABELS = new Set([
  'merge-agent-stuck',
  'merge-agent-recovery-in-flight',
  'paused-for-redesign',
  'reviewer-cycle-cap-reached',
]);
const UNADDRESSABLE_CATEGORIES = new Set(['auth', 'schema-migration', 'external-system', 'policy']);
const NESTED_FIELD_LABEL_PATTERN = String.raw`(?:Category|File|Lines|Problem|Why it matters|Recommended fix)`;

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function extractSection(reviewBody, heading) {
  const text = String(reviewBody ?? '').replace(/\r\n/g, '\n');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'i');
  const lines = text.split('\n');
  let inFence = false;
  let offset = 0;
  let start = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^(?:```|~~~)/.test(trimmed)) inFence = !inFence;
    if (!inFence && pattern.test(line)) {
      start = offset + line.length;
      break;
    }
    offset += line.length + 1;
  }
  if (start == null) return null;

  inFence = false;
  offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    const trimmed = line.trimStart();
    if (lineStart > start && !inFence && /^##\s+/.test(line)) {
      return text.slice(start, lineStart);
    }
    if (/^(?:```|~~~)/.test(trimmed)) inFence = !inFence;
    offset += line.length + 1;
  }
  return text.slice(start);
}

function verdictKindToDisplay(kind) {
  if (kind === 'approved') return 'Approved';
  if (kind === 'comment-only') return 'Comment only';
  if (kind === 'request-changes') return 'Request changes';
  return null;
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
  if (!/^-\s+none\.?(?:\s+.*)?$/i.test(nonEmpty[0].trim())) return false;
  return nonEmpty.slice(1).every((line) => /^\s+/.test(line));
}

function parseNestedField(blockLines, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s+-\\s+\\*\\*${escaped}:\\*\\*\\s*(.*)$`, 'i');
  const nestedFieldPattern = new RegExp(`^\\s+-\\s+\\*\\*${NESTED_FIELD_LABEL_PATTERN}:\\*\\*`, 'i');
  for (let index = 0; index < blockLines.length; index += 1) {
    const line = blockLines[index];
    const match = line.match(pattern);
    if (!match) continue;

    const parts = [match[1].trim()];
    for (let next = index + 1; next < blockLines.length; next += 1) {
      const nextLine = blockLines[next];
      if (/^-\s+/.test(nextLine) || nestedFieldPattern.test(nextLine)) break;
      if (!nextLine.trim()) {
        parts.push('');
        continue;
      }
      if (!/^\s+/.test(nextLine)) break;
      parts.push(nextLine.trim());
    }
    return normalizeOptionalString(parts.join('\n'));
  }
  return null;
}

function parseFindingBlock(blockLines, kind) {
  const category = parseNestedField(blockLines, 'Category');
  const titleLine = blockLines[0] || '';
  const titleMatch = titleLine.match(/^-\s+\*\*(.+?)\*\*(.*)$/);
  const title = titleMatch ? normalizeOptionalString(titleMatch[1].replace(/[ \t]*:[ \t]*$/u, '')) : null;
  return {
    kind,
    title,
    category: category == null ? null : category.toLowerCase(),
    file: parseNestedField(blockLines, 'File'),
    lines: parseNestedField(blockLines, 'Lines'),
    problem: parseNestedField(blockLines, 'Problem'),
    whyItMatters: parseNestedField(blockLines, 'Why it matters'),
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
    .map((label) => {
      if (label && typeof label === 'object' && 'name' in label) {
        return String(label.name ?? '').trim().toLowerCase();
      }
      return String(label ?? '').trim().toLowerCase();
    })
    .filter(Boolean);
}

function hasHardStopLabel(labels) {
  return normalizeLabels(labels).some((label) => HARD_STOP_LABELS.has(label));
}

function isGateRow(row) {
  const contexts = new Set([GATE_CONTEXT]);
  try {
    contexts.add(String(resolveGateStatusContext(process.env)).trim().toLowerCase());
  } catch {
    // Keep the default context active if the env override is malformed.
  }
  const label = String(row?.context || row?.name || '').trim().toLowerCase();
  return contexts.has(label);
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
  if (!Array.isArray(input?.statusCheckRollup)) return false;
  const rows = checkRowsForHead(input?.statusCheckRollup, input?.headSha);
  if (rows.length === 0) return true;
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
  const verdict = verdictKindToDisplay(normalizeEffectiveReviewVerdict(input.reviewBody));
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

  if (
    (verdict === 'Approved' || verdict === 'Comment only')
    && blockingFindings === 0
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
    verdict: verdictKindToDisplay(normalizeEffectiveReviewVerdict(reviewBody)),
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
};

export default classify;
