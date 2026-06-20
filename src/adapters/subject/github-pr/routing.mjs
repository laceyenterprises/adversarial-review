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
import {
  resolveAntigravityAccounts,
  resolveDefaultReviewer as resolveDefaultReviewerFromConfig,
  resolveGeminiRuntime,
  resolveGeminiReviewerMode as resolveGeminiReviewerModeFromConfig,
} from '../../../role-config.mjs';
import { AgentOSConfigError, loadConfigCached } from '../../../config-loader.mjs';

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
  opencode: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  hermes: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
};

const DEFAULT_REVIEWER_ENV = 'ADVERSARIAL_REVIEW_DEFAULT_REVIEWER';

// GMW-02 — Gemini as an always-on third reviewer.
//
// Operator-decided default is `always-on`: gemini is selected as the reviewer
// for the cross-model-eligible builder classes below. `fallback` selects gemini
// ONLY when the assigned primary cross-model reviewer is quota-capped (reusing
// the HRR quota-exhaustion signal). `off` preserves the pre-GMW claude↔codex
// routing untouched. The governing config knob is `reviewer.gemini.mode`
// (resolved via role-config's file→env cascade); this module's pure helpers
// take the resolved mode as an argument so they stay trivially testable.
const GEMINI_REVIEWER_MODES = Object.freeze(['off', 'fallback', 'always-on']);
const DEFAULT_GEMINI_REVIEWER_MODE = 'always-on';
const GEMINI_REVIEWER_ROUTE = Object.freeze({
  reviewerModel: 'gemini',
  botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
});
// Builder classes gemini is permitted to review as the always-on third
// reviewer. Matches the SPEC §1 roster contract (gemini reviews
// [claude-code, codex, clio-agent]); pi/opencode/hermes keep their existing
// codex reviewer and are intentionally out of GMW-02 scope. `gemini` is NEVER
// in this set — that is the adversarial-integrity hard guard.
const GEMINI_REVIEWABLE_BUILDER_CLASSES = Object.freeze(['claude-code', 'codex', 'clio-agent']);

const REVIEWER_ROUTE_BY_MODEL = {
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  'claude-code': {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
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
  opencode: 'opencode',
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
      return 'codex';
    case 'gemini':
      return 'gemini';
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
  const runtime = resolveGeminiRuntime({ env, ...opts });
  const accounts = resolveAntigravityAccounts({ env, ...opts });
  if (runtime === 'antigravity' && accounts.length === 0) {
    throw new AgentOSConfigError(
      'reviewer.gemini.runtime=antigravity requires at least one reviewer.gemini.antigravity.accounts[] entry',
      {
        key: 'reviewer.gemini.antigravity.accounts',
        expected: 'non-empty when reviewer.gemini.runtime is antigravity',
        got: [],
      },
    );
  }
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

function normalizeGeminiReviewerMode(modeInput) {
  const mode = String(modeInput ?? '').trim().toLowerCase();
  if (mode === '') return DEFAULT_GEMINI_REVIEWER_MODE;
  if (GEMINI_REVIEWER_MODES.includes(mode)) return mode;
  throw new AgentOSConfigError(
    `reviewer.gemini.mode must be one of: ${GEMINI_REVIEWER_MODES.join(', ')}; got ${JSON.stringify(modeInput)}`,
    {
      key: 'reviewer.gemini.mode',
      expected: GEMINI_REVIEWER_MODES.join(', '),
      got: modeInput,
      allowed: GEMINI_REVIEWER_MODES,
    },
  );
}

function markOperatorPinnedRoute(route, operatorPinnedReviewer = false) {
  if (!route || !operatorPinnedReviewer) return route;
  Object.defineProperty(route, 'operatorPinnedReviewer', {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return route;
}

function resolveGeminiReviewerModeForRoute({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
  geminiReviewerMode,
} = {}) {
  if (geminiReviewerMode !== undefined && geminiReviewerMode !== null) {
    return normalizeGeminiReviewerMode(geminiReviewerMode);
  }
  return resolveGeminiReviewerModeFromConfig({ env, topPath, modulePaths, loaderImpl });
}

// Adversarial-integrity hard guard: gemini may review any builder class EXCEPT
// its own family (a `[gemini]`-built PR). Unknown builder classes are not
// gemini-reviewable (fail-closed). This is the single source of truth the
// routing layer and tests assert against.
function geminiMayReviewBuilder(builderClassInput) {
  const builderClass = normalizeBuilderClass(builderClassInput);
  if (!builderClass) return false;
  return REVIEWER_FAMILY_BY_BUILDER_CLASS[builderClass] !== 'gemini';
}

// applyGeminiReviewerRoute — layers the gemini always-on/fallback selection on
// top of an already-resolved cross-model `baseRoute`. Pure: the caller resolves
// `mode` (config cascade) and, for `fallback`, supplies `primaryReviewerQuotaCapped`
// (the HRR quota-exhaustion signal). Returns `baseRoute` unchanged when gemini
// does not apply, or a new route pinned to gemini with a `geminiReviewerSelection`
// provenance stamp.
//
// The integrity guard runs FIRST and unconditionally (even in `off` mode): if
// `baseRoute` already resolves gemini onto a gemini-built PR — which can only
// happen via an operator `roles.reviewer=gemini` pin — it is stripped back to
// the per-tag cross-model reviewer. Unlike the claude/codex same-model "waiver"
// path, gemini-on-gemini is never permitted.
function applyGeminiReviewerRoute({
  builderClass,
  baseRoute,
  mode,
  primaryReviewerQuotaCapped = false,
} = {}) {
  if (!baseRoute || baseRoute.configBroken) return baseRoute;
  const normalizedBuilder =
    normalizeBuilderClass(builderClass) || normalizeBuilderClass(baseRoute.builderClass);
  const baseIsGemini = normalizeReviewerModel(baseRoute.reviewerModel) === 'gemini';

  // Hard guard: gemini must NEVER review a gemini-built PR, no matter how the
  // gemini reviewer was selected. Fall back to the per-tag cross-model route.
  if (baseIsGemini && normalizedBuilder && !geminiMayReviewBuilder(normalizedBuilder)) {
    const crossModel = ROUTE_BY_BUILDER_CLASS[normalizedBuilder];
    return {
      ...baseRoute,
      reviewerModel: crossModel.reviewerModel,
      botTokenEnv: crossModel.botTokenEnv,
      geminiIntegrityGuard: {
        blockedReviewerModel: 'gemini',
        builderClass: normalizedBuilder,
        fellBackTo: crossModel.reviewerModel,
      },
    };
  }

  const normalizedMode = normalizeGeminiReviewerMode(mode);
  if (normalizedMode === 'off') return baseRoute;
  // Base already routes to gemini for a non-gemini builder (e.g. operator pin) —
  // cross-model already satisfied, nothing to layer on.
  if (baseIsGemini) return baseRoute;
  // Explicit operator reviewer pins are stronger than the Gemini default layer.
  // The Gemini-on-Gemini hard guard above still applies to a Gemini pin.
  if (baseRoute.operatorPinnedReviewer) return baseRoute;
  if (!normalizedBuilder || !geminiMayReviewBuilder(normalizedBuilder)) return baseRoute;
  if (!GEMINI_REVIEWABLE_BUILDER_CLASSES.includes(normalizedBuilder)) return baseRoute;
  if (normalizedMode === 'fallback' && !primaryReviewerQuotaCapped) return baseRoute;

  return {
    ...baseRoute,
    reviewerModel: GEMINI_REVIEWER_ROUTE.reviewerModel,
    botTokenEnv: GEMINI_REVIEWER_ROUTE.botTokenEnv,
    geminiReviewerSelection: {
      mode: normalizedMode,
      replacedReviewerModel: baseRoute.reviewerModel,
      reason:
        normalizedMode === 'fallback'
          ? 'primary-reviewer-quota-capped'
          : 'always-on-third-reviewer',
    },
  };
}

function applyEffectiveReviewerRoute(options = {}) {
  return applyGeminiReviewerRoute(options);
}

function applyGeminiIntegrityGuard(route) {
  return applyGeminiReviewerRoute({
    builderClass: route?.builderClass,
    baseRoute: route,
    mode: 'off',
  });
}

// reviewer-roster debug surface (SPEC §1 mockup). Returns, for each reviewer
// model, both the effective default route matrix and the broader cross-model
// eligibility matrix. The default matrix is computed through
// `applyEffectiveReviewerRoute` so operator-facing output cannot drift from
// routePR()/watcher dispatch semantics.
const ROSTER_BUILDER_CLASSES = Object.freeze(Object.keys(ROUTE_BY_BUILDER_CLASS));
const ROSTER_REVIEWER_MODELS = Object.freeze(['claude', 'codex', 'gemini']);
const REVIEWER_MODEL_FAMILY = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini' });

function geminiRosterNote(mode) {
  switch (mode) {
    case 'always-on':
      return 'always-on, GMW';
    case 'fallback':
      return 'fallback: only when primary reviewer quota-capped, GMW';
    case 'off':
      return 'off: not selected, GMW';
    default:
      return 'GMW';
  }
}

function reviewerRoster({ mode = DEFAULT_GEMINI_REVIEWER_MODE } = {}) {
  const normalizedMode = normalizeGeminiReviewerMode(mode);
  return ROSTER_REVIEWER_MODELS.map((reviewerModel) => {
    const family = REVIEWER_MODEL_FAMILY[reviewerModel];
    const eligibleBuilderClasses = ROSTER_BUILDER_CLASSES.filter((builderClass) => {
      if (reviewerModel === 'gemini') {
        return GEMINI_REVIEWABLE_BUILDER_CLASSES.includes(builderClass);
      }
      return REVIEWER_FAMILY_BY_BUILDER_CLASS[builderClass] !== family;
    });
    const defaultBuilderClasses = ROSTER_BUILDER_CLASSES.filter((builderClass) => {
      const crossModelRoute = ROUTE_BY_BUILDER_CLASS[builderClass];
      const route = applyEffectiveReviewerRoute({
        builderClass,
        baseRoute: {
          builderClass,
          tag: tagFromBuilderClass(builderClass),
          reviewerModel: crossModelRoute.reviewerModel,
          botTokenEnv: crossModelRoute.botTokenEnv,
        },
        mode: normalizedMode,
      });
      return route?.reviewerModel === reviewerModel;
    });
    return {
      reviewerModel,
      defaultBuilderClasses,
      eligibleBuilderClasses,
      note: reviewerModel === 'gemini' ? geminiRosterNote(normalizedMode) : null,
    };
  });
}

function formatReviewerRoster(roster) {
  return roster
    .map(({ reviewerModel, defaultBuilderClasses, eligibleBuilderClasses, note }) => {
      const line = (
        `  ${String(reviewerModel).padEnd(8)} -> ` +
        `default: [${defaultBuilderClasses.join(', ')}]; ` +
        `eligible: [${eligibleBuilderClasses.join(', ')}]`
      );
      return note ? `${line}   (${note})` : line;
    })
    .join('\n');
}

function configBrokenRoute(builderClass, err) {
  return {
    configBroken: true,
    error: err,
    builderClass,
    tag: tagFromBuilderClass(builderClass),
    reviewerModel: null,
    botTokenEnv: null,
  };
}

function baseRouteForSubject(builderClass, { env, topPath, modulePaths, loaderImpl } = {}) {
  let route;
  let operatorPinnedReviewer = false;
  try {
    const pinnedRoute = defaultReviewerRouteFromEnv(env, { topPath, modulePaths, loaderImpl });
    operatorPinnedReviewer = Boolean(pinnedRoute);
    route = pinnedRoute || ROUTE_BY_BUILDER_CLASS[builderClass];
  } catch (err) {
    if (err && err.name === 'AgentOSConfigError') {
      return configBrokenRoute(builderClass, err);
    }
    throw err;
  }
  return markOperatorPinnedRoute(
    applyGeminiIntegrityGuard({
      builderClass,
      tag: tagFromBuilderClass(builderClass),
      reviewerModel: route.reviewerModel,
      botTokenEnv: route.botTokenEnv,
    }),
    operatorPinnedReviewer,
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
function routeSubject(subject, {
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
  geminiReviewerMode,
  primaryReviewerQuotaCapped = false,
  applyGeminiReviewerMode = true,
} = {}) {
  const builderClass = normalizeBuilderClass(subject?.builderClass);
  if (!builderClass) return null;
  const baseRoute = baseRouteForSubject(builderClass, { env, topPath, modulePaths, loaderImpl });
  if (baseRoute?.configBroken || !applyGeminiReviewerMode) return baseRoute;
  try {
    const mode = resolveGeminiReviewerModeForRoute({
      env,
      topPath,
      modulePaths,
      loaderImpl,
      geminiReviewerMode,
    });
    return applyEffectiveReviewerRoute({
      builderClass,
      baseRoute,
      mode,
      primaryReviewerQuotaCapped,
    });
  } catch (err) {
    if (err && err.name === 'AgentOSConfigError') {
      return configBrokenRoute(builderClass, err);
    }
    throw err;
  }
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
    ...(route.geminiReviewerSelection ? { geminiReviewerSelection: route.geminiReviewerSelection } : {}),
    ...(route.geminiIntegrityGuard ? { geminiIntegrityGuard: route.geminiIntegrityGuard } : {}),
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
  DEFAULT_GEMINI_REVIEWER_MODE,
  GEMINI_REVIEWER_MODES,
  GEMINI_REVIEWABLE_BUILDER_CLASSES,
  extractLinearTicketId,
  REVIEWER_ROUTE_BY_MODEL,
  ROUTE_BY_BUILDER_CLASS,
  applyEffectiveReviewerRoute,
  applyGeminiIntegrityGuard,
  applyGeminiReviewerRoute,
  describeCrossModelReviewWaiver,
  defaultReviewerRouteFromEnv,
  formatReviewerRoster,
  geminiMayReviewBuilder,
  isCrossModelReviewWaived,
  normalizeBuilderClass,
  normalizeGeminiReviewerMode,
  normalizeReviewerModel,
  resolveDefaultReviewer,
  reviewerRoster,
  routePR,
  routeSubject,
  validateDefaultReviewerRouteConfig,
};
