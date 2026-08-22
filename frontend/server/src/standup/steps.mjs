/**
 * The five steps of an identity standup (ARF-05, SPEC §1 Screen C).
 *
 * Each step is a small object: an id, a label, the inputs it consumes (which is
 * what its resume fingerprint is taken over), and an async `run(ctx)` that either
 * returns a detail + outputs or throws. The machinery around them — ordering,
 * resume, SSE, persistence — lives in `identity-run.mjs` and knows nothing about
 * GitHub. That split is what lets the step list be read as a description of the
 * ritual rather than as control flow.
 *
 * ## `alwaysRun`: the two steps that are never replayed from a record
 *
 * Steps 1–3 record durable facts. An App with id 887 still has id 887 tomorrow;
 * a key stored in a vault is still stored. Replaying them on a re-run is honest,
 * and it is what makes resume useful.
 *
 * Steps 4 and 5 are different in kind. "The mapping resolves to a token" and
 * "the identity posts as itself" are claims about *right now*, and their product
 * — a live `ghs_` grant — cannot be persisted anyway (nor should it be). A run
 * that replayed a recorded `wire ✔` would show the operator a green mapping
 * that may have been deleted since, which is the fail-loud gate quietly turned
 * off by a cache. So they carry `alwaysRun` and re-prove themselves every time.
 *
 * This is also why "resume from the last completed step" lands where it does: the
 * last *replayable* completed step. A run that got to verify and failed there
 * re-runs the wire step too, because that is the only way to hold a token again.
 */

import { BROKER_MODE_EXTERNAL } from '../broker/manifest.mjs';
import {
  AmbientAttributionError, IdentityMismatchError, OperatorInputRequiredError, TokenMapUnavailableError,
} from './errors.mjs';
import { getApp, getReadyz, getRepoInstallation, postIssueComment } from './github-ops.mjs';
import { buildRoleEntry, mappingMismatch, writeRoleMapping } from './role-mapping.mjs';

/** Where an operator creates a GitHub App — org form when we know the org. */
export function appCreateUrl(org) {
  return org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

/** Where an operator installs an App, once it has a slug. */
export function appInstallUrl(slug) {
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

/** The login GitHub attributes an App's writes to. */
export function botLoginFor(slug) {
  return slug ? `${slug}[bot]` : null;
}

/**
 * Step 1 — create or select the GitHub App, and capture `app_id` (+ the slug).
 *
 * ARF does not create the App. GitHub's manifest-conversion flow returns the
 * private key as raw PEM in a response body, and ARF never handles raw secret
 * values (SPEC §7) — so the operator creates it in the browser, stores the key in
 * their vault, and hands ARF the *reference*. The wizard's job here is to prove
 * that reference signs for that App and to learn the slug, without which there is
 * no bot login to verify attribution against later.
 */
async function createOrSelectApp(ctx) {
  const { params } = ctx;
  if (!params.appId || !params.privateKeyRef) {
    throw new OperatorInputRequiredError(
      'this role has no GitHub App selected yet: ARF needs the App id and a secret '
      + '*reference* to its private key. ARF does not create the App itself — GitHub returns '
      + 'the private key as raw PEM, and ARF never handles raw secret values. Create (or pick) '
      + 'the App, store its private key in your secret store, and re-run with the reference; '
      + 'the run resumes from this step.',
      {
        nextAction: {
          summary: 'Create or select the GitHub App, store its private key, then re-run',
          url: appCreateUrl(params.org),
          params: {
            appId: params.appId ?? '<app id>',
            privateKeyRef: params.privateKeyRef ?? 'op://<vault>/<item>/private key',
          },
        },
      },
    );
  }

  const app = await getApp({ ...ctx.github(), appJwt: await ctx.appJwt() });

  // The JWT's `iss` is the App id, so GitHub answering with a different one means
  // something between here and GitHub is not what it claims to be. Cheap to check
  // and the alternative is capturing a slug that belongs to another App.
  if (app.appId && String(app.appId) !== String(params.appId)) {
    throw new IdentityMismatchError(
      `GET /app answered for app_id ${app.appId} but the run is standing up app_id `
      + `${params.appId}; refusing to capture coordinates for an App that was not requested.`,
      { field: 'appId', expected: String(params.appId), actual: String(app.appId) },
    );
  }

  return {
    detail: `app_id ${app.appId ?? params.appId}${app.slug ? ` (${app.slug})` : ''}`,
    outputs: {
      appId: app.appId ?? params.appId,
      appSlug: app.slug,
      appName: app.name,
      appOwner: app.owner,
      botLogin: botLoginFor(app.slug),
    },
  };
}

/**
 * Step 2 — install on the target repo(s), and capture `installation_id`.
 *
 * Installation is also an operator action (GitHub requires the owner to approve
 * it), so a repo the App is not on yet produces an actionable refusal rather than
 * an error. A role maps to exactly one installation, so repos that resolve to
 * different installations are a configuration ARF refuses to flatten.
 */
async function installApp(ctx) {
  const { params, outputs } = ctx;
  const repos = params.repos ?? [];
  if (repos.length === 0) {
    throw new OperatorInputRequiredError(
      'no target repositories were given, so there is no installation to capture. '
      + 'Re-run with repos: ["owner/repo", …].',
      {
        nextAction: {
          summary: 'Name the repositories this identity acts on',
          url: appInstallUrl(outputs.appSlug),
          params: { repos: ['<owner>/<repo>'] },
        },
      },
    );
  }

  const appJwt = await ctx.appJwt();
  const github = ctx.github();
  const found = [];
  for (const repo of repos) {
    ctx.throwIfAborted();
    found.push(await getRepoInstallation({ ...github, appJwt, repo }));
  }

  const missing = found.filter((entry) => !entry.installed).map((entry) => entry.repo);
  if (missing.length > 0) {
    throw new OperatorInputRequiredError(
      `the App is not installed on ${missing.join(', ')}. Install it on those repositories `
      + '(GitHub requires the owner to approve an installation) and re-run; the run resumes '
      + 'from this step.',
      {
        nextAction: {
          summary: `Install ${outputs.appName ?? 'the App'} on ${missing.join(', ')}`,
          url: appInstallUrl(outputs.appSlug),
          params: { repos: missing },
        },
      },
    );
  }

  const ids = [...new Set(found.map((entry) => entry.installationId).filter(Boolean))];
  if (ids.length === 0) {
    throw new IdentityMismatchError(
      'GitHub reported the App as installed but returned no installation id, so there is '
      + 'nothing to mint against.',
      { field: 'installationId', expected: 'an installation id', actual: null },
    );
  }
  if (ids.length > 1) {
    // One role, one identity. Picking either would make the role's writes come
    // from an installation the operator did not choose on half the repos.
    throw new IdentityMismatchError(
      `the target repositories resolve to different installations (${ids.join(', ')}). `
      + 'A role maps to exactly one installation; split them into separate roles.',
      { field: 'installationId', expected: 'a single installation', actual: ids.join(', ') },
    );
  }

  const installationId = ids[0];
  if (params.installationId && String(params.installationId) !== installationId) {
    throw new IdentityMismatchError(
      `the run was given installation_id ${params.installationId} but ${repos.join(', ')} `
      + `resolve to ${installationId}; refusing to wire a role to an installation that does `
      + 'not cover its repositories.',
      { field: 'installationId', expected: String(params.installationId), actual: installationId },
    );
  }

  return {
    detail: `installation ${installationId} on ${repos.join(', ')}`,
    outputs: {
      installationId,
      installationRepos: repos,
      installationAccount: found[0]?.account ?? null,
    },
  };
}

/**
 * Step 3 — record the private key and PAT fallback as secret **references**.
 *
 * There is nothing here that copies, moves, or reads a secret into ARF's own
 * storage: the operator's vault holds the material and ARF holds a pointer to it.
 * What this step does is prove the pointers resolve *now*, so a wrong ref is
 * found here rather than at 3am when the hammer tries to mint.
 *
 * The private key was already resolved (step 1 signed a JWT with it), so only the
 * PAT fallback needs proving. A role may legitimately have no PAT fallback — the
 * App identity is the one that matters — so its absence is recorded, not refused.
 */
async function storeSecretRefs(ctx) {
  const { params } = ctx;
  // Both refs were parsed at the door (`params.mjs`), which is where a raw secret
  // is refused. Re-stating the invariant here is cheap and keeps the step honest
  // if it is ever driven from somewhere other than the HTTP surface.
  if (!params.privateKeyRef) {
    throw new OperatorInputRequiredError(
      'no private-key reference is recorded for this role.',
      {
        nextAction: {
          summary: 'Store the App private key in your secret store and supply its reference',
          params: { privateKeyRef: 'op://<vault>/<item>/private key' },
        },
      },
    );
  }

  const outputs = {
    privateKeyRef: params.privateKeyRef,
    patFallbackRef: params.patFallbackRef ?? null,
    patFallbackFingerprint: null,
  };

  let detail = `private key ${params.privateKeyRef}`;
  if (params.patFallbackRef) {
    const pat = await ctx.resolveSecret(params.patFallbackRef, {
      field: 'patFallbackRef',
      role: ctx.role,
    });
    // The fingerprint, never the material: enough to correlate this ref with a
    // later mint in the audit log, useless to anyone who reads the record.
    outputs.patFallbackFingerprint = pat.fingerprint();
    detail += `, PAT fallback ${params.patFallbackRef}`;
  } else {
    detail += ', no PAT fallback';
  }

  return { detail, outputs };
}

/**
 * Step 4 — wire the role -> token map through the ARF-07 seam. **The fail-loud gate.**
 *
 * Three outcomes, and the third is the one this ticket exists for:
 *
 *  1. The role is already mapped and the mapping names the identity we just stood
 *     up — nothing to write, go straight to resolving a token.
 *  2. The role is unmapped and `broker.rolesFile` gives ARF a manifest to write
 *     into — write it, reload the broker *from disk*, resolve a token.
 *  3. The role is unmapped and there is nowhere to record a mapping — **FAIL**.
 *
 * There is no fourth branch. ARF does not proceed to verification under whatever
 * identity the process happens to be carrying, does not read `GITHUB_TOKEN` or
 * `gh auth`, and does not treat a broker's default credential as "close enough".
 * That is the 2026-07-23 RCA (SPEC §6): a role with no mapping fell through to an
 * ambient identity, so the run *looked* successful and the writes were attributed
 * to the wrong actor. The refusal is the feature.
 *
 * `resolveToken` is called even on branch 1, and its `UnmappedRoleError` is
 * allowed to propagate: the broker is the authority on whether a mapping exists,
 * and a wizard that caught that error to try something else would be reinstating
 * exactly the fallback the seam refuses.
 */
async function wireTokenMap(ctx) {
  const { role, params, outputs } = ctx;
  const brokerConfig = ctx.config.broker;
  const mode = brokerConfig.mode;
  let broker = ctx.broker();
  let mappingSource = 'existing';
  let wrote = null;

  const existing = broker.describe().roles.find((entry) => entry.role === role) ?? null;

  if (existing) {
    // A mapping that points somewhere else is not a mapping for this identity.
    // Wiring over it would attribute the role's writes to whichever App the stale
    // entry names — an ambient identity by a slower route.
    const mismatch = mappingMismatch(existing, outputs);
    if (mismatch) {
      throw new IdentityMismatchError(
        `role ${JSON.stringify(role)} is already mapped to ${mismatch.field} `
        + `${mismatch.actual}, but this run stood up ${mismatch.expected}. ARF will not `
        + 'silently repoint an existing mapping: fix the mapping, or stand the identity up '
        + 'under a different role.',
        mismatch,
      );
    }
  } else if (brokerConfig.rolesFile) {
    const entry = buildRoleEntry({ role, mode, outputs, params });
    wrote = writeRoleMapping({ path: brokerConfig.rolesFile, role, entry });
    // Reloaded from disk rather than patched in memory: what the operator is
    // about to see succeed is then the same thing a restarted ARF would see.
    broker = ctx.reloadBroker();
    mappingSource = wrote.created ? 'created' : 'written';
  } else {
    throw new TokenMapUnavailableError(role, {
      knownRoles: broker.describe().roles.map((entry) => entry.role),
      nextAction: {
        summary: 'Give ARF a manifest to record mappings in, or map the role by hand',
        params: { brokerRolesFile: '<stateRoot>/roles.json' },
      },
    });
  }

  // The seam's own gate. An unmapped role throws here and the run ends: the
  // wizard surfaces the refusal rather than swallowing it.
  const grant = await ctx.tokenGrant({ broker, forceRefresh: true });

  return {
    detail: `${mappingSource} mapping -> ${grant.tokenType} (${grant.credentialSource})`,
    outputs: {
      mappingSource,
      mappingFile: wrote?.path ?? brokerConfig.rolesFile ?? null,
      mappedRoles: wrote?.roles ?? null,
      brokerMode: mode,
      // The grant's safe half only: a type, a fingerprint, and a deadline. The
      // token itself is a SecretValue and never leaves the process.
      tokenType: grant.tokenType,
      tokenFingerprint: grant.fingerprint,
      tokenExpiresAt: grant.expiresAt,
      credentialSource: grant.credentialSource,
    },
  };
}

/**
 * Step 5 — verify: provider `readyz`, then a **bot-attributed** post.
 *
 * The readiness check answers "is the thing that mints tokens up". The post
 * answers the question that actually matters and that nothing else in the run
 * can: *does this identity act as itself?* ARF cannot tell from its own side
 * whether the credential it holds carries the identity it asked for — only
 * GitHub's attribution of a real write can say so.
 *
 * So the comment is posted and the response's `user` block is read back. A post
 * attributed to a human account means the run acted as the ambient user; a post
 * attributed to a different bot means it acted as another App. Both fail, even
 * though every HTTP call in the run returned 2xx.
 *
 * A note worth having in front of you: a grant that came from a role's **PAT
 * fallback** cannot pass this step, because a PAT posts as its owner. That is
 * correct rather than unfortunate — the fallback keeps the pipeline moving during
 * an outage, but it is not the App identity, and a standup that certified it as
 * one would be certifying the wrong thing.
 */
async function verifyIdentity(ctx) {
  const { role, params, outputs } = ctx;
  if (!params.verifyRepo || !params.verifyIssue) {
    throw new OperatorInputRequiredError(
      'verification needs somewhere to post: a repository and an issue or PR number the '
      + 'identity should comment on. The post is the proof that the identity acts as itself '
      + 'rather than as whatever account ARF happens to be running under.',
      {
        nextAction: {
          summary: 'Name an issue or PR for the bot-attributed verification post',
          params: { verifyRepo: '<owner>/<repo>', verifyIssue: '<issue or PR number>' },
        },
      },
    );
  }

  const github = ctx.github();
  const readyz = ctx.config.broker.mode === BROKER_MODE_EXTERNAL
    ? await getReadyz({ ...github, endpoint: ctx.config.broker.endpoint })
    : await (async () => {
      // Bundled mode has no separate provider to ask, so readiness *is* "GitHub
      // answers, and it answers for this App with this key" — the same call step
      // 1 made, re-made now, which is what a readiness probe is.
      const app = await getApp({ ...github, appJwt: await ctx.appJwt() });
      return {
        target: `${ctx.config.broker.githubApiUrl}/app`,
        status: 200,
        ready: Boolean(app.appId),
        detail: app.slug,
      };
    })();

  if (!readyz.ready) {
    throw new IdentityMismatchError(
      `the token provider at ${readyz.target} answered but is not ready`
      + `${readyz.detail ? ` (${readyz.detail})` : ''}; refusing to certify an identity `
      + 'against a provider that has told us it cannot mint.',
      { field: 'readyz', expected: 'ready', actual: readyz.detail ?? 'not ready' },
    );
  }

  ctx.throwIfAborted();
  const grant = await ctx.tokenGrant();
  const posted = await postIssueComment({
    ...github,
    token: grant.token,
    repo: params.verifyRepo,
    issueNumber: params.verifyIssue,
    commentBody:
      `ARF identity standup — verification post for role \`${role}\` (run \`${ctx.runId}\`).\n\n`
      + 'This comment was written with the credential the role\'s mapping resolves to. Its '
      + 'attribution above is the proof that the identity acts as itself and not as an '
      + 'ambient account.',
  });

  const expectedLogin = outputs.botLogin ?? null;
  // `type` is GitHub's own word for what wrote this. A `User` here means the
  // credential was a PAT or an ambient session, whatever else went right.
  if (posted.userType !== 'Bot' || (expectedLogin && posted.login !== expectedLogin)) {
    throw new AmbientAttributionError({
      role,
      expectedLogin,
      actualLogin: posted.login,
      actualType: posted.userType,
    });
  }

  return {
    detail: `readyz ok; posted as ${posted.login} on ${params.verifyRepo}#${params.verifyIssue}`,
    outputs: {
      readyzTarget: readyz.target,
      readyzOk: true,
      attributedLogin: posted.login,
      attributedType: posted.userType,
      verifyCommentUrl: posted.url,
      verifyCommentId: posted.commentId,
      verifiedAt: ctx.isoNow(),
    },
  };
}

/**
 * The step list, in order. Exported so the panel can render the ritual before a
 * run exists, and so tests can assert the contract rather than a screenshot.
 *
 * `inputs` is the tuple a step's resume fingerprint is taken over — deliberately
 * only what the step *consumes*, so changing an unrelated field does not discard
 * work that is still valid.
 */
export const IDENTITY_STEPS = Object.freeze([
  {
    id: 'create_or_select_app',
    label: 'Create / select GitHub App',
    inputs: (ctx) => [ctx.params.appId ?? null, ctx.params.privateKeyRef ?? null, ctx.githubApiUrl],
    run: createOrSelectApp,
  },
  {
    id: 'install_app',
    label: 'Install on repo(s)',
    inputs: (ctx) => [ctx.outputs.appId ?? null, ctx.params.repos ?? [], ctx.params.installationId ?? null],
    run: installApp,
  },
  {
    id: 'store_secrets',
    label: 'Store private key + PAT fallback (secret ref)',
    inputs: (ctx) => [ctx.params.privateKeyRef ?? null, ctx.params.patFallbackRef ?? null],
    run: storeSecretRefs,
  },
  {
    id: 'wire_token_map',
    label: 'Wire token (role -> token map)',
    inputs: (ctx) => [ctx.role, ctx.outputs.appId ?? null, ctx.outputs.installationId ?? null],
    alwaysRun: true,
    run: wireTokenMap,
  },
  {
    id: 'verify_identity',
    label: 'Verify: provider readyz + a bot-attributed post',
    inputs: (ctx) => [ctx.params.verifyRepo ?? null, ctx.params.verifyIssue ?? null],
    alwaysRun: true,
    run: verifyIdentity,
  },
]);

/** The step ids, in order — the contract the panel and the tests share. */
export const IDENTITY_STEP_IDS = Object.freeze(IDENTITY_STEPS.map((step) => step.id));

/** The four statuses a step reports. SPEC §3 ARF-05 names exactly these. */
export const STEP_STATUSES = Object.freeze(['pending', 'running', 'ok', 'failed']);
