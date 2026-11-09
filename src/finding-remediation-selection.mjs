import { createHash } from 'node:crypto';

// Match RGY-02's Python canonical_json(normalize_strings=False): sorted keys,
// compact separators and ASCII escapes, including UTF-16 surrogate pairs.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function validateFindingManifest(db, manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.findings) || manifest.findings.length > 10000
    || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw Error('invalid finding manifest');
  const entries = new Map();
  const lookup = db.prepare(`SELECT f.head_sha,p.repo,p.pr_number FROM review_findings f
    JOIN reviewer_passes p USING(pass_id) WHERE f.finding_id=?`);
  for (const row of manifest.findings) {
    if (typeof row?.finding_id !== 'string' || !row.finding_id || entries.has(row.finding_id)
      || typeof row.repo !== 'string' || !row.repo || !Number.isSafeInteger(row.pr_number) || row.pr_number < 1
      || !/^[a-f0-9]{40}$/i.test(row.head_sha || '')) throw Error('invalid finding manifest identity');
    const actual = lookup.get(row.finding_id);
    if (!actual || actual.repo !== row.repo || actual.pr_number !== row.pr_number || actual.head_sha !== row.head_sha) {
      throw Error('finding manifest pin mismatch');
    }
    entries.set(row.finding_id, { finding_id: row.finding_id, repo: row.repo,
      pr_number: row.pr_number, head_sha: row.head_sha });
  }
  const sorted = [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.finding_id), Buffer.from(b.finding_id)));
  const digest = createHash('sha256').update(canonicalJson({ version: 1, findings: sorted })).digest('hex');
  const heads = [...new Set(sorted.map(({ repo, pr_number, head_sha }) => canonicalJson({ repo, pr_number, head_sha })))]
    .map(text => JSON.parse(text)).sort((a, b) => Buffer.compare(Buffer.from(a.repo), Buffer.from(b.repo))
      || a.pr_number - b.pr_number || Buffer.compare(Buffer.from(a.head_sha), Buffer.from(b.head_sha)));
  if (digest !== manifest.sha256) throw Error('finding manifest hash mismatch');
  if (canonicalJson(heads) !== canonicalJson(manifest.heads ?? null)) {
    throw Error('finding manifest heads mismatch');
  }
  return entries;
}

// Temporary consensus seam until the persisted consensus reader is available.
// Prefer the latest independent, reviewed-head grade; otherwise use the latest
// non-interested batch observation. Lifecycle/staleness and severity calibration
// cannot supply a reviewer correctness label.
const consensusStatements = new WeakMap();
export function readRemediationConsensus(db, { findingId, reviewedHeadSha }) {
  if (!consensusStatements.has(db)) consensusStatements.set(db, db.prepare(`SELECT label FROM review_finding_grades
    WHERE finding_id=? AND interested_party=0 AND lifecycle=0
      AND taxonomy_code NOT LIKE 'life.%' AND taxonomy_code NOT LIKE 'sev.%'
      AND taxonomy_code<>'ind.stale'
      AND ((grader_kind='grader' AND graded_head_sha=?)
        OR grader_kind='batch-remediator')
    ORDER BY CASE grader_kind WHEN 'grader' THEN 0 ELSE 1 END,
      graded_at DESC,grade_id DESC LIMIT 1`));
  const grade = consensusStatements.get(db).get(findingId, reviewedHeadSha);
  return { label: grade?.label ?? 'indeterminate' };
}

// Explicit selections may include blocking findings absent from the automatic
// non-blocking backlog. Only merged sources enroll; existing owners/outcomes
// remain authoritative, including lifecycle retirement and retry exhaustion.
export function enrollManifestFindings(db, entries, manifestSha256) {
  const insert = db.prepare(`INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,manifest_sha256)
    SELECT f.finding_id,p.repo,p.pr_number,f.head_sha,f.content_sha256,
      coalesce(CASE WHEN json_valid(p.metadata_json)
        THEN nullif(json_extract(p.metadata_json,'$.reviewerAttribution.family'),'') END,p.reviewer_class),
      CASE WHEN instr(path,'/')>0 THEN substr(path,1,instr(path,'/')-1)
        ELSE coalesce(nullif(path,''),'_uncited') END,?
    FROM (SELECT *,CASE WHEN substr(trim(file,'\` '),1,2)='./'
      THEN substr(trim(file,'\` '),3) ELSE trim(file,'\` ') END AS path
      FROM review_findings) f JOIN reviewer_passes p USING(pass_id)
    JOIN reviewed_prs r ON r.repo=p.repo AND r.pr_number=p.pr_number
    WHERE f.finding_id=? AND r.pr_state='merged' AND f.current_body=1
      AND p.pass_id=(SELECT last.pass_id FROM reviewer_passes last
        WHERE last.repo=p.repo AND last.pr_number=p.pr_number
          AND last.pass_kind IN ('first-pass','rereview') AND trim(last.body_md)<>''
          AND last.gh_comment_id IS NOT NULL AND trim(cast(last.gh_comment_id AS TEXT))<>''
          AND last.body_captured_at IS NOT NULL AND trim(last.body_captured_at)<>''
        ORDER BY last.body_captured_at DESC,last.ended_at DESC,last.started_at DESC,last.pass_id DESC LIMIT 1)`);
  for (const row of entries.values()) {
    insert.run(manifestSha256, row.finding_id);
  }
}
