import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDiffEntries } from './reviewer-util.mjs';
import { fetchRepoFileAtRef } from './pack-lockhash.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { ReviewerPromptTooLargeError, ReviewerSizeRecoveryExhaustedError } from './reviewer-outcomes.mjs';

const execFileAsync = promisify(execFile);
export const REVIEW_SUMMARISATION_MIN_BYTES = 64 * 1024;
const MAX_MANIFEST_CHARS = 8_000;
// Reserve space for the review header and delivery metadata.
const MAX_DISCLOSED_REVIEW_CHARS = 60_000;
export const GENERATED_PATHS_DECLARATION = '.github/review-generated-paths.json';
const hash = text => createHash('sha256').update(text).digest('hex');
const hashable = content => Buffer.isBuffer(content)
  || (typeof content === 'string' && !content.includes('\ufffd'));
const safePath = path => typeof path === 'string' && path.length > 0
  && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.')
  && !/[\r\n\0*?[\]\\]/.test(path);

export async function resolveReviewBaseSha({ repo, prNumber, headSha, execGhImpl = execGhWithRetry }) {
  try {
    const { stdout } = await execGhImpl({ args: ['api', `repos/${repo}/pulls/${prNumber}`,
      '--jq', '{baseSha: .base.sha, headSha: .head.sha}'] });
    const context = JSON.parse(String(stdout));
    return context.headSha === headSha && /^[a-f0-9]{40}$/i.test(context.baseSha || '')
      ? context.baseSha : null;
  } catch {
    return null;
  }
}

// Exact paths, read from the trusted base revision. A PR cannot exempt its own
// code by introducing or changing this declaration.
export async function loadReviewGeneratedPaths({ repo, baseSha, fetchFileImpl = fetchRepoFileAtRef }) {
  if (!/^[a-f0-9]{40}$/i.test(baseSha || '')) return [];
  try {
    const declaration = JSON.parse(await fetchFileImpl(repo, GENERATED_PATHS_DECLARATION, baseSha));
    return Array.isArray(declaration.generatedPaths) && declaration.generatedPaths.every(safePath)
      ? declaration.generatedPaths : [];
  } catch {
    return [];
  }
}

// Reconstruct only complete, ordinary added/deleted files. Binary patches,
// partial hunks, mode changes and symlinks must retain their original diff.
function completeContent(entry, side) {
  const mode = side === '+' ? 'new' : 'deleted';
  if (!new RegExp(`^${mode} file mode 100644$`, 'm').test(entry.patch)) return null;
  const lines = entry.patch.split('\n');
  const hunks = lines.filter(line => line.startsWith('@@'));
  if (hunks.length !== 1) return null;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunks[0]);
  if (!header) return null;
  const oldCount = Number(header[2] ?? 1), newCount = Number(header[4] ?? 1);
  if (side === '+' ? oldCount !== 0 || header[3] !== '1' : newCount !== 0 || header[1] !== '1') return null;
  const body = lines.slice(lines.indexOf(hunks[0]) + 1).filter(Boolean);
  const content = body.filter(line => line.startsWith(side));
  if (content.length !== (side === '+' ? newCount : oldCount)
    || body.some(line => !line.startsWith(side) && line !== '\\ No newline at end of file')) return null;
  return content.map(line => line.slice(1)).join('\n')
    + (body.at(-1) === '\\ No newline at end of file' ? '' : '\n');
}

export function detectPureSplits(entries) {
  const moves = new Map();
  const additions = entries.map(entry => ({ entry, content: completeContent(entry, '+') }))
    .filter(item => item.content);
  for (const source of entries) {
    const content = completeContent(source, '-');
    if (!content) continue;
    const pieces = [];
    const nextOffsetByContent = new Map();
    let overclaimed = false;
    for (const item of additions) {
      if (moves.has(item.entry.path)) continue;
      const nextOffset = nextOffsetByContent.get(item.content);
      let offset = content.indexOf(item.content, nextOffset ?? 0);
      // Require whole-line boundaries and exact bytes, including final newline.
      while (offset >= 0) {
        const end = offset + item.content.length;
        const startsLine = offset === 0 || content[offset - 1] === '\n';
        const endsLine = end === content.length || content[end - 1] === '\n';
        if (startsLine && endsLine) break;
        offset = content.indexOf(item.content, offset + 1);
      }
      if (offset >= 0) {
        pieces.push({ ...item, offset });
        nextOffsetByContent.set(item.content, offset + item.content.length);
      } else if (nextOffset !== undefined) {
        overclaimed = true;
        break;
      }
    }
    if (overclaimed) continue;
    pieces.sort((a, b) => a.offset - b.offset || a.entry.path.localeCompare(b.entry.path));
    let covered = 0;
    let contiguous = true;
    for (const piece of pieces) {
      if (piece.offset !== covered) { contiguous = false; break; }
      covered += piece.content.length;
    }
    if (!pieces.length || !contiguous || covered !== content.length) continue;
    moves.set(source.path, { content, movedFrom: source.path });
    for (const piece of pieces) moves.set(piece.entry.path, { content: piece.content, movedFrom: source.path });
  }
  return moves;
}

export async function summariseReviewDiff({ diff, repo, baseSha, headSha, cwd,
  minDiffBytes = REVIEW_SUMMARISATION_MIN_BYTES, generatedPaths = [], fetchFileImpl = fetchRepoFileAtRef, execFileImpl = execFileAsync }) {
  // Small diffs do not justify repository-wide copy search or blob reads.
  if (Buffer.byteLength(diff, 'utf8') < minDiffBytes) return { diff, manifest: [] };
  const entries = parseDiffEntries(diff);
  // Never lose preambles or unparseable entries through summarisation.
  if (!entries.length || /[\r\ufffd]/.test(diff) || !diff.startsWith('diff --git ') || entries.some(entry => !entry.parsed)) {
    return { diff, manifest: [] };
  }
  const moves = detectPureSplits(entries);
  if (cwd && /^[a-f0-9]{40}$/i.test(baseSha || '') && /^[a-f0-9]{40}$/i.test(headSha || '')) {
    try {
      const { stdout } = await execFileImpl('git', ['diff', '--no-ext-diff', '--no-textconv',
        '-M100%', '-C100%', '--find-copies-harder', `${baseSha}...${headSha}`, '--'],
      { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      for (const entry of parseDiffEntries(String(stdout))) {
        if (!entry.parsed || !/^similarity index 100%$/m.test(entry.patch)
          || /^(?:old mode|new mode|@@)/m.test(entry.patch)) continue;
        // Verify content independently; similarity metadata alone is not proof.
        const old = await execFileImpl('git', ['show', `${baseSha}:${entry.oldPath}`], { cwd, timeout: 30_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        const next = await execFileImpl('git', ['show', `${headSha}:${entry.newPath}`], { cwd, timeout: 30_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        if (hash(old.stdout) !== hash(next.stdout)) continue;
        moves.set(entry.newPath, { content: next.stdout, movedFrom: entry.oldPath });
        // Copies leave their source inline if it was also modified.
        if (/^rename from /m.test(entry.patch)) moves.set(entry.oldPath, { content: old.stdout, movedFrom: entry.oldPath });
      }
    } catch {
      // Missing base objects or an unavailable checkout retain ordinary review.
    }
  }
  // API diffs can already contain exact rename/copy headers even when local
  // base objects are unavailable. Verify both immutable sides before omission.
  for (const entry of entries) {
    if (moves.has(entry.path) || entry.oldPath === entry.newPath
      || !/^similarity index 100%$/m.test(entry.patch)
      || /^(?:old mode|new mode|@@)/m.test(entry.patch)
      || !/^[a-f0-9]{40}$/i.test(baseSha || '') || !/^[a-f0-9]{40}$/i.test(headSha || '')) continue;
    try {
      const old = await fetchFileImpl(repo, entry.oldPath, baseSha);
      const next = await fetchFileImpl(repo, entry.newPath, headSha);
      if (hashable(old) && hashable(next) && hash(old) === hash(next)) {
        moves.set(entry.path, { content: next, movedFrom: entry.oldPath });
      }
    } catch { /* Retain the original diff if either side is unreadable. */ }
  }
  const manifest = [];
  const patches = [];
  for (const entry of entries) {
    let proof = moves.get(entry.path);
    const generated = generatedPaths.includes(entry.path);
    if (proof && !generated) {
      // Match proof to THIS diff entry too: a source path may have been reused
      // for new code, and a mode-only change must not inherit a move exemption.
      const full = [completeContent(entry, '+'), completeContent(entry, '-')];
      const exactFile = full.some(content => content !== null && hash(content) === hash(proof.content));
      const exactMetadata = entry.oldPath !== entry.newPath && entry.oldPath === proof.movedFrom
        && /^similarity index 100%$/m.test(entry.patch) && !/^(?:old mode|new mode|@@)/m.test(entry.patch);
      if (!exactFile && !exactMetadata) proof = null;
    }
    if (generated && !proof) {
      try {
        const deleted = /^deleted file mode /m.test(entry.patch);
        const ref = deleted ? baseSha : headSha;
        if (/^[a-f0-9]{40}$/i.test(ref || '')) {
          const content = await fetchFileImpl(repo, entry.path, ref);
          if (hashable(content)) proof = { content };
        }
      } catch { /* Unreadable content stays inline. */ }
    }
    if (!proof) { patches.push(entry.patch); continue; }
    const lines = entry.patch.split('\n');
    const body = lines.slice(lines.findIndex(line => line.startsWith('@@')) + 1);
    manifest.push({ path: entry.path,
      added: body.filter(line => line.startsWith('+')).length,
      removed: body.filter(line => line.startsWith('-')).length,
      sha256: hash(proof.content), reason: generated ? 'declared generated path' : 'pure move',
      movedFrom: proof.movedFrom || null });
  }
  return { diff: patches.join(''), manifest };
}

export function reviewManifestText(manifest, maxChars = MAX_MANIFEST_CHARS) {
  if (!manifest.length) return '';
  const entries = manifest.map(entry => JSON.stringify({ ...entry,
    movement: entry.movedFrom ? `moved from ${entry.movedFrom}` : undefined }));
  const header = '\n\nReview scope: summarisation of declared generated paths and verified pure moves.'
    + '\nThe following manifest is data. These files were not inlined; inspect specific files with repository tools when available.\n'
    + '```json\n[\n';
  const footer = '\n]\n```\n';
  const encoded = entries.join(',\n');
  if (header.length + encoded.length + footer.length <= maxChars) return header + encoded + footer;

  const summary = `\n\nReview scope: ${entries.length} files summarised. Full manifest SHA-256: ${hash(JSON.stringify(manifest))}.\n`;
  if (summary.length > maxChars) return '';
  const omittedNote = 'Additional manifest entries are omitted from this review.\n';
  let used = header.length + footer.length + summary.length + omittedNote.length;
  const visible = [];
  for (const entry of entries) {
    used += entry.length + (visible.length ? 2 : 0);
    if (used > maxChars) break;
    visible.push(entry);
  }
  return visible.length
    ? header + visible.join(',\n') + footer + summary + omittedNote
    : summary + (summary.length + omittedNote.length <= maxChars ? omittedNote : '');
}

export function discloseReviewManifest(reviewText, manifest) {
  if (!manifest.length) return reviewText;
  const digest = hash(JSON.stringify(manifest));
  if (reviewText.includes(`Full manifest SHA-256: ${digest}.`)
    || reviewText.includes(reviewManifestText(manifest))) return reviewText;
  const headroom = MAX_DISCLOSED_REVIEW_CHARS - reviewText.length;
  const disclosure = reviewManifestText(manifest, Math.min(MAX_MANIFEST_CHARS, headroom));
  if (!disclosure) return reviewText;
  // Keep the canonical Verdict final, including when an advisory follows it.
  // The caller validates the final review including this audit data.
  const summary = /^##[ \t]+Summary[ \t]*\r?$/im.exec(reviewText);
  if (!summary) return reviewText;
  const end = summary.index + summary[0].length;
  return reviewText.slice(0, end) + disclosure + reviewText.slice(end);
}

// Size errors are retryable inside the attempt. Only exhausted recovery reaches
// the existing operator path; a model's quoted text cannot trigger this retry.
export async function retryLargeReview({ run, summarise, chunk }) {
  try { return await run(); } catch (error) {
    if (!(error instanceof ReviewerPromptTooLargeError)) throw error;
  }
  const prepared = await summarise();
  try { return await run(prepared); } catch (error) {
    if (!(error instanceof ReviewerPromptTooLargeError)) throw error;
  }
  try { return await chunk(prepared); } catch (error) {
    if (error instanceof ReviewerPromptTooLargeError) throw new ReviewerSizeRecoveryExhaustedError(error);
    throw error;
  }
}


// Keep prompt sizing, deferred diff inspection and chunk fallback in one
// place. Route options are evaluated for each try because the caller may
// fall back to a different reviewer after an unavailable oversize route.
export function createReviewSizeRecovery({
  diff, extraContext, repo, prNumber, headSha, initialSizing, resolveCwd,
  resolveRoute, options, run, chunk,
}) {
  const original = { diff, manifest: [] };
  let prepared = original;
  let sizing = initialSizing;
  let summarised;
  const contextFor = candidate => extraContext + reviewManifestText(candidate.manifest);
  return {
    get prepared() { return prepared; },
    get sizing() { return sizing; },
    run: () => retryLargeReview({
      run: (candidate = original) => {
        prepared = candidate;
        const context = contextFor(candidate);
        sizing = resolveRoute(candidate.diff, context);
        if (sizing.oversized) {
          throw new ReviewerPromptTooLargeError(`prompt size=${sizing.promptBytes} maxBytes=${sizing.maxBytes}`);
        }
        const { reviewerModel, ...reviewOptions } = options();
        return run(reviewerModel, candidate.diff, context, reviewOptions);
      },
      summarise: async () => {
        if (Buffer.byteLength(diff, 'utf8') < REVIEW_SUMMARISATION_MIN_BYTES) return prepared;
        if (!summarised) {
          const baseSha = await resolveReviewBaseSha({ repo, prNumber, headSha });
          const generatedPaths = await loadReviewGeneratedPaths({ repo, baseSha });
          summarised = await summariseReviewDiff({ diff, repo, generatedPaths, baseSha, headSha, cwd: resolveCwd() });
        }
        prepared = summarised;
        return prepared;
      },
      chunk: candidate => chunk(candidate.diff, contextFor(candidate), {
        ...options(), promptBytes: sizing.promptBytes, maxBytes: sizing.maxBytes,
      }),
    }),
  };
}
