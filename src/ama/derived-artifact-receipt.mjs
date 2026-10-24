import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, fstatSync, mkdirSync, openSync, readFileSync, closeSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { isCurrentAuthoritativeFamilyReview } from './reviewer-authority.mjs';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { loadEffectiveMergeAuthorityConfig } from './effective-policy.mjs';

const SHA = /^[0-9a-f]{40}$/;
const RECIPE = 'npm-pack-ignore-scripts-v1';
const safePath = value => typeof value === 'string' && value.length <= 512
  && value.split('/').every(part => /^[\w@.-]+$/.test(part) && !['.', '..', '.git'].includes(part.toLowerCase()));
const identityFields = ['repo', 'prNumber', 'primaryHead', 'headSha', 'mergeBase', 'path', 'primaryBlob', 'blob'];
const key = value => createHash('sha256').update(JSON.stringify(identityFields.map(field => value[field]))).digest('hex');
const directory = root => join(root, 'data', 'derived-artifact-receipts');

export function validateArtifactReceipt(receipt) {
  if (receipt?.version !== 1 || receipt.recipe !== RECIPE || !/^[\w.-]+\/[\w.-]+$/.test(receipt.repo || '')
    || !Number.isSafeInteger(receipt.prNumber) || receipt.prNumber < 1
    || !['primaryHead', 'headSha', 'mergeBase', 'primaryBlob', 'blob', 'reviewedHead'].every(field => SHA.test(receipt[field] || ''))
    || !safePath(receipt.path) || !receipt.path.endsWith('.tgz')
    || !['blocking', 'non-blocking'].includes(receipt.kind)
    || typeof receipt.review !== 'string' || !/^\S{1,256}$/.test(receipt.review)
    || !Number.isSafeInteger(receipt.finding) || receipt.finding < 1
    || typeof receipt.rationale !== 'string' || !receipt.rationale.trim() || receipt.rationale.length > 2000
    || Object.keys(receipt).some(field => ![...identityFields, 'version', 'recipe', 'reviewedHead', 'kind', 'review', 'finding', 'rationale', 'registeredAt'].includes(field))) {
    throw new Error('invalid exact-head artifact receipt');
  }
  return receipt;
}

function assertOwner(root, path) {
  if (typeof process.geteuid !== 'function') throw new Error('artifact receipt requires OS ownership');
  for (const candidate of [root, join(root, 'data'), directory(root), path].filter(Boolean)) {
    let stat;
    try { stat = lstatSync(candidate); } catch (error) {
      if (error.code === 'ENOENT' && candidate !== root) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o022)
      || (candidate === path ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('artifact receipt requires daemon-owner paths without shared writes or symlinks');
    }
  }
}

// Explicit owner registration only: no branch declaration, arbitrary command,
// status waiver, or cached success. Every gate independently rebuilds again.
export function registerArtifactReceipt(root, input) {
  const receipt = { ...validateArtifactReceipt(input), registeredAt: new Date().toISOString() };
  const path = join(directory(root), `${key(receipt)}.json`);
  assertOwner(root, path);
  mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  assertOwner(root, path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}

export async function trustedArtifactRecipe({ rootDir, repo, prNumber, get }, evidence, before, after, manifest) {
  if (!rootDir) return null;
  const binding = { repo, prNumber: Number(prNumber), primaryHead: evidence.primaryHead, headSha: evidence.headSha,
    mergeBase: evidence.mergeBase, path: after.filename, primaryBlob: before.sha, blob: after.sha };
  const path = join(directory(rootDir), `${key(binding)}.json`);
  let fd;
  try {
    assertOwner(rootDir, path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o022) || stat.size > 16384) return null;
    const receipt = validateArtifactReceipt(JSON.parse(readFileSync(fd, 'utf8')));
    if (identityFields.some(field => receipt[field] !== binding[field])) return null;
    const age = Date.now() - Date.parse(receipt.registeredAt);
    if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) return null;
    // The operator maps a retained review finding to its required package
    // rebuild. Live authoritative identity, currency and effective kind still
    // apply; the receipt cannot invent or revive a finding.
    const reviews = await get(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
    if (!Array.isArray(reviews) || reviews.length >= 100) return null;
    const review = reviews.find(entry => [entry.node_id, entry.html_url].includes(receipt.review));
    if (!review || review.commit_id !== receipt.reviewedHead) return null;
    const compare = get.metadata || get;
    if (!await isCurrentAuthoritativeFamilyReview(review, reviews, evidence.headSha,
      (from, to) => compare(`repos/${repo}/compare/${from}...${to}`))) return null;
    const verdict = normalizeEffectiveReviewVerdict(review.body);
    if (!['request-changes', 'approved', 'comment-only'].includes(verdict)) return null;
    if (receipt.kind === 'non-blocking') {
      if (loadEffectiveMergeAuthorityConfig({ rootDir })?.strictNonBlockingRemediation === false) return null;
    } else if (verdict !== 'request-changes') return null;
    const findings = receipt.kind === 'blocking' ? parseBlockingFindingsSection(review.body) : parseNonBlockingFindingsSection(review.body);
    if (!findings?.[receipt.finding - 1]?.problem) return null;
    // Fixed tool recipe; no npm run, lifecycle script, shell interpolation, or
    // branch generator. Only a manifest-local conventional npm archive qualifies.
    if (typeof manifest?.name !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/.test(manifest.name)
      || typeof manifest.version !== 'string' || !/^[\w.+-]+$/.test(manifest.version)) return null;
    const name = manifest.name.replace(/^@/, '').replace('/', '-');
    if (basename(after.filename) !== `${name}-${manifest.version}.tgz`) return null;
    return { directory: dirname(after.filename) === '.' ? '' : dirname(after.filename),
      command: 'npm pack --ignore-scripts --offline', recipe: RECIPE,
      mergeBase: evidence.mergeBase,
      receipt: key(receipt), review: receipt.review, finding: receipt.finding, kind: receipt.kind };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
