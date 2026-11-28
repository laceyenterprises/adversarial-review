const STDERR_TAIL_BYTES = 2048;
const GITHUB_MESSAGE_BYTES = 384;
const HTTP_STATUS = /\b(?:HTTP(?:\/[\d.]+)?\s+|HTTP(?: error)?:\s*|returned error:\s*)([45]\d\d)\b/giu;
const PERMISSION_REFUSAL = /\b(?:GH006|GH013|protected branch|branch protection|repository rule violations?|write access[^\n]*not granted|permission[^\n]*denied|resource not accessible by integration|refus(?:ed|ing) to allow [^\n]*workflow)\b/iu;
const CREDENTIAL_REFUSAL = /\b(?:bad credentials|authentication failed|(?:installation )?token (?:has )?expired|invalid username or (?:password|token))\b/iu;
const SHIM_RETRIED = /^github_token_rejected_after_refresh;/mu;

export function redactGithubAuthRecoveryDetail(value) {
  return String(value || '')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(\b(?:proxy-)?authorization:\s*(?:basic|bearer|token)\s+)[^\s'"]+/gi, '$1[REDACTED_CREDENTIAL]')
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s?#'"<>]+@/gi, '$1[REDACTED_CREDENTIAL]@')
    .replace(/([?&](?:access_token|token|password|client_secret)=)[^&#\s'"]+/gi, '$1[REDACTED_CREDENTIAL]')
    .replace(/(?:\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|\/Volumes\/)[^\s'")]+/g, '[REDACTED_PATH]');
}

function redactedTail(value, maxBytes) {
  // Redact before truncating so a token crossing the byte boundary is removed.
  const bytes = Buffer.from(redactGithubAuthRecoveryDetail(value).trim());
  let start = Math.max(0, bytes.length - maxBytes);
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function publicationPushDiagnostic(error, { credentialRetried = false, secrets = [] } = {}) {
  let stderr = String(error.stderr || '');
  for (const secret of secrets.filter(Boolean)) stderr = stderr.replaceAll(secret, '[REDACTED_CREDENTIAL]');
  const reportedStatus = error.status ?? error.statusCode;
  let httpStatus = Number.isInteger(reportedStatus) ? reportedStatus : undefined;
  if (httpStatus === undefined) {
    for (const match of stderr.matchAll(HTTP_STATUS)) httpStatus = Number(match[1]);
  }
  const shimRetried = SHIM_RETRIED.test(stderr);
  const authRefusal = httpStatus === 403 || PERMISSION_REFUSAL.test(stderr) ? 'permission'
    : httpStatus === 401 || shimRetried || CREDENTIAL_REFUSAL.test(stderr) ? 'authentication' : null;
  const pushExitCode = error.exitCode ?? error.code;
  const githubMessage = httpStatus === undefined && authRefusal
    ? stderr.split(/\r?\n/u).find(line => (authRefusal === 'permission' ? PERMISSION_REFUSAL : CREDENTIAL_REFUSAL).test(line))
    : undefined;
  return normalizePublicationPushDiagnostic({ stderrTail: stderr, pushExitCode, httpStatus, authRefusal,
    credentialRetried: credentialRetried || shimRetried, githubMessage });
}

export function normalizePublicationPushDiagnostic(value) {
  const { pushExitCode, httpStatus, authRefusal, credentialRetried } = value ?? {};
  const tail = typeof value?.stderrTail === 'string' ? redactedTail(value.stderrTail, STDERR_TAIL_BYTES) : '';
  const githubMessage = typeof value?.githubMessage === 'string' ? redactedTail(value.githubMessage, GITHUB_MESSAGE_BYTES) : '';
  return {
    ...(tail && { stderrTail: tail }),
    ...(githubMessage && !tail.includes(githubMessage) && { githubMessage }),
    ...(Number.isInteger(pushExitCode) && pushExitCode > 0 && pushExitCode <= 255 && { pushExitCode }),
    ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 && { httpStatus }),
    ...(['permission', 'authentication'].includes(authRefusal) && { authRefusal }),
    ...(credentialRetried === true && { credentialRetried }),
  };
}

export function publicationPushDiagnosticText({ pushExitCode, httpStatus, githubMessage, credentialRetried, stderrTail }) {
  return [pushExitCode && `Guarded push exit code ${pushExitCode}.`, httpStatus && `GitHub HTTP ${httpStatus}.`,
    githubMessage,
    credentialRetried && 'The guarded push retried with a fresh credential.',
    stderrTail && `git-safe stderr:\n${stderrTail}`].filter(Boolean).join(' ');
}
