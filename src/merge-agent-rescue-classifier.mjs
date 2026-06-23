const GATE_STATUS_CONTEXT = 'agent-os/adversarial-gate';
const PASSING_CHECK_STATES = new Set(['SUCCESS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const HARD_STOP_LABELS = new Set([
  'merge-agent-stuck',
  'merge-agent-recovery-in-flight',
  'paused-for-redesign',
  'reviewer-cycle-cap-reached',
]);
const UNADDRESSABLE_CATEGORIES = new Set(['auth', 'schema-migration', 'external-system', 'policy']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullable(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function stripInlineCode(value) {
  const normalized = normalizeString(value);
  const match = normalized.match(/^`([^`]*)`$/);
  return match ? match[1].trim() || null : normalized || null;
}

function findSection(reviewBody, titlePattern) {
  const text = String(reviewBody ?? '').replace(/\r\n?/g, '\n');
  const headingRe = /^##\s+(.+?)\s*$/gm;
  let match;
  while ((match = headingRe.exec(text)) !== null) {
    if (!titlePattern.test(match[1])) continue;
    const start = headingRe.lastIndex;
    const nextMatch = /^##\s+.+?\s*$/gm;
    nextMatch.lastIndex = start;
    const next = nextMatch.exec(text);
    return text.slice(start, next ? next.index : text.length);
  }
  return null;
}

function parseVerdict(reviewBody) {
  const section = findSection(reviewBody, /^Verdict$/i);
  if (section === null) return { verdict: null, sectionPresent: false };
  let verdict = null;
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:[-*]\s+)?(?:\*\*)?(Approved|Comment only|Request changes)(?:\*\*)?(?:\s*$|\b\s*(?::|--|-).*$)/i);
    if (match) {
      const normalized = match[1].toLowerCase();
      if (normalized === 'approved') verdict = 'Approved';
      else if (normalized === 'comment only') verdict = 'Comment only';
      else if (normalized === 'request changes') verdict = 'Request changes';
    }
  }
  return { verdict, sectionPresent: true };
}

function topLevelBulletIndexes(lines) {
  const indexes = [];
  lines.forEach((line, index) => {
    if (/^-\s+/.test(line)) indexes.push(index);
  });
  return indexes;
}

function parseFindingChunk(chunk) {
  const finding = {
    category: null,
    file: null,
    lines: null,
    problem: null,
    recommendedFix: null,
  };
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^-\s+\*\*(Category|File|Lines|Problem|Recommended fix):\*\*\s*(.*)$/);
    if (!match) continue;
    const field = match[1];
    const value = match[2];
    if (field === 'Category') finding.category = normalizeString(value).toLowerCase() || null;
    else if (field === 'File') finding.file = stripInlineCode(value);
    else if (field === 'Lines') finding.lines = stripInlineCode(value);
    else if (field === 'Problem') finding.problem = normalizeNullable(value);
    else if (field === 'Recommended fix') finding.recommendedFix = normalizeNullable(value);
  }
  return finding;
}

function parseFindingsSection(reviewBody, titlePattern) {
  const section = findSection(reviewBody, titlePattern);
  if (section === null) {
    return { sectionPresent: false, count: 0, findings: [], state: 'missing' };
  }

  const lines = section.replace(/\s+$/g, '').split('\n');
  const bulletIndexes = topLevelBulletIndexes(lines);
  if (bulletIndexes.length === 0) {
    return section.trim()
      ? { sectionPresent: true, count: 1, findings: [parseFindingChunk(section)], state: 'malformed-findings' }
      : { sectionPresent: true, count: 0, findings: [], state: 'empty' };
  }

  const firstBullet = lines[bulletIndexes[0]].trim();
  const noneSentinel = /^-\s+None(?:\.(?:\s+.*)?|\s*)$/i.test(firstBullet);
  const nonBulletContent = lines.some((line, index) => {
    if (!line.trim()) return false;
    if (bulletIndexes.includes(index)) return false;
    return !/^\s/.test(line) && !/^\s+-\s+/.test(line);
  });
  if (bulletIndexes.length === 1 && noneSentinel && !nonBulletContent) {
    return { sectionPresent: true, count: 0, findings: [], state: 'none' };
  }

  const findings = [];
  for (let i = 0; i < bulletIndexes.length; i += 1) {
    const start = bulletIndexes[i];
    const end = i + 1 < bulletIndexes.length ? bulletIndexes[i + 1] : lines.length;
    if (/^-\s+None(?:\.(?:\s+.*)?|\s*)$/i.test(lines[start].trim())) continue;
    findings.push(parseFindingChunk(lines.slice(start, end).join('\n')));
  }
  if (findings.length === 0 && nonBulletContent) {
    findings.push(parseFindingChunk(section));
  }
  return { sectionPresent: true, count: findings.length, findings, state: 'findings' };
}

export function parseReviewBody(reviewBody) {
  const verdict = parseVerdict(reviewBody);
  const blocking = parseFindingsSection(reviewBody, /^Blocking\s+issues?$/i);
  const nonBlocking = parseFindingsSection(reviewBody, /^Non[-\s]+blocking\s+issues?$/i);
  return {
    verdict: verdict.verdict,
    verdictSectionPresent: verdict.sectionPresent,
    blockingSectionPresent: blocking.sectionPresent,
    nonBlockingSectionPresent: nonBlocking.sectionPresent,
    blockingFindings: blocking.count,
    nonBlockingFindings: nonBlocking.count,
    parsedFindings: [...blocking.findings, ...nonBlocking.findings],
    blockingParsedFindings: blocking.findings,
    nonBlockingParsedFindings: nonBlocking.findings,
  };
}

function hasHardStopLabel(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => String(label ?? '').trim().toLowerCase())
    .some((label) => HARD_STOP_LABELS.has(label));
}

function checkIdentity(row) {
  return String(row?.name ?? row?.context ?? '').trim();
}

export function evaluateStatusChecks(statusCheckRollup, { headSha = null } = {}) {
  void headSha;
  const rows = (Array.isArray(statusCheckRollup) ? statusCheckRollup : [])
    .filter((row) => checkIdentity(row) !== GATE_STATUS_CONTEXT);
  if (rows.length === 0) {
    return { hasPassingCheck: false, allPassing: false, hasPending: false, hasNonPassing: false };
  }
  let hasPassingCheck = false;
  let hasPending = false;
  let hasNonPassing = false;
  for (const row of rows) {
    const state = String(row?.conclusion ?? row?.status ?? row?.state ?? '').trim().toUpperCase();
    if (PASSING_CHECK_STATES.has(state)) {
      hasPassingCheck = true;
    } else if (PENDING_CHECK_STATES.has(state)) {
      hasPending = true;
    } else {
      hasNonPassing = true;
    }
  }
  return {
    hasPassingCheck,
    allPassing: hasPassingCheck && !hasPending && !hasNonPassing,
    hasPending,
    hasNonPassing,
  };
}

function hasCurrentHeadOperatorApproval(input) {
  return Boolean(
    normalizeNullable(input?.operatorApprovalLabelEventId)
    && normalizeNullable(input?.operatorApprovalActor)
    && normalizeNullable(input?.operatorApprovalLabeledAt)
    && normalizeNullable(input?.operatorApprovalHeadSha)
    && normalizeNullable(input?.headSha)
    && normalizeNullable(input?.operatorApprovalHeadSha) === normalizeNullable(input?.headSha)
  );
}

function baseResult(parsed, decision, reason) {
  return {
    decision,
    reason,
    blockingFindings: parsed.blockingFindings,
    nonBlockingFindings: parsed.nonBlockingFindings,
    parsedFindings: parsed.parsedFindings,
    verdict: parsed.verdict,
  };
}

export default function classify(input = {}) {
  const parsed = parseReviewBody(input?.reviewBody);
  const checks = evaluateStatusChecks(input?.statusCheckRollup, { headSha: normalizeNullable(input?.headSha) });
  const mergeable = String(input?.mergeable ?? '').trim().toUpperCase();
  const hardStop = hasHardStopLabel(input?.labels);

  if (
    hasCurrentHeadOperatorApproval(input)
    && mergeable === 'MERGEABLE'
    && checks.hasPassingCheck
    && checks.allPassing
    && !hardStop
  ) {
    return baseResult(parsed, 'merge-eligible', 'operator-approved-current-head');
  }

  const reviewHeadSha = normalizeNullable(input?.reviewHeadSha);
  const headSha = normalizeNullable(input?.headSha);
  if (reviewHeadSha !== null && headSha !== null && reviewHeadSha !== headSha) {
    return baseResult(parsed, 'escalate-stale-review', 'review-head-sha-does-not-match-head-sha');
  }

  if (!parsed.verdict || !parsed.blockingSectionPresent || !parsed.nonBlockingSectionPresent) {
    return baseResult(parsed, 'inconclusive', 'malformed-review');
  }

  const hasAnyFinding = parsed.blockingFindings > 0 || parsed.nonBlockingFindings > 0;
  if ((parsed.verdict === 'Approved' || parsed.verdict === 'Comment only') && hasAnyFinding) {
    return baseResult(parsed, 'inconclusive', 'clean-verdict-with-findings');
  }

  if (
    (parsed.verdict === 'Approved' || parsed.verdict === 'Comment only')
    && parsed.blockingFindings === 0
    && (parsed.verdict !== 'Comment only' || parsed.nonBlockingFindings === 0)
    && mergeable === 'MERGEABLE'
    && checks.hasPassingCheck
    && checks.allPassing
    && !hardStop
  ) {
    return baseResult(parsed, 'merge-eligible', 'clean-review-and-passing-gates');
  }

  if (parsed.verdict === 'Request changes') {
    const hasUnaddressable = parsed.parsedFindings.some((finding) => UNADDRESSABLE_CATEGORIES.has(finding.category));
    if (hasUnaddressable) {
      return baseResult(parsed, 'escalate-blockers', 'unaddressable-blocking-finding');
    }
    if (parsed.blockingFindings > 0 || (parsed.blockingFindings === 0 && parsed.nonBlockingFindings > 0)) {
      return baseResult(parsed, 'remediation-eligible', 'addressable-review-findings');
    }
  }

  return baseResult(parsed, 'inconclusive', hardStop ? 'hard-stop-label-present' : 'no-decision-rule-matched');
}
