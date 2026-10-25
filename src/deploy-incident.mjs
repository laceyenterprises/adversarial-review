// Scheduling hint only: never grants review, lease or merge authority.
export function hasDeployIncidentMarker(body) {
  return /<!--[\t ]*deploy-incident:v1[\t ]+id=[A-Za-z0-9][A-Za-z0-9._-]*[\t ]*-->/.test(String(body || ''));
}
