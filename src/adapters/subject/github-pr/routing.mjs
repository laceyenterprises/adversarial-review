/**
 * Reviewer routing for GitHub PR subjects.
 *
 * Routing accepts the adapter-normalized builderClass from
 * {@link ../../../kernel/contracts.d.ts SubjectState}; title-prefix parsing
 * is intentionally kept in the adapter layer.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 */

import { builderClassFromTitle, tagFromBuilderClass } from './title-tagging.mjs';
import { resolveDefaultReviewer as resolveDefaultReviewerFromConfig } from '../../../role-config.mjs';
import { loadConfigCached } from '../../../config-loader.mjs';

const ROUTE_BY_BUILDER_CLASS = {
  codex: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  'claude-code': {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  'clio-agent': {
    // Clio dispatches codex workers; per cross-model review, the reviewer
    // is the OPPOSITE model from the writer — so clio-agent PRs go to
    // claude, not codex. (Today's value used to be 'codex', which was a
    // same-model assignment masquerading as cross-model.)
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  pi: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  hermes: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
};

const DEFAULT_REVIEWER_ENV = 'ADVERSARIAL_REVIEW_DEFAULT_REVIEWER';

const REVIEWER_ROUTE_BY_MODEL = {
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  pi: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  hermes: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
};

// Map each builder tag to the *writer* model it represents. Used by
// `isCrossModelReviewWaived` to detect when an env-pinned reviewer matches
// the writer (same-model = cross-model review guarantee waived).
// clio-agent's writer is codex (Clio dispatches codex workers), so its
// family is codex, not claude.
const REVIEWER_FAMILY_BY_BUILDER_CLASS = {
  codex: 'codex',
  'claude-code': 'claude',
  'clio-agent': 'codex',
  gemini: 'gemini',
  pi: 'pi',
  hermes: 'hermes',
};

function normalizeBuilderClass(builderClassInput) {
  const builderClass = String(builderClassInput || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUTE_BY_BUILDER_CLASS, builderClass)
    ? builderClass
    : null;
}

function normalizeReviewerModel(reviewerInput) {
  const reviewer = String(reviewerInput || '').trim().toLowerCase();
  if (!reviewer) return null;
  switch (reviewer) {
    case 'claude':
    case 'claude-code':
      return 'claude';
    case 'codex':
    case 'gemini':
    case 'pi':
    case 'hermes':
      return reviewer;
    default:
      return null;
  }
}

// Cascade-aware reviewer route resolver. Consults config.yaml FIRST
// (module → top → *.local) and env LAST per SPEC §3. Returns null when
// no pin is in effect (the per-tag cross-model routing in
// ROUTE_BY_BUILDER_CLASS then applies).
//
// `defaultReviewerRouteFromEnv` is preserved as the public name; the body
// delegates to the file-cascade resolver. `routeSubject` and the watcher's
// boot validator both consume this without changes.
function defaultReviewerRouteFromEnv(env = process.env, opts = {}) {
  return resolveDefaultReviewerFromConfig({
    env,
    reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
    ...opts,
  });
}

function validateDefaultReviewerRouteConfig(env = process.env, opts = {}) {
  defaultReviewerRouteFromEnv(env, opts);
}

function isCrossModelReviewWaived(builderClassInput, reviewerInput) {
  const builderClass = normalizeBuilderClass(builderClassInput);
  const reviewerModel = normalizeReviewerModel(reviewerInput);
  if (!builderClass || !reviewerModel) return false;
  return REVIEWER_FAMILY_BY_BUILDER_CLASS[builderClass] === reviewerModel;
}

function describeCrossModelReviewWaiver(builderClassInput, reviewerInput, env = process.env) {
  if (!isCrossModelReviewWaived(builderClassInput, reviewerInput)) {
    return null;
  }
  const configuredValue = env?.[DEFAULT_REVIEWER_ENV];
  const normalizedValue = normalizeReviewerModel(configuredValue);
  const renderedValue = configuredValue === undefined
    ? '(unset)'
    : JSON.stringify(String(configuredValue));
  return (
    `${DEFAULT_REVIEWER_ENV}=${renderedValue} pins reviewer=${reviewerInput} ` +
    `for builder=${builderClassInput}; the default cross-model review guarantee is waived ` +
    `for this pass${normalizedValue ? '' : ' by explicit routing state'}.`
  );
}

// CFG-02 round-1 review B3 fix (2026-05-30): catch AgentOSConfigError
// so a runtime edit to `config.yaml` (or `~/agent-os/config.yaml`) that
// violates the strict schema cannot blow up the per-PR processing loop
// in `watcher.mjs`. Returns a sentinel `{ configBroken: true, error,
// builderClass }` instead of throwing. Callers that want the legacy
// throw-on-bad-config behavior should use the explicit boot-time
// validator (`validateDefaultReviewerRouteConfig`) at startup, which is
// already wired in `watcher.mjs:main()`.
function routeSubject(subject, { env = process.env, topPath, modulePaths, loaderImpl } = {}) {
  const builderClass = normalizeBuilderClass(subject?.builderClass);
  if (!builderClass) return null;
  let route;
  try {
    route = defaultReviewerRouteFromEnv(env, { topPath, modulePaths, loaderImpl })
      || ROUTE_BY_BUILDER_CLASS[builderClass];
  } catch (err) {
    if (err && err.name === 'AgentOSConfigError') {
      // Surface a tagged sentinel so the watcher's per-PR loop can
      // route to a dedicated "config-broken" disposition + back off,
      // without losing the in-progress batch. The boot-time validator
      // is the legitimate fail-loud path; runtime edits should not
      // abort a tick.
      return {
        configBroken: true,
        error: err,
        builderClass,
        tag: tagFromBuilderClass(builderClass),
        reviewerModel: null,
        botTokenEnv: null,
      };
    }
    throw err;
  }
  return {
    builderClass,
    tag: tagFromBuilderClass(builderClass),
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
  };
}

function linearIssuePrefix(options = {}) {
  const configOptions = {
    env: options.env || process.env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
  };
  const loader = options.loaderImpl !== undefined ? options.loaderImpl : loadConfigCached;
  const cfg = loader(configOptions);
  const value = cfg.get('linear.issue_prefix', 'LAC');
  return String(value || 'LAC').trim() || 'LAC';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLinearTicketId(title, options = {}) {
  const prefix = linearIssuePrefix(options);
  const match = String(title || '').match(
    new RegExp(`\\b(${escapeRegExp(prefix)}-\\d+)\\b`, 'i')
  );
  return match ? match[1].toUpperCase() : null;
}

function routePR(prTitle, subject = null, options = {}) {
  const builderClass = normalizeBuilderClass(
    subject?.builderClass || builderClassFromTitle(prTitle)
  );
  if (!builderClass) return null;
  const route = routeSubject({ builderClass }, options);
  if (!route) return null;
  // CFG-02 round-1 review B3 fix: propagate the config-broken sentinel
  // so the caller can route to a dedicated disposition instead of
  // dereferencing null reviewerModel/botTokenEnv.
  if (route.configBroken) return route;
  return {
    builderClass,
    tag: route.tag,
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
    linearTicketId: extractLinearTicketId(prTitle, options),
  };
}

// `resolveDefaultReviewer` is the CFG-02 cascade-aware name. It returns
// the same route object as `defaultReviewerRouteFromEnv` (or null when no
// pin is in effect); callers/tests targeting the new API can import it
// directly. `defaultReviewerRouteFromEnv` is preserved as the back-compat
// alias and continues to work unchanged for existing call sites.
const resolveDefaultReviewer = defaultReviewerRouteFromEnv;

export {
  DEFAULT_REVIEWER_ENV,
  extractLinearTicketId,
  REVIEWER_ROUTE_BY_MODEL,
  ROUTE_BY_BUILDER_CLASS,
  describeCrossModelReviewWaiver,
  defaultReviewerRouteFromEnv,
  isCrossModelReviewWaived,
  normalizeBuilderClass,
  normalizeReviewerModel,
  resolveDefaultReviewer,
  routePR,
  routeSubject,
  validateDefaultReviewerRouteConfig,
};
