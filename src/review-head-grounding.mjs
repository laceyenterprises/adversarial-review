// REVIEWCHUNK-01: ground blocking findings in the PR head before posting.
//
// A chunked review of agent-os PR 7981 blocked on two parser findings that
// quoted `normalized_heading in normalized_targets` and
// `end = matches[index + 1].start()`. Neither line existed at the reviewed
// head; both were on the removed side of the diff. The verdict went out as
// Request changes with the remediation budget already spent.
//
// This pass checks every blocking card that quotes code (inline backtick spans
// in its Problem paragraph) or cites line numbers against the cited file's
// content AT HEAD. A card is demoted to Non-blocking, tagged "unverified at
// head (quoted code absent)", only when:
//   - it carries at least one code-like quote, every one of those quotes is
//     absent from every cited file at head, and every cited file's head content
//     was determinable; or
//   - it carries no code-like quote, cites plain line numbers, and every cited
//     line is past the end of the head file.
// Any quote present at head keeps the card blocking. Any fetch failure, an
// unparseable card, or an unexpected error keeps the card blocking. The pass
// never adds a finding or a gate; it can only move a card from Blocking to
// Non-blocking and, when no blocking card remains, the Verdict from
// Request changes to Comment only.

import { fetchRepoFileAtRef } from './pack-lockhash.mjs';
import { beginReviewerPass } from './reviewer-pass-tokens.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';
import { normalizeReviewVerdict } from './kernel/verdict.mjs';

const HEAD_GROUNDING_TAG = 'unverified at head (quoted code absent)';
const DEFAULT_MAX_HEAD_FILES = 25;
const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_PART_CHARS = 4;

function stripWhitespace(text) {
  return String(text || '').replace(/\s+/g, '');
}

function isNoneLine(line) {
  return /^\s*[-*+]?\s*(?:none|n\/a)\.?\s*$/i.test(line);
}

function splitSections(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [{ heading: null, lines: [] }];
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    if (!fence && /^##\s+\S/.test(line) && !/^###/.test(line)) {
      sections.push({ heading: line, lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

function joinSections(sections) {
  return sections
    .flatMap((section) => (section.heading == null ? section.lines : [section.heading, ...section.lines]))
    .join('\n');
}

function findSection(sections, pattern) {
  return sections.findIndex((section) => pattern.test(section.heading || ''));
}

// Split a section body into a preamble and cards. H3 cards (`### Title`) use
// unindented `- **File:**` sub-bullets, so when any H3 is present only H3
// lines start a card; otherwise every unindented bullet does.
function splitCards(lines) {
  const useH3 = lines.some((line) => /^###\s+\S/.test(line));
  const isBoundary = useH3 ? (line) => /^###\s+\S/.test(line) : (line) => /^[-*+]\s+/.test(line);
  const preamble = [];
  const cards = [];
  for (const line of lines) {
    if (isBoundary(line)) {
      cards.push([line]);
    } else if (cards.length > 0) {
      cards[cards.length - 1].push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, cards: cards.map((cardLines) => trimTrailingBlank(cardLines)) };
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function fieldValue(cardLines, label) {
  const pattern = new RegExp(`^\\s*(?:[-*+]\\s+)?\\*\\*${label}(?::\\*\\*|\\*\\*\\s*:)\\s*(.*)$`, 'i');
  for (const line of cardLines) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function cardTitle(cardLines) {
  const first = String(cardLines[0] || '');
  const bold = first.match(/^\s*(?:[-*+]\s+|###\s+)\*\*(.+?)\*\*/);
  if (bold) return bold[1].trim();
  return first.replace(/^\s*(?:[-*+]|###)\s+/, '').trim();
}

function backtickSpans(text) {
  return [...String(text || '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

function looksLikePath(span) {
  return /^[\w.@~-]+(?:\/[\w.@~-]+)+(?::[\d,–-]+)?$/.test(span) || /^[\w-]+\.[a-z]{1,5}(?::[\d,–-]+)?$/i.test(span);
}

// A quote is code-like enough to ground only when it is long enough to be
// distinctive and carries code punctuation or whitespace. Bare identifiers,
// paths and short tokens are mentions, not quotes, and never trigger a demotion.
function normalizeQuote(span) {
  let quote = String(span || '').trim();
  quote = quote.replace(/^[-+]\s?(?:\[REMOVED\]\s?)?/, '').replace(/^\[REMOVED\]\s?/, '').trim();
  if (quote.length < MIN_QUOTE_CHARS || looksLikePath(quote)) return null;
  if (!/[\s()[\]{}=<>!&|+*/%,;:"'.-]/.test(quote)) return null;
  const parts = quote.split(/\.\.\.|…/).map((part) => stripWhitespace(part)).filter((part) => part.length >= MIN_QUOTE_PART_CHARS);
  return parts.length > 0 ? { text: quote, parts } : null;
}

function cardQuotes(cardLines) {
  const problem = fieldValue(cardLines, 'Problem');
  const source = problem != null
    ? problem
    : cardLines
      .filter((line) => !/\*\*(?:File|Lines|Recommended fix|Why it matters)(?::\*\*|\*\*\s*:)/i.test(line))
      .join('\n');
  return backtickSpans(source).map(normalizeQuote).filter(Boolean);
}

function cardFiles(cardLines, diffFiles) {
  const files = new Set();
  const fileValue = fieldValue(cardLines, 'File');
  if (fileValue) {
    for (const raw of fileValue.replace(/`/g, '').split(/,|\s+and\s+/)) {
      const candidate = raw.trim().replace(/:\d[\d,–-]*.*$/, '').replace(/\s+\(.*\)$/, '').trim();
      if (candidate && !/\s/.test(candidate)) files.add(candidate);
    }
  }
  const cardText = cardLines.join('\n');
  for (const file of diffFiles.values()) {
    if (file.path && cardText.includes(file.path)) files.add(file.path);
  }
  return [...files];
}

function citedLineNumbers(cardLines) {
  const value = String(fieldValue(cardLines, 'Lines') || '').replace(/`/g, '').trim();
  if (!value || !/^[\sLl\d,–—-]+$/.test(value)) return [];
  return [...value.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((line) => line > 0);
}

function indexDiff(diff) {
  const files = new Map();
  for (const file of parseDiffFiles(diff)) {
    if (!file.path) continue;
    const removed = [];
    let inHunk = false;
    for (const line of String(file.patch || '').split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('-')) removed.push(line.slice(1));
    }
    files.set(file.path, {
      path: file.path,
      deleted: /^deleted file mode /m.test(file.patch || ''),
      removedText: stripWhitespace(removed.join('\n')),
    });
  }
  return files;
}

function quotePresent(quote, compactContent) {
  return quote.parts.every((part) => compactContent.includes(part));
}

function isMissingFileError(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  return /\bHTTP\s+404\b/i.test(text) || /\bnot found\b/i.test(text);
}

function demotedCard(cardLines, reason, headSha) {
  const [first, ...rest] = cardLines;
  const title = cardTitle(cardLines);
  const header = /^\s*###\s+/.test(first)
    ? `### ${title} — ${HEAD_GROUNDING_TAG}`
    : `- **${title} — ${HEAD_GROUNDING_TAG}**`;
  const detail = reason === 'removed-side'
    ? 'the quoted code appears only on the removed side of the diff'
    : reason === 'lines-beyond-head'
      ? 'every cited line is past the end of the file at head'
      : 'the quoted code is not present in the cited file at head';
  const indent = /^\s*###\s+/.test(first) ? '' : '  ';
  return [
    header,
    ...rest,
    `${indent}- **Head grounding:** ${HEAD_GROUNDING_TAG} — ${detail} (head ${String(headSha).slice(0, 12)}); demoted from blocking.`,
  ];
}

function insertNonBlocking(sections, cards) {
  const entries = cards.flatMap((lines) => lines);
  let index = findSection(sections, /^##\s+Non-blocking issues\b/i);
  if (index < 0) {
    const blockingIndex = findSection(sections, /^##\s+Blocking issues\b/i);
    sections.splice(blockingIndex + 1, 0, { heading: '## Non-blocking issues', lines: [''] });
    index = blockingIndex + 1;
  }
  const kept = trimTrailingBlank(sections[index].lines.filter((line) => !isNoneLine(line)));
  const lead = kept.length === 0 || kept[0].trim() !== '' ? [''] : [];
  sections[index].lines = [...lead, ...kept, ...entries, ''];
}

function rewriteVerdictToCommentOnly(sections) {
  const index = findSection(sections, /^##\s+Verdict\b/i);
  if (index < 0) return false;
  const lines = sections[index].lines;
  if (!lines.some((line) => normalizeReviewVerdict(line.trim()) === 'request-changes')) return false;
  sections[index].lines = lines.map((line) => (
    normalizeReviewVerdict(line.trim()) === 'request-changes' ? 'Comment only' : line
  ));
  return true;
}

async function groundBlockingFindingsAtHead(reviewText, {
  repo,
  headSha,
  diff = '',
  fetchFileAtRefImpl = fetchRepoFileAtRef,
  maxFiles = DEFAULT_MAX_HEAD_FILES,
  log = console,
} = {}) {
  const grounding = { headSha: headSha || null, checked: 0, kept: 0, demoted: [] };
  const original = String(reviewText ?? '');
  if (!repo || !String(headSha || '').trim() || !original) {
    return { reviewText: original, grounding: { ...grounding, skipped: 'missing-input' } };
  }
  try {
    const sections = splitSections(original);
    const blockingIndex = findSection(sections, /^##\s+Blocking issues\b/i);
    if (blockingIndex < 0) return { reviewText: original, grounding };
    const { preamble, cards } = splitCards(sections[blockingIndex].lines);
    if (cards.length === 0) return { reviewText: original, grounding };

    const diffFiles = indexDiff(diff);
    const contentCache = new Map();
    const headContent = (path) => {
      if (!contentCache.has(path)) {
        if (contentCache.size >= maxFiles) return Promise.resolve({ ok: false, reason: 'file-budget' });
        contentCache.set(path, fetchFileAtRefImpl(repo, path, headSha).then(
          (content) => ({ ok: true, content: String(content ?? '') }),
          (err) => (isMissingFileError(err) && diffFiles.get(path)?.deleted
            ? { ok: true, content: '' }
            : { ok: false, reason: isMissingFileError(err) ? 'missing-at-head' : 'fetch-failed' }),
        ));
      }
      return contentCache.get(path);
    };

    const keptCards = [];
    const demotedCards = [];
    for (const card of cards) {
      const quotes = cardQuotes(card);
      const lineNumbers = citedLineNumbers(card);
      const files = cardFiles(card, diffFiles);
      if ((quotes.length === 0 && lineNumbers.length === 0) || files.length === 0) {
        keptCards.push(card);
        continue;
      }
      grounding.checked += 1;
      const contents = await Promise.all(files.map(headContent));
      if (contents.some((entry) => !entry.ok)) {
        grounding.kept += 1;
        keptCards.push(card);
        continue;
      }
      let reason = null;
      if (quotes.length > 0) {
        const compact = contents.map((entry) => stripWhitespace(entry.content));
        const anyPresent = quotes.some((quote) => compact.some((content) => quotePresent(quote, content)));
        if (!anyPresent) {
          const removedSide = quotes.some((quote) => files.some((path) => {
            const removed = diffFiles.get(path)?.removedText || '';
            return removed && quotePresent(quote, removed);
          }));
          reason = removedSide ? 'removed-side' : 'absent';
        }
      } else if (files.length === 1) {
        const lineCount = contents[0].content.replace(/\n$/, '').split('\n').length;
        if (lineNumbers.every((line) => line > lineCount)) reason = 'lines-beyond-head';
      }
      if (!reason) {
        grounding.kept += 1;
        keptCards.push(card);
        continue;
      }
      grounding.demoted.push({
        title: cardTitle(card),
        files,
        reason,
        quotes: quotes.map((quote) => quote.text),
        ...(lineNumbers.length > 0 ? { lines: lineNumbers } : {}),
      });
      demotedCards.push(demotedCard(card, reason, headSha));
    }

    if (demotedCards.length === 0) return { reviewText: original, grounding };

    const lead = preamble.filter((line) => !isNoneLine(line));
    const body = keptCards.length > 0
      ? keptCards.flatMap((card) => card)
      : ['- None.'];
    const leadTrimmed = trimTrailingBlank(lead);
    sections[blockingIndex].lines = [...(leadTrimmed.length > 0 ? leadTrimmed : ['']), ...body, ''];
    insertNonBlocking(sections, demotedCards);
    if (keptCards.length === 0) grounding.verdictRewritten = rewriteVerdictToCommentOnly(sections);
    log?.warn?.(
      `[reviewer] head-grounding repo=${repo} head=${headSha} demoted=${demotedCards.length} ` +
        `kept_blocking=${keptCards.length} reasons=${grounding.demoted.map((entry) => entry.reason).join(',')}`
    );
    return { reviewText: joinSections(sections), grounding };
  } catch (err) {
    log?.warn?.(`[reviewer] WARN: head grounding failed for ${repo}@${headSha}; posting review unchanged: ${err?.message || err}`);
    return { reviewText: original, grounding: { ...grounding, demoted: [], error: String(err?.message || err) } };
  }
}

// Review metadata for the running pass: the head-grounding outcome and, when
// the PR diff and the PR's own diff disagree, both file counts. Best-effort.
function persistReviewGroundingMetadata({
  rootDir, repo, prNumber, reviewDbAttemptNumber, reviewAttemptNumber,
  reviewerClass, passKind, headSha, execution = null, headGrounding = null, reviewDiffScope = null,
  beginReviewerPassImpl = beginReviewerPass, log = console,
}) {
  const metadata = {};
  if (headGrounding && (headGrounding.checked > 0 || headGrounding.error)) metadata.headGrounding = headGrounding;
  if (reviewDiffScope && Number.isFinite(reviewDiffScope.ownDiffFileCount)
    && reviewDiffScope.ownDiffFileCount !== reviewDiffScope.prDiffFileCount) {
    metadata.reviewDiffScope = reviewDiffScope;
  }
  if (Object.keys(metadata).length === 0) return false;
  try {
    beginReviewerPassImpl(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number.isFinite(Number(reviewDbAttemptNumber))
        ? Number(reviewDbAttemptNumber)
        : Number(reviewAttemptNumber),
      reviewerClass,
      reviewerModel: execution?.model || null,
      reasoningEffort: execution?.effort || null,
      passKind,
      headSha: headSha || null,
      metadata,
    });
    return true;
  } catch (err) {
    log?.warn?.(`[reviewer] review grounding metadata write failed for ${repo}#${prNumber}: ${err?.message || err}`);
    return false;
  }
}

export {
  HEAD_GROUNDING_TAG,
  groundBlockingFindingsAtHead,
  persistReviewGroundingMetadata,
};
