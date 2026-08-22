/**
 * The GitHub calls the identity standup drives (ARF-05).
 *
 * Four operations, which are the whole of the App lifecycle ARF can perform
 * without a browser:
 *
 *   getApp                — App JWT -> `GET /app`: the App exists, the key signs
 *                           for it, and here is its slug (which is what the bot
 *                           login is built from).
 *   getRepoInstallation   — App JWT -> `GET /repos/{o}/{r}/installation`: is it
 *                           installed on this repo, and under which installation.
 *   postIssueComment      — installation token -> a real comment, whose response
 *                           says who GitHub thinks wrote it.
 *   getReadyz             — the external broker's own readiness endpoint.
 *
 * **Creating** an App is deliberately absent. GitHub's manifest-conversion flow
 * hands back the private key as raw PEM in an HTTP response body, and SPEC §7 is
 * that ARF never handles raw secret values — so ARF sends the operator to the
 * browser form, they store the key in their vault themselves, and the wizard
 * takes it from there as a reference. That is a smaller wizard than "click here
 * and we do everything", and it is the version that does not put a private key
 * through this process.
 *
 * Errors reuse the broker's permanent/transient vocabulary rather than inventing
 * a parallel one: `github-app.mjs` already classifies GitHub responses that way,
 * `withTransientRetry` keys on it, and a standup step benefits from exactly the
 * same judgement — a 503 mid-standup is worth one more attempt, a 401 is the
 * operator's key being wrong and no number of attempts will change it.
 */

import { BrokerPermanentError, BrokerTransientError } from '../broker/errors.mjs';
import { readCappedBody } from '../broker/http.mjs';
import { withTransientRetry } from '../broker/retry.mjs';
import { safeUpstreamDetail } from '../broker/secrets.mjs';

const GITHUB_API_VERSION = '2022-11-28';

/** Statuses that mean "retrying might work". Everything else is settled. */
const TRANSIENT_STATUSES = new Set([408, 429]);

function detailFrom(bodyText, status, what) {
  const base = `${what} failed with HTTP ${status}`;
  try {
    const body = JSON.parse(bodyText);
    const message = body?.message ?? body?.error ?? body?.detail;
    if (typeof message === 'string' && message) {
      // Someone else's text quoted into ARF's error, so it is scrubbed first —
      // a proxy or a gateway echoing an Authorization header into its own error
      // body would otherwise have ARF republish the credential.
      return `${base}: ${safeUpstreamDetail(message, []).slice(0, 200)}`;
    }
  } catch {
    // A non-JSON body tells an operator nothing the status does not, and
    // echoing it raw risks pasting a proxy's HTML into a log line.
  }
  return base;
}

/**
 * One HTTP call against GitHub (or the broker), classified and capped.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {string|null} [options.authorization] a complete header value
 * @param {object|null} [options.body] JSON request body
 * @param {number[]} [options.allowStatuses] statuses returned rather than thrown
 * @param {Function} options.fetchImpl
 * @param {number} options.requestTimeoutMs
 * @param {AbortSignal|null} [options.signal] the run's cancellation signal
 * @param {object} [options.retry] bounded-backoff options
 * @param {string} options.what human-readable operation name, used in errors
 * @returns {Promise<{status: number, body: any}>}
 */
export function githubRequest({
  url,
  method = 'GET',
  authorization = null,
  body = null,
  allowStatuses = [],
  fetchImpl,
  requestTimeoutMs,
  signal = null,
  retry = undefined,
  what,
}) {
  const allowed = new Set(allowStatuses);

  return withTransientRetry(async () => {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
    };
    if (authorization) headers.authorization = authorization;
    if (body !== null) headers['content-type'] = 'application/json';

    // The per-attempt timeout and the run's cancellation are both real reasons to
    // stop, and a step that ignored the second would keep a wizard's HTTP call
    // alive after the operator closed the stream.
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: abort,
      });
    } catch (err) {
      if (signal?.aborted) {
        // Not a GitHub problem, and not worth retrying: the run is over.
        throw new BrokerPermanentError(`${what} was cancelled`, { cause: err });
      }
      throw new BrokerTransientError(`${what} failed: ${err.message}`, { cause: err });
    }

    // Streamed and byte-capped: an error page from whatever is answering on the
    // API host must not be able to exhaust ARF's heap on the way to an error.
    const bodyText = await readCappedBody(response);

    if (!response.ok && !allowed.has(response.status)) {
      if (response.status >= 500 || TRANSIENT_STATUSES.has(response.status)) {
        throw new BrokerTransientError(detailFrom(bodyText, response.status, what));
      }
      throw new BrokerPermanentError(detailFrom(bodyText, response.status, what));
    }

    let parsed = null;
    if (bodyText !== '') {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // An allowed non-2xx (a 404 we asked to see) has no useful body, so a
        // parse failure there is not an error. On the success path it is.
        if (response.ok) {
          throw new BrokerTransientError(`${what} returned invalid JSON`);
        }
      }
    }
    return { status: response.status, body: parsed };
  }, retry);
}

/**
 * `GET /app` — confirm the App exists and capture its identity.
 *
 * The slug is the payload that matters: GitHub attributes an App's writes to
 * `<slug>[bot]`, and that login is what the verify step checks the comment
 * against. Without it there is no way to tell "the bot posted" from "something
 * posted".
 */
export async function getApp({ githubApiUrl, appJwt, ...rest }) {
  const { body } = await githubRequest({
    url: `${githubApiUrl}/app`,
    authorization: `Bearer ${appJwt}`,
    what: 'github app lookup (GET /app)',
    ...rest,
  });
  return {
    appId: body?.id === undefined || body?.id === null ? null : String(body.id),
    slug: typeof body?.slug === 'string' ? body.slug : null,
    name: typeof body?.name === 'string' ? body.name : null,
    owner: typeof body?.owner?.login === 'string' ? body.owner.login : null,
    permissions: body?.permissions && typeof body.permissions === 'object' ? body.permissions : {},
  };
}

/**
 * `GET /repos/{owner}/{repo}/installation` — which installation covers this repo.
 *
 * A 404 is a legitimate answer ("not installed here yet"), so it is returned
 * rather than thrown: the step turns it into an actionable "install it at this
 * URL" rather than an error the operator has to decode.
 */
export async function getRepoInstallation({ githubApiUrl, appJwt, repo, ...rest }) {
  const [owner, name] = repo.split('/');
  const { status, body } = await githubRequest({
    url: `${githubApiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    authorization: `Bearer ${appJwt}`,
    allowStatuses: [404],
    what: `github installation lookup for ${repo}`,
    ...rest,
  });
  if (status === 404) return { repo, installed: false, installationId: null, account: null };
  return {
    repo,
    installed: true,
    installationId: body?.id === undefined || body?.id === null ? null : String(body.id),
    account: typeof body?.account?.login === 'string' ? body.account.login : null,
  };
}

/**
 * Post a comment as the role, and report back who GitHub says wrote it.
 *
 * The response's `user` block is the entire point of the call. ARF cannot know
 * from its own side whether the token it used carries the identity it asked for
 * — only GitHub's attribution of an actual write can tell it that.
 */
export async function postIssueComment({ githubApiUrl, token, repo, issueNumber, commentBody, ...rest }) {
  const [owner, name] = repo.split('/');
  const { body } = await githubRequest({
    url: `${githubApiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      + `/issues/${encodeURIComponent(issueNumber)}/comments`,
    method: 'POST',
    // Built inside `use()` and handed straight to the request; the header object
    // is not logged, returned, or recorded anywhere in this module.
    authorization: token.use((value) => `Bearer ${value}`),
    body: { body: commentBody },
    what: `bot-attributed post to ${repo}#${issueNumber}`,
    ...rest,
  });
  return {
    commentId: body?.id ?? null,
    url: typeof body?.html_url === 'string' ? body.html_url : null,
    login: typeof body?.user?.login === 'string' ? body.user.login : null,
    userType: typeof body?.user?.type === 'string' ? body.user.type : null,
  };
}

/**
 * `GET <endpoint>/readyz` on the external broker.
 *
 * A 2xx alone is not taken as ready: a broker that answers `{"can_serve": false}`
 * is telling us it is up and cannot mint, which is exactly the state a standup
 * must not sail past. Both spellings are accepted because the in-OS broker's
 * readiness body uses `can_serve` and the generic convention is `ok`.
 */
export async function getReadyz({ endpoint, ...rest }) {
  const { status, body } = await githubRequest({
    url: `${endpoint}/readyz`,
    what: `broker readiness check (GET ${endpoint}/readyz)`,
    ...rest,
  });
  const ready = body?.ok !== false && body?.can_serve !== false && body?.ready !== false;
  return {
    target: `${endpoint}/readyz`,
    status,
    ready,
    detail: typeof body?.status === 'string' ? body.status : null,
  };
}
