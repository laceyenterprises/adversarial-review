// ARGUSDRAIN-01 item 2 — the evidence a dependency review reads, and what
// "verified" means for a semver-major bump.
//
// The auto-adjudicator approves patch and minor bumps itself and routes every
// semver-major (and every native/security-surface package) "for review". This
// is that review's evidence, gathered deterministically before any model reads
// it:
//
//   - the PR's base and head npm manifest trees, materialised on disk exactly as
//     the ASR-05 request contract asks (`package.json` + `package-lock.json`);
//   - the deterministic ASR-05 rubric (`python3 -m argus_review review`) over
//     those trees. Its `high` findings are authoritative: they block whatever
//     the model says;
//   - the lockfile facts for the bumped package (resolved URL, integrity,
//     install script, engines) and the whole delta's install-surface movement;
//   - the repository's consumed API surface (`argus_review scan-surface`) and
//     its import sites, so breaking changes are weighed against real usage;
//   - the upstream release notes between the two versions, best effort;
//   - the head's CI result.
//
// VERIFICATION. A semver-major bump, or a deep-tier rubric result, requires
// empirical verification. The rubric's own record format (an `--ignore-scripts`
// install exercising the consumed surface) is not something the fleet produces
// yet; the PR head's green full CI suite is. The SEV names that as the
// evidence, so it is what satisfies verification here, and the result records
// that substitution explicitly (`verification.source: pr-head-full-suite`). CI
// still running defers the verdict; CI red is `needs_verification`.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';

import { summarizeChecksConclusion } from './checks-summary.mjs';
import { parseDependabotDependencyTitle } from './dependency-bot-autoadjudication.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { normalizeArgusFinding } from './argus-security-review.mjs';

const execFileAsync = promisify(execFile);

export const ARGUS_RUBRIC_PYTHONPATH_ENV = 'ADVERSARIAL_ARGUS_RUBRIC_PYTHONPATH';
export const ARGUS_RUBRIC_PYTHON_ENV = 'ADVERSARIAL_ARGUS_RUBRIC_PYTHON';
const MAX_MANIFEST_DIRS = 4;
const MAX_LIST_ITEMS = 40;
const MAX_USAGE_LINES = 60;
const MAX_RELEASE_NOTES_CHARS = 20_000;
const CI_WAIT_RETRY_MS = 10 * 60 * 1000;
// How many CI waits (at CI_WAIT_RETRY_MS each) before an unfinished suite
// stops deferring and becomes `needs_verification`: three hours.
export const ARGUS_CI_WAIT_DEFERRAL_BUDGET = 18;
const NPM_REGISTRY_PREFIX = 'https://registry.npmjs.org/';

/**
 * The bump under review: the adjudicator's parsed inputs when it routed the
 * job, else the Dependabot title. Null for anything that is not a single-package
 * bump (a grouped update, a human PR).
 */
export function resolveDependencyBump({ job, pr }) {
  const routed = job?.routedForReview;
  const inputs = routed?.inputs;
  if (inputs?.packageName && inputs.fromVersion && inputs.toVersion) {
    return {
      packageName: inputs.packageName,
      fromVersion: inputs.fromVersion,
      toVersion: inputs.toVersion,
      bumpKind: inputs.bumpKind || null,
      dependencyType: inputs.dependencyType || null,
      routedForReview: routed.reason || true,
      source: 'dependency-bot-autoadjudication',
    };
  }
  const parsed = parseDependabotDependencyTitle(pr?.title);
  if (!parsed) return null;
  return { ...parsed, routedForReview: routed ? (routed.reason || true) : null, source: 'pr-title' };
}

function changedPathsFrom({ pr, diff }) {
  if (Array.isArray(pr?.changedFiles) && pr.changedFiles.length > 0) return pr.changedFiles;
  const paths = [];
  for (const match of String(diff || '').matchAll(/^diff --git a\/.+? b\/(.+)$/gmu)) paths.push(match[1]);
  return paths;
}

/** Directories whose npm manifest or lockfile the PR changed ('' is the root). */
export function npmManifestDirs(changedPaths) {
  const dirs = new Set();
  for (const path of changedPaths || []) {
    const base = posix.basename(String(path));
    if (base !== 'package.json' && base !== 'package-lock.json') continue;
    const dir = posix.dirname(String(path));
    dirs.add(dir === '.' ? '' : dir);
  }
  return [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Where the ASR-05 rubric package lives. The deployed adversarial-review tree is
 * the agent-os `tools/adversarial-review` submodule, so the rubric is two levels
 * up; an operator can point elsewhere with ADVERSARIAL_ARGUS_RUBRIC_PYTHONPATH.
 */
export function resolveArgusRubricPythonPath({ rootDir, env = process.env, existsImpl = existsSync }) {
  const explicit = String(env?.[ARGUS_RUBRIC_PYTHONPATH_ENV] || '').trim();
  if (explicit) return existsImpl(join(explicit, 'argus_review')) ? explicit : null;
  const sibling = join(rootDir, '..', '..', 'modules', 'argus', 'lib', 'python');
  return existsImpl(join(sibling, 'argus_review')) ? sibling : null;
}

/**
 * The local checkout a repository's usage can be read from, or null. Mirrors
 * the reviewer's own cwd rule: adversarial-review is this tree, agent-os is the
 * superproject two levels up.
 */
export function resolveRepoCheckoutDir({ repo, rootDir, existsImpl = existsSync }) {
  const normalized = String(repo || '').trim().toLowerCase();
  let dir = null;
  if (normalized.endsWith('/adversarial-review')) dir = rootDir;
  else if (normalized.endsWith('/agent-os')) dir = join(rootDir, '..', '..');
  return dir && existsImpl(join(dir, '.git')) ? dir : null;
}

function lockPackages(lock) {
  return lock && typeof lock.packages === 'object' && lock.packages ? lock.packages : {};
}

function packageNameFromLockPath(path) {
  const index = path.lastIndexOf('node_modules/');
  return index < 0 ? path : path.slice(index + 'node_modules/'.length);
}

function describeLockEntry(entry) {
  if (!entry) return 'absent';
  const parts = [`version ${entry.version || '?'}`];
  parts.push(entry.resolved ? `resolved ${entry.resolved}` : 'no resolved URL');
  parts.push(entry.integrity ? 'integrity present' : 'NO integrity');
  if (entry.hasInstallScript) parts.push('hasInstallScript');
  if (entry.engines) parts.push(`engines ${JSON.stringify(entry.engines)}`);
  if (entry.license) parts.push(`license ${entry.license}`);
  if (entry.dev) parts.push('dev');
  if (entry.optional) parts.push('optional');
  return parts.join('; ');
}

/**
 * The lockfile delta, as facts. Delta-scoped: only incoming entries (added, or
 * changed in place) are checked for provenance, and an install script counts
 * only when this PR adds it.
 */
export function summarizeLockfileDelta({ baseLock, headLock, packageName = null }) {
  const base = lockPackages(baseLock);
  const head = lockPackages(headLock);
  const added = [];
  const removed = [];
  const changed = [];
  const installScriptsAdded = [];
  const installScriptsRemoved = [];
  const nonRegistryIncoming = [];
  const missingIntegrityIncoming = [];
  for (const [path, entry] of Object.entries(head)) {
    if (!path || entry?.link) continue;
    const prior = base[path];
    if (!prior) added.push(path);
    else if (prior.version !== entry.version || prior.resolved !== entry.resolved) changed.push(path);
    else continue;
    const name = packageNameFromLockPath(path);
    if (entry.hasInstallScript && !prior?.hasInstallScript) installScriptsAdded.push(name);
    if (entry.resolved && !String(entry.resolved).startsWith(NPM_REGISTRY_PREFIX)) nonRegistryIncoming.push(`${name} → ${entry.resolved}`);
    if (!entry.integrity) missingIntegrityIncoming.push(name);
  }
  for (const [path, entry] of Object.entries(base)) {
    if (!path || entry?.link || head[path]) continue;
    removed.push(path);
    if (entry.hasInstallScript) installScriptsRemoved.push(packageNameFromLockPath(path));
  }
  for (const path of changed) {
    if (base[path]?.hasInstallScript && !head[path]?.hasInstallScript) installScriptsRemoved.push(packageNameFromLockPath(path));
  }
  const target = packageName ? `node_modules/${packageName}` : null;
  return {
    package: target ? { base: base[target] || null, head: head[target] || null } : null,
    added: added.map(packageNameFromLockPath),
    removed: removed.map(packageNameFromLockPath),
    changed: changed.map(packageNameFromLockPath),
    installScriptsAdded,
    installScriptsRemoved,
    nonRegistryIncoming,
    missingIntegrityIncoming,
  };
}

function list(items) {
  if (!items || items.length === 0) return 'none';
  const shown = items.slice(0, MAX_LIST_ITEMS).join(', ');
  return items.length > MAX_LIST_ITEMS ? `${shown} … (+${items.length - MAX_LIST_ITEMS} more)` : shown;
}

function renderLockDelta(dir, delta, packageName) {
  const lines = [`Manifest directory: \`${dir || '.'}\``];
  if (delta.package) {
    lines.push(`- ${packageName} at base: ${describeLockEntry(delta.package.base)}`);
    lines.push(`- ${packageName} at head: ${describeLockEntry(delta.package.head)}`);
  }
  lines.push(
    `- Packages added (${delta.added.length}): ${list(delta.added)}`,
    `- Packages removed (${delta.removed.length}): ${list(delta.removed)}`,
    `- Packages changed in place (${delta.changed.length}): ${list(delta.changed)}`,
    `- Install scripts ADDED by this PR: ${list(delta.installScriptsAdded)}`,
    `- Install scripts removed by this PR: ${list(delta.installScriptsRemoved)}`,
    `- Incoming entries resolved outside ${NPM_REGISTRY_PREFIX}: ${list(delta.nonRegistryIncoming)}`,
    `- Incoming entries with no integrity: ${list(delta.missingIntegrityIncoming)}`,
  );
  return lines.join('\n');
}

function renderRubric(entry) {
  const doc = entry.doc || {};
  const lines = [
    `Manifest directory: \`${entry.dir || '.'}\` — verdict **${doc.verdict || 'unknown'}** (exit ${entry.exitCode}), `
      + `tier ${doc.depth?.tier || '?'}, risk ${doc.riskDirection || '?'}.`,
  ];
  if (doc.summary) lines.push(String(doc.summary).slice(0, 800));
  for (const finding of doc.findings || []) {
    lines.push(`- [${finding.severity}] ${finding.category}: ${finding.title}`);
  }
  for (const axis of (doc.axes || []).slice(0, 8)) {
    const notes = (axis.notes || []).slice(0, 3).join(' / ');
    lines.push(`- axis ${axis.axis}: ${axis.status}${notes ? ` — ${notes.slice(0, 400)}` : ''}`);
  }
  return lines.join('\n');
}

function parseJsonOrNull(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Gather the evidence for one job. Never throws: every source that could not be
 * read says so in its section, because an absent check must not read as a
 * passed one. The one exception is `fatal`: a rubric that ran and crashed is a
 * reviewer error, and the review is retried rather than decided without it.
 */
export async function gatherArgusEvidence({
  job,
  pr,
  diff,
  workDir,
  rootDir,
  io,
  env = process.env,
  logger = console,
}) {
  const sections = [];
  const rubricFindings = [];
  const rubricResults = [];
  const dependency = resolveDependencyBump({ job, pr });
  const pythonPath = resolveArgusRubricPythonPath({ rootDir, env, existsImpl: io.existsImpl || existsSync });
  const checkoutDir = resolveRepoCheckoutDir({ repo: job.repo, rootDir, existsImpl: io.existsImpl || existsSync });
  let fatal = null;

  if (dependency) {
    sections.push({
      title: 'Dependency bump',
      body: [
        `- Package: \`${dependency.packageName}\``,
        `- From ${dependency.fromVersion} to ${dependency.toVersion} (${dependency.bumpKind || 'unknown distance'}, ${dependency.dependencyType || 'unknown'} dependency)`,
        dependency.routedForReview
          ? `- Routed for review by the dependency-bot auto-adjudicator: ${dependency.routedForReview}`
          : '- Not routed by the auto-adjudicator',
        '',
        'For this bump, check: the breaking changes between the two versions, whether this repository\'s usage '
          + 'touches them, install scripts or native binaries in the new version, and the CI result below.',
      ].join('\n'),
    });
  }

  let consumedSurface = null;
  if (dependency && checkoutDir && pythonPath) {
    try {
      consumedSurface = await io.scanSurface({ treeDir: checkoutDir, packageName: dependency.packageName, pythonPath });
    } catch (err) {
      logger?.warn?.(`[argus-evidence] scan-surface failed: ${err?.message || err}`);
    }
  }
  if (dependency) {
    let usage = null;
    if (checkoutDir) {
      try {
        usage = await io.grepUsage({ checkoutDir, packageName: dependency.packageName });
      } catch (err) {
        usage = `not obtained: ${err?.message || err}`;
      }
    }
    sections.push({
      title: 'This repository\'s usage of the package',
      body: [
        consumedSurface
          ? `Consumed surface (argus_review scan-surface, approximate): members ${list(consumedSurface.members || [])}; `
            + `files scanned ${consumedSurface.filesScanned ?? '?'}.`
          : 'Consumed surface: not obtained (no local checkout or rubric package).',
        usage ? `Import and require sites (base checkout):\n${usage}` : 'Import sites: not obtained (no local checkout for this repository).',
      ].join('\n\n'),
    });
  }

  const dirs = npmManifestDirs(changedPathsFrom({ pr, diff })).slice(0, MAX_MANIFEST_DIRS);
  for (const [index, dir] of dirs.entries()) {
    const read = async (ref, name) => {
      try {
        return await io.fetchFileAtRef({ repo: job.repo, path: dir ? `${dir}/${name}` : name, ref });
      } catch (err) {
        logger?.warn?.(`[argus-evidence] ${name}@${String(ref).slice(0, 12)} unreadable: ${err?.message || err}`);
        return null;
      }
    };
    const files = {
      base: { manifest: await read(pr.baseSha, 'package.json'), lock: await read(pr.baseSha, 'package-lock.json') },
      head: { manifest: await read(job.headSha, 'package.json'), lock: await read(job.headSha, 'package-lock.json') },
    };
    const treeRoot = join(workDir, 'trees', String(index));
    for (const side of ['base', 'head']) {
      mkdirSync(join(treeRoot, side), { recursive: true });
      if (files[side].manifest !== null) writeFileSync(join(treeRoot, side, 'package.json'), files[side].manifest);
      if (files[side].lock !== null) writeFileSync(join(treeRoot, side, 'package-lock.json'), files[side].lock);
    }
    const baseLock = parseJsonOrNull(files.base.lock);
    const headLock = parseJsonOrNull(files.head.lock);
    if (headLock) {
      sections.push({
        title: `Lockfile facts (${dir || 'repository root'})`,
        body: renderLockDelta(dir, summarizeLockfileDelta({ baseLock, headLock, packageName: dependency?.packageName }), dependency?.packageName),
      });
    }

    const complete = ['base', 'head'].every((side) => files[side].manifest !== null && files[side].lock !== null);
    if (!pythonPath || !complete) {
      rubricResults.push({ dir, status: pythonPath ? 'skipped-incomplete-trees' : 'unavailable' });
      continue;
    }
    const request = {
      repo: job.repo,
      prNumber: job.prNumber,
      title: pr.title || '',
      author: pr.author || '',
      baseSha: pr.baseSha || '',
      headSha: job.headSha,
      baseTree: 'base',
      headTree: 'head',
      triggerReasons: (job.reasons || []).map((reason) => reason?.trigger).filter(Boolean),
      changedPaths: changedPathsFrom({ pr, diff }).filter((path) => (dir ? path.startsWith(`${dir}/`) : !path.includes('/'))),
      runtime: { runtime: 'node', version: process.versions.node, source: 'watcher host (Argus review child process.versions.node)' },
      ...(consumedSurface && dependency ? { consumedSurface: { [dependency.packageName]: consumedSurface } } : {}),
    };
    const requestPath = join(treeRoot, 'request.json');
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    try {
      const { exitCode, doc } = await io.runRubric({ requestPath, pythonPath });
      rubricResults.push({ dir, status: 'ran', exitCode, verdict: doc?.verdict || null, tier: doc?.depth?.tier || null, riskDirection: doc?.riskDirection || null });
      for (const finding of doc?.findings || []) {
        rubricFindings.push(normalizeArgusFinding(
          { ...finding, path: dir ? `${dir}/package-lock.json` : 'package-lock.json' },
          { source: 'argus-rubric' },
        ));
      }
      sections.push({ title: `Deterministic ASR-05 rubric (${dir || 'repository root'})`, body: renderRubric({ dir, exitCode, doc }) });
    } catch (err) {
      fatal = `ASR-05 rubric failed for ${dir || '.'}: ${err?.message || err}`;
      rubricResults.push({ dir, status: 'error', error: String(err?.message || err).slice(0, 500) });
    }
  }

  if (dependency) {
    let notes = null;
    try {
      notes = await io.fetchReleaseNotes({ packageName: dependency.packageName, fromVersion: dependency.fromVersion, toVersion: dependency.toVersion });
    } catch (err) {
      notes = null;
      logger?.warn?.(`[argus-evidence] release notes unavailable: ${err?.message || err}`);
    }
    sections.push({
      title: `Upstream release notes (${dependency.fromVersion} → ${dependency.toVersion})`,
      body: notes
        ? String(notes).slice(0, MAX_RELEASE_NOTES_CHARS)
        : 'Not obtained. Say which breaking changes you could not confirm rather than assuming there are none.',
    });
  }

  const ci = io.summarizeChecks(pr.statusCheckRollup);
  sections.push({
    title: 'CI on this head',
    body: `External CI conclusion for ${job.headSha.slice(0, 12)}: ${ci || 'no checks reported'}.`,
  });

  return {
    sections,
    rubricFindings,
    rubric: rubricResults.length > 0 ? { pythonPath: pythonPath ? 'resolved' : null, results: rubricResults } : null,
    dependency,
    fatal,
  };
}

/**
 * Is verification required for this job, and is it satisfied?
 *
 * Required for a dependency bump the auto-adjudicator routed for review, for a
 * semver-major bump, and whenever the deterministic rubric reported
 * `needs_verification` (its deep tier). Satisfied only by a green external CI
 * suite on the exact head under review.
 */
export function assessArgusVerification({ job, pr, cached, summarizeChecks = summarizeChecksConclusion }) {
  const dependency = cached?.dependency || null;
  const rubricNeeds = (cached?.rubric?.results || []).some((entry) => entry.verdict === 'needs_verification');
  const required = Boolean(dependency?.routedForReview || dependency?.bumpKind === 'major' || rubricNeeds);
  if (!required) return { required: false, satisfied: true };
  const head = String(job.headSha).slice(0, 12);
  const ci = summarizeChecks(pr?.statusCheckRollup);
  if (ci === 'SUCCESS') {
    return {
      required: true,
      satisfied: true,
      source: 'pr-head-full-suite',
      detail: `the full external CI suite is green on ${head}; it installs the proposed version and exercises this repository's use of it`,
    };
  }
  if (ci === null || ci === 'PENDING') {
    if ((job?.drain?.deferrals || 0) < ARGUS_CI_WAIT_DEFERRAL_BUDGET) {
      return { required: true, defer: true, reason: 'ci-pending', retryAfterMs: CI_WAIT_RETRY_MS };
    }
    return {
      required: true,
      satisfied: false,
      source: 'pr-head-full-suite',
      detail: `the external CI suite never finished green on ${head} (${ci || 'no checks reported'})`,
    };
  }
  return { required: true, satisfied: false, source: 'pr-head-full-suite', detail: `the external CI suite is ${ci} on ${head}` };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compareSemver(left, right) {
  const parse = (value) => String(value || '').replace(/^v/u, '').split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Production I/O for `gatherArgusEvidence`. */
export function createDefaultArgusEvidenceIo({
  env = process.env,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
} = {}) {
  const python = String(env?.[ARGUS_RUBRIC_PYTHON_ENV] || '').trim() || 'python3';
  const runPython = async (args, { pythonPath, timeoutMs = 120_000 }) => execFileImpl(python, args, {
    env: { ...env, PYTHONPATH: pythonPath },
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
  });
  return {
    async fetchFileAtRef({ repo, path, ref }) {
      const encoded = String(path).split('/').map(encodeURIComponent).join('/');
      try {
        const { stdout } = await execGhWithRetryImpl({
          args: ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${encoded}?ref=${ref}`],
          env,
          timeoutMs: 60_000,
          log: logger,
        });
        return String(stdout ?? '');
      } catch (err) {
        if (/\b404\b|Not Found/iu.test(`${err?.message || ''} ${err?.stderr || ''}`)) return null;
        throw err;
      }
    },
    async runRubric({ requestPath, pythonPath }) {
      try {
        const { stdout } = await runPython(['-m', 'argus_review', 'review', requestPath, '--format', 'json'], { pythonPath });
        return { exitCode: 0, doc: JSON.parse(stdout) };
      } catch (err) {
        // Exit 2 (needs verification) and 3 (block) are verdicts, not errors.
        if ((err?.code === 2 || err?.code === 3) && err?.stdout) return { exitCode: err.code, doc: JSON.parse(err.stdout) };
        throw err;
      }
    },
    async scanSurface({ treeDir, packageName, pythonPath }) {
      const { stdout } = await runPython(['-m', 'argus_review', 'scan-surface', treeDir, packageName], { pythonPath, timeoutMs: 180_000 });
      return JSON.parse(stdout);
    },
    async grepUsage({ checkoutDir, packageName }) {
      const pattern = `['"\`]${escapeRegExp(packageName)}(/[^'"\`]*)?['"\`]`;
      try {
        const { stdout } = await execFileImpl('git', [
          '-C', checkoutDir, 'grep', '-n', '-I', '-E', pattern, '--',
          ':!*package-lock.json', ':!*package.json', ':!*.lock', ':!*.md',
        ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
        const lines = String(stdout).split('\n').filter(Boolean);
        return lines.length > MAX_USAGE_LINES
          ? `${lines.slice(0, MAX_USAGE_LINES).join('\n')}\n… (+${lines.length - MAX_USAGE_LINES} more)`
          : lines.join('\n');
      } catch (err) {
        if (err?.code === 1) return 'no import or require sites found';
        throw err;
      }
    },
    async fetchReleaseNotes({ packageName, fromVersion, toVersion }) {
      const { stdout: repoUrl } = await execFileImpl('npm', ['view', packageName, 'repository.url'], {
        timeout: 60_000, encoding: 'utf8', env,
      });
      const match = String(repoUrl).match(/github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[#\s]|$)/u);
      if (!match) return null;
      const { stdout } = await execGhWithRetryImpl({
        args: ['api', `repos/${match[1]}/${match[2]}/releases?per_page=100`],
        env,
        timeoutMs: 60_000,
        log: logger,
      });
      const releases = JSON.parse(String(stdout || '[]'));
      const between = releases
        .map((release) => ({ release, version: String(release?.tag_name || '').replace(/^[^0-9]*/u, '') }))
        .filter(({ version }) => version && compareSemver(version, fromVersion) > 0 && compareSemver(version, toVersion) <= 0)
        .sort((a, b) => compareSemver(a.version, b.version));
      if (between.length === 0) return null;
      return between.map(({ release }) => `#### ${release.tag_name}\n${String(release.body || '').trim()}`).join('\n\n');
    },
    summarizeChecks: (rollup) => summarizeChecksConclusion(rollup, { env }),
  };
}
