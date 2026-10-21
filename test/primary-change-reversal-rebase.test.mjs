import './helpers/load-aware-timeout-fixture.mjs';
import { collect, review } from './helpers/hamclose-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrimaryChange, fetchPrimaryChange, fetchPrimaryChangeContext,
  primaryChangeExactReviewEvidence } from '../src/ama/primary-change.mjs';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';

const sha = (c) => c.repeat(40);
const oldBase = sha('0'), base = sha('b'), reviewedHead = sha('1'), author = sha('2'), head = sha('c');

async function snapshotReversal({ transform = (_path, response) => response,
  read = (path, transport) => transport(path), ...options } = {}) {
  const later = review({ node_id: 'PRR_snapshot', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  const { transport } = await collect({ originalRecorded: true, reviews: [review(), later], ...options });
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
    get: async path => transform(path, await read(path, transport)) },
  { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
  return { evidence, result: checkPrimaryChange(evidence, head) };
}

function withReversalContext(commit, context) {
  return { ...commit, files: commit.files.map(file => ({ ...file,
    patch: file.patch.replace(/^@@ -(\d+),2 \+(\d+) @@/,
      (_header, oldLine, newLine) => `@@ -${Number(oldLine) - 1},4 +${Number(newLine) - 1},3 @@ ${context}`)
      .replace('\n', `\n ${context}_before()\n`) + `\n ${context}_after()`,
  })) };
}

async function recommittedReversal({ attested = false, original = false,
  transform = (_path, response) => response, ...options } = {}) {
  return snapshotReversal({
    ...(original ? {} : { reviews: [review()] }),
    ...(attested ? { attestationAuthor: 'the-hammer-lacey[bot]' } : {}),
    ...options,
    transform: (path, response) => transform(path, path.endsWith(`/commits/${head}`)
      ? { ...withReversalContext(response, 'new_base'), committer: { login: 'fixture-rebase-worker' } }
      : path.endsWith(`/commits/${sha('d')}`) ? withReversalContext(response, 'old_base') : response),
  });
}

test('REVERSALPROV-01: a worker-rebased HAM reversal accepts exact-head App attestation', async () => {
  const { evidence, result } = await recommittedReversal({ attested: true });
  assert.equal(result.ok, true);
  assert.equal(evidence.reversalAuthorizations[0].commit.reversalAppAttested, true);
  assert.equal(evidence.reversalAuthorizations[0].rebased, true);
  for (const attestationHead of [sha('9'), sha('d')]) {
    const rejected = await recommittedReversal({ attested: true, attestationHead });
    assert.equal(rejected.result.reason, 'primary-change-reverted');
    assert.equal(rejected.evidence.rejectedReversalAuthorizations[0].reason, 'rebased-commit-unproven');
  }
});

test('REVERSALPROV-01: a worker-rebased HAM reversal keeps its immutable original proof', async () => {
  const { evidence, result } = await recommittedReversal({ original: true, transform: (path, response) =>
    path.endsWith(`/commits/${head}`)
      ? { ...response, commit: { ...response.commit,
        message: response.commit.message.replace('HAM repair', 'Rebased HAM repair') } }
      : path.endsWith(`${base}...${head}`)
        ? { ...response, commits: response.commits.map(commit => commit.sha === head
          ? { ...commit, commit: { ...commit.commit,
            message: commit.commit.message.replace('HAM repair', 'Rebased HAM repair') } } : commit) }
        : response });
  assert.equal(result.ok, true);
  assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, sha('d'));
  assert.equal(evidence.reversalAuthorizations[0].commit.reversalAppAttested, undefined);
  // The evaluator independently binds the original patch and trailer set.
  const authorization = evidence.reversalAuthorizations[0];
  authorization.commit.files[0].patch = authorization.commit.files[0].patch.replace('+start()', '+other()');
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('REVERSALPROV-01: different removed/added lines, trailers or original identities refuse rebase proof', async () => {
  for (const options of [
    { originalAdded: '-different_generated_line()' },
    { originalLogin: 'fixture-builder' },
    { transform: (path, response) => path.endsWith(`/commits/${head}`)
      ? { ...response, files: response.files.map(file => ({ ...file,
        patch: file.patch.replace('+start()', '+different_generated_line()') })) } : response },
    { transform: (path, response) => path.endsWith(`/commits/${sha('d')}`)
      || path.endsWith(`${reviewedHead}...${sha('f')}`)
      ? JSON.parse(JSON.stringify(response).replaceAll('Worker-Ticket: HAM', 'Worker-Ticket: AMA-PR-8088')) : response },
  ]) {
    const { evidence, result } = await recommittedReversal({ original: true, ...options });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'rebased-commit-unproven');
    assert.match(result.missingEvidence.summary, /rebased-commit-unproven/);
  }
  const unproven = await recommittedReversal();
  assert.equal(unproven.evidence.rejectedReversalAuthorizations[0].reason, 'rebased-commit-unproven');
});

test('REVERSALPROV-01: App attestation cannot authorize a foreign author or conflicting identity trailers', async () => {
  for (const shape of [{ author: { login: 'fixture-builder' } }, { author: null },
    { trailer: 'Worker-Ticket: AMA-PR-8088' }, { trailer: 'Closed-By: fixture-builder' }]) {
    const { evidence, result } = await recommittedReversal({ attested: true, transform: (path, response) => {
      const { trailer, ...identity } = shape;
      if (trailer && path.endsWith(`${base}...${head}`)) return { ...response,
        commits: response.commits.map(commit => commit.sha === head ? { ...commit,
          commit: { ...commit.commit, message: `${commit.commit.message}\n${trailer}` } } : commit) };
      if (!path.endsWith(`/commits/${head}`)) return response;
      return { ...response, ...identity, ...(trailer ? { commit: { ...response.commit,
        message: `${response.commit.message}\n${trailer}` } } : {}) };
    } });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance');
  }
});

test('REVERSALPROV-01: synthetic generated README reversal survives a linked worker rebase', async () => {
  const finding = review({ body: review().body.replace('## Blocking issues', '## Non-blocking issues')
    .replace('## Non-blocking issues\n- None.\n', '')
    .replace('## Non-blocking issues\n', '## Non-blocking issues\n- **Unrelated index**\n'
      + '  - **File:** `other.md`\n  - **Lines:** `1`\n  - **Problem:** Stale index.\n  - **Recommended fix:** Regenerate.\n') });
  const later = review({ node_id: 'PRR_snapshot', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  const { evidence } = await recommittedReversal({ original: true, reviews: [finding, later],
    cites: ['PRR_cited finding=2 kind=non-blocking'],
    transform: (path, response) => {
      // The regenerated bytes survive in the final head at a different position.
      if (path.endsWith(`${base}...${head}`)) response = { ...response,
        files: [{ filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 0,
          patch: '@@ -45,0 +46,2 @@\n+start_unsafe()\n+log_startup()' }] };
      return JSON.parse(JSON.stringify(response)
        .replaceAll('src/a.mjs', 'README.md').replaceAll('start_unsafe()', 'Generated stale declaration')
        .replaceAll('log_startup()', 'Generated stale index').replaceAll('start()', 'Generated current declaration'));
    } });
  assert.equal(evidence.reversalAuthorizations[0].commit.author.login, 'the-hammer-lacey[bot]');
  assert.equal(evidence.reversalAuthorizations[0].commit.committer.login, 'fixture-rebase-worker');
  const addedLines = file => file.patch.split('\n').filter(line => line.startsWith('+'));
  assert.deepEqual(addedLines(evidence.primaryFiles[0]), addedLines(evidence.finalFiles[0]));
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('a superseded authorized reversal survives changed context and hunk coordinates', async () => {
  for (const originalRebased of [false, true]) {
    const { evidence, result } = await snapshotReversal({
      ...(originalRebased ? { originalParent: author, originalLine: 15, snapshotStatus: 'diverged' } : {}),
      transform: (path, response) => {
        if (path.endsWith(`/commits/${head}`)) return withReversalContext(response, 'new_base');
        if (path.endsWith(`/commits/${sha('d')}`)) return withReversalContext(response, 'old_base');
        return response;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(evidence.rejectedReversalAuthorizations, undefined);
    assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, sha('d'));
    assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.rebased === true, originalRebased);
  }
});

test('conflict resolution changing exact removed or added lines still refuses the original proof', async () => {
  for (const rewrite of [
    patch => patch.replace('-start_unsafe()', '-start_unsafe(retry=true)'),
    patch => patch.replace('+start()', '+start_safe()'),
    patch => patch.replace('-start_unsafe()', '- start_unsafe()'),
  ]) {
    const { evidence, result } = await snapshotReversal({ transform: (path, response) => {
      if (!path.endsWith(`/commits/${head}`)) return response;
      const contextual = withReversalContext(response, 'new_base');
      return { ...contextual, files: contextual.files.map(file => ({ ...file, patch: rewrite(file.patch) })) };
    } });
    assert.equal(result.reason, 'primary-change-reverted');
    const rejection = evidence.rejectedReversalAuthorizations[0];
    assert.equal(rejection.reason, 'original-reversal-not-proven-before-supersession');
    assert.match(rejection.detail, /change-line mismatch on paths: src\/a\.mjs/);
    assert.equal(result.missingEvidence.rejected[0].detail, rejection.detail);
    assert.ok(result.missingEvidence.summary.includes(rejection.detail));
  }
});

test('original proof refuses changed hunk/context-run boundaries and removal order', async () => {
  for (const rewrite of [
    patch => patch.replace('@@ -15,2 +15 @@', '@@ -15,2 +15,0 @@')
      .replace('\n+start()', '\n@@ -55,0 +54 @@\n+start()'),
    patch => patch.replace('@@ -15,2 +15 @@', '@@ -15,3 +15,2 @@')
      .replace('\n+start()', '\n unchanged_context()\n+start()'),
    patch => patch.replace('-start_unsafe()\n-log_startup()', '-log_startup()\n-start_unsafe()'),
  ]) {
    const { evidence, result } = await snapshotReversal({ transform: (path, response) =>
      path.endsWith(`/commits/${head}`)
        ? { ...response, files: response.files.map(file => ({ ...file, patch: rewrite(file.patch) })) } : response });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'original-reversal-not-proven-before-supersession');
  }
});

test('original proof ignores context run lengths but retains matching newline markers', async () => {
  const { result: matching } = await snapshotReversal({ transform: (path, response) => {
    if (![head, sha('d')].some(commit => path.endsWith(`/commits/${commit}`))) return response;
    const current = path.endsWith(`/commits/${head}`);
    return { ...response, files: response.files.map(file => ({ ...file,
      patch: `@@ -${current ? '14,4 +14,3' : '9,5 +9,4'} @@ different context\n before()\n-start_unsafe()\n-log_startup()\n ${current ? 'new_context()' : 'old_context()\n another_old_context()'}\n+start()\n\\ No newline at end of file`,
    })) };
  } });
  assert.equal(matching.ok, true);
});

test('original proof binds newline markers to their changed line and side', async () => {
  for (const foreignCommitter of [false, true]) {
    const { evidence, result } = await snapshotReversal({ transform: (path, response) => {
      const current = path.endsWith(`/commits/${head}`);
      if (!current && !path.endsWith(`/commits/${sha('d')}`)) return response;
      return { ...response, ...(current && foreignCommitter ? { committer: { login: 'fixture-rebase-worker' } } : {}),
        files: response.files.map(file => ({ ...file, patch: current
          ? file.patch.replace('-log_startup()', '-log_startup()\n\\ No newline at end of file')
          : `${file.patch}\n\\ No newline at end of file` })) };
    } });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(evidence.rejectedReversalAuthorizations[0].reason,
      foreignCommitter ? 'rebased-commit-unproven' : 'original-reversal-not-proven-before-supersession');
  }
});

test('original proof diagnostics bound paths, aggregate detail and operator summaries', async () => {
  const originals = Array.from({ length: 10 }, (_, index) => (index + 3).toString(16).padStart(40, '0'));
  const { evidence, result } = await snapshotReversal({
    read: async (path, transport) => {
      const candidate = originals.find(commit => path.endsWith(`/commits/${commit}`));
      if (!candidate) return transport(path);
      const original = await transport(`repos/fixture/repo/commits/${sha('d')}`);
      return { ...original, sha: candidate, files: [...original.files,
        ...Array.from({ length: 20 }, (_, index) => ({ ...original.files[0],
          filename: `src/mismatch/${String(index).padStart(2, '0')}-${'long-path-'.repeat(30)}.mjs` }))] };
    },
    transform: (path, response) => path.endsWith(`${reviewedHead}...${sha('f')}`)
      ? { ...response, total_commits: originals.length,
        commits: originals.map(commit => ({ ...response.commits[0], sha: commit })) } : response,
  });
  assert.equal(result.reason, 'primary-change-reverted');
  const rejection = evidence.rejectedReversalAuthorizations[0];
  assert.equal(rejection.reason, 'original-reversal-not-proven-before-supersession');
  assert.equal(rejection.detail.length, 1200);
  assert.ok(rejection.detail.endsWith('...'));
  assert.match(rejection.detail, /\(\+15 more\)/);
  assert.match(rejection.detail, /src\/mismatch\/04-/);
  assert.doesNotMatch(rejection.detail, /src\/mismatch\/05-/);
  assert.ok(result.missingEvidence.summary.includes(rejection.detail));
  evidence.rejectedReversalAuthorizations = Array.from({ length: 10 }, (_, index) => ({ ...rejection, commit: originals[index] }));
  const summary = checkPrimaryChange(evidence, head).missingEvidence.summary;
  assert.equal(summary.length, 4096);
  assert.ok(summary.endsWith('...'));
});

test('original reversal proof retains file path, previous path and status identity', async () => {
  for (const metadata of [{ filename: 'src/other.mjs' }, { previous_filename: 'src/old.mjs' }, { status: 'renamed' }]) {
    const { evidence, result } = await snapshotReversal({ transform: (path, response) =>
      path.endsWith(`/commits/${sha('d')}`)
        ? { ...response, files: response.files.map(file => ({ ...file, ...metadata })) } : response });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.match(evidence.rejectedReversalAuthorizations[0].detail, /change-line mismatch on paths: src\/a\.mjs/);
    if (metadata.filename) assert.ok(evidence.rejectedReversalAuthorizations[0].detail.includes(metadata.filename));
  }
});

test('original proof diagnostics distinguish missing messages, provenance and snapshot checks', async () => {
  for (const [options, detail] of [
    [{ transform: (path, response) => path.endsWith(`${reviewedHead}...${sha('f')}`)
      ? { ...response, commits: response.commits.map(commit => ({ ...commit,
        commit: { ...commit.commit, message: `Different repair\n${commit.commit.message}` } })) } : response },
    /no candidate with the same commit message/],
    [{ transform: (path, response) => path.endsWith(`${reviewedHead}...${sha('f')}`)
      ? { ...response, commits: response.commits.map(commit => ({ ...commit, sha: 'invalid' })) } : response },
    /commit-provenance/],
    [{ originalLogin: 'foreign-builder' }, /commit-provenance/],
    [{ originalParent: sha('9') }, /merge-base-mismatch/],
    [{ snapshotCapped: true }, /incomplete or unsupported superseding snapshot/],
  ]) {
    const { evidence, result } = await snapshotReversal(options);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'original-reversal-not-proven-before-supersession');
    assert.match(evidence.rejectedReversalAuthorizations[0].detail, detail);
    assert.match(result.missingEvidence.summary, detail);
  }
});

test('a mismatched original candidate cannot hide a later valid original', async () => {
  const { evidence, result } = await snapshotReversal({
    read: async (path, transport) => {
      if (!path.endsWith(`/commits/${sha('e')}`)) return transport(path);
      const original = await transport(`repos/fixture/repo/commits/${sha('d')}`);
      return { ...original, sha: sha('e'), files: original.files.map(file => ({ ...file,
        patch: file.patch.replace('+start()', '+different_start()') })) };
    },
    transform: (path, response) => {
      if (path.endsWith(`${reviewedHead}...${sha('f')}`)) return { ...response,
        total_commits: 2, commits: [{ ...response.commits[0], sha: sha('e') }, ...response.commits] };
      return response;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, sha('d'));
});

test('an opaque or malformed original candidate cannot hide a later valid original', async () => {
  for (const patch of [undefined, '', 'malformed patch']) {
    const { evidence, result } = await snapshotReversal({
      read: async (path, transport) => {
        if (!path.endsWith(`/commits/${sha('e')}`)) return transport(path);
        const original = await transport(`repos/fixture/repo/commits/${sha('d')}`);
        return { ...original, sha: sha('e'), files: original.files.map(file => ({ ...file, patch })) };
      },
      transform: (path, response) => path.endsWith(`${reviewedHead}...${sha('f')}`)
        ? { ...response, total_commits: 2,
          commits: [{ ...response.commits[0], sha: sha('e') }, ...response.commits] } : response,
    });
    assert.equal(result.ok, true);
    assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, sha('d'));
  }
});

test('opaque or malformed original candidates alone refuse the proof with candidate diagnostics', async () => {
  for (const patch of [undefined, '', 'malformed patch']) {
    const { evidence, result } = await snapshotReversal({ transform: (path, response) =>
      path.endsWith(`/commits/${sha('d')}`)
        ? { ...response, files: response.files.map(file => ({ ...file, patch })) } : response });
    assert.equal(result.reason, 'primary-change-reverted');
    const rejection = evidence.rejectedReversalAuthorizations[0];
    assert.equal(rejection.reason, 'original-reversal-not-proven-before-supersession');
    assert.match(rejection.detail, /opaque or malformed original patch/);
    assert.match(result.missingEvidence.summary, /opaque or malformed original patch/);
  }
});

test('finding coverage uses reviewed coordinates after a rebase and still refuses uncovered regions', async () => {
  for (const shift of [0, 5, 8]) {
    const covered = await collect({ shift });
    assert.equal(covered.result.ok, true);
    const narrow = review({ body: review().body.replace('`10-11`', '`11`') });
    const uncovered = await collect({ shift, reviews: [narrow] });
    assert.equal(uncovered.result.reason, 'primary-change-reverted');
    assert.deepEqual(uncovered.result.missingEvidence.rejected.map(entry => entry.reason), ['finding-does-not-cover-region']);
  }
});

test('rebased context does not change commit provenance requirements', async () => {
  for (const scenario of ['linked', 'foreign', 'verified-web-flow', 'unsigned-web-flow']) {
    const { evidence, result } = await snapshotReversal({ reviews: [review()], transform: (path, response) => {
      if (!path.endsWith(`/commits/${head}`)) return response;
      const contextual = withReversalContext(response, 'new_base');
      if (scenario === 'foreign') return { ...contextual, author: { login: 'fixture-builder' } };
      if (scenario.endsWith('web-flow')) return { ...contextual, committer: { login: 'web-flow' },
        commit: { ...contextual.commit, verification: { verified: scenario === 'verified-web-flow', reason: 'valid' } } };
      return contextual;
    } });
    if (['linked', 'verified-web-flow'].includes(scenario)) assert.equal(result.ok, true, scenario);
    else {
      assert.equal(result.reason, 'primary-change-reverted', scenario);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance', scenario);
    }
  }
});

test('context drift leaves the unsuperseded and unrebased authorization paths unchanged', async () => {
  for (const rebased of [false, true]) {
    const { evidence, result } = await snapshotReversal({ reviews: [review()], shift: rebased ? 5 : 0,
      read: (path, transport) => {
        if (!rebased && [author, reviewedHead].some(from => path.endsWith(`${from}...${reviewedHead}`))) return { status: 'identical' };
        return transport(path);
      },
      transform: (path, response) => {
        if (path.endsWith(`/commits/${head}`)) {
          const contextual = withReversalContext(response, 'nearby_base');
          return rebased ? contextual : { ...contextual, parents: [{ sha: reviewedHead }] };
        }
        if (!rebased && path.endsWith(`${base}...${reviewedHead}`)) return { ...response,
          merge_base_commit: { sha: base }, files: response.files.filter(file => file.filename === 'src/a.mjs') };
        return response;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(evidence.reversalAuthorizations[0].rebased === true, rebased);
    assert.equal(evidence.reversalAuthorizations[0].originalAuthorization, undefined);
  }
});

test('HAMREVERSAL-01: API-published reversal uses verification from the re-read commit', async () => {
  const { transport } = await collect();
  for (const verified of [true, false]) {
    const reads = [];
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
      get: async path => {
        reads.push(path);
        const response = await transport(path);
        if (path.endsWith(`/commits/${head}`)) return { ...response, committer: { login: 'web-flow' },
          commit: { ...response.commit, verification: { verified, reason: 'valid' } } };
        // The compare response deliberately retains the old identity shape;
        // only the individual commit read supplies API verification.
        return response;
      } }, { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.ok(reads.includes(`repos/fixture/repo/commits/${head}`));
    const result = checkPrimaryChange(evidence, head);
    if (verified) {
      assert.equal(evidence.reversalAuthorizations.length, 1);
      assert.equal(evidence.reversalAuthorizations[0].commit.commit.verification.verified, true);
      assert.equal(result.ok, true);
    } else {
      assert.equal(evidence.reversalAuthorizations, undefined);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance');
      assert.equal(result.reason, 'primary-change-reverted');
    }
  }
});

test('HAM reversal hydrates exact-commit verification from the bounded history reader', async () => {
  const { transport } = await collect();
  for (const scenario of ['valid', 'invalid', 'invalid-reason', 'foreign-author', 'wrong-sha', 'unreadable']) {
    const verificationReads = [];
    const get = async path => {
      const response = await transport(path);
      if (!path.endsWith(`/commits/${head}`)) return response;
      // createHistoryReader intentionally leaves verification out of commitFields.
      const { verification: _verification, ...commit } = response.commit;
      return { ...response, ...(scenario === 'foreign-author' ? { author: { login: 'foreign-builder' } } : {}),
        committer: { login: 'web-flow' }, commit };
    };
    get.commitVerification = async path => {
      verificationReads.push(path);
      if (scenario === 'unreadable') throw new Error('verification unavailable');
      return { sha: scenario === 'wrong-sha' ? sha('d') : head,
        verification: { verified: scenario !== 'invalid', reason: scenario === 'invalid-reason' ? 'unsigned' : 'valid' } };
    };
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get },
      { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    const result = checkPrimaryChange(evidence, head);
    assert.deepEqual(verificationReads, [`repos/fixture/repo/commits/${head}`], scenario);
    assert.equal(result.ok, scenario === 'valid', scenario);
    if (scenario === 'valid') {
      assert.equal(evidence.reversalAuthorizations[0].commit.commit.verification.verified, true);
    } else {
      assert.equal(result.reason, 'primary-change-reverted', scenario);
      assert.equal(evidence.reversalAuthorizations, undefined, scenario);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason,
        scenario === 'unreadable' ? 'unverifiable' : 'commit-provenance', scenario);
    }
  }
});

test('historical reversal snapshots hydrate their own web-flow verification', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  const { transport } = await collect({ originalRecorded: true, reviews: [review(), later] });
  for (const scenario of ['valid', 'invalid', 'wrong-sha', 'unreadable']) {
    const get = async path => {
      const response = await transport(path);
      if (!path.endsWith(`/commits/${sha('d')}`)) return response;
      const { verification: _verification, ...commit } = response.commit;
      return { ...response, committer: { login: 'web-flow' }, commit };
    };
    get.commitVerification = async path => {
      assert.equal(path, `repos/fixture/repo/commits/${sha('d')}`);
      if (scenario === 'unreadable') throw new Error('verification unavailable');
      return { sha: scenario === 'wrong-sha' ? head : sha('d'),
        verification: { verified: scenario !== 'invalid', reason: 'valid' } };
    };
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get },
      { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.equal(checkPrimaryChange(evidence, head).ok, scenario === 'valid', scenario);
    if (scenario !== 'valid') {
      assert.equal(evidence.reversalAuthorizations, undefined, scenario);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason,
        scenario === 'wrong-sha' ? 'commit-provenance' : scenario === 'unreadable' ? 'unverifiable'
          : 'original-reversal-not-proven-before-supersession', scenario);
    }
  }
});

test('an authorized HAM reversal stays authorized after the branch is rebased onto a newer base', async () => {
  const { evidence, result } = await collect();
  assert.equal(evidence.reversalAuthorizations.length, 1);
  assert.equal(evidence.reversalAuthorizations[0].rebased, true);
  assert.deepEqual(result, { ok: true, applicable: true, testRegionsChanged: [] });
});

test('a conflict-owner rebase then a hammer rebase keep the authorization, past a later review', async () => {
  // Two base moves (5 then 3 lines) and the post-reversal re-review on the
  // conflict-owner head with zero blocking findings, submitted after the HAM commit.
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED', submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' });
  const { result } = await collect({ shift: 8, reviews: [review(), later], originalRecorded: true });
  assert.equal(result.ok, true);
});

test('a trailer naming a review that is not on this pull request is rejected and named', async () => {
  for (const cites of [['PRR_other_pr finding=1 kind=blocking'], ['PRR_cited finding=2 kind=blocking']]) {
    const { result } = await collect({ cites });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.missingEvidence.evidence, 'reversal-authorization');
    assert.equal(result.missingEvidence.path, 'src/a.mjs');
  }
  const { evidence, result } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['review-not-on-this-pull-request']);
  assert.match(result.missingEvidence.summary, /PRR_other_pr finding=1 kind=blocking .*review-not-on-this-pull-request/);
});

test('a rebased reversal whose protected patch differs from the reviewed one is rejected', async () => {
  // The conflict resolution rewrote the author line the finding was about.
  assert.equal((await collect({ rebasedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  assert.equal((await collect({ reviewedAdded: '+start_unsafe(retry=True)' })).result.reason, 'primary-change-reverted');
  // The finding must still cover the matched region in the reviewed head.
  const narrow = review({ body: review().body.replace('`10-11`', '`11`') });
  assert.equal((await collect({ reviews: [narrow] })).result.reason, 'primary-change-reverted');
});

test('identical segments must be unique in both primary and reviewed diffs', async () => {
  for (const options of [{ duplicatePrimary: true }, { duplicateReviewed: true }]) {
    const { evidence, result } = await collect(options);
    if (options.duplicatePrimary) {
      // Both repeated primary regions were touched by the hammer, while only
      // one reviewed region has a finding. Touching both cannot extend it.
      const files = evidence.reversalAuthorizations[0].commit.files;
      files[0] = { ...files[0], additions: 2, deletions: 4,
        patch: `${files[0].patch}\n${files[0].patch.replace('15,2 +15', '45,2 +45')}` };
    }
    const checked = checkPrimaryChange(evidence, head);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(checked.reason, 'primary-change-reverted');
    assert.match(checked.missingEvidence.summary, /patch differs or is ambiguous/);
  }
});

test('evaluator diagnostics explain nonexistent findings, patch mismatches and line coverage failures', async () => {
  for (const [options, reason] of [
    [{ cites: ['PRR_cited finding=2 kind=blocking'] }, 'finding-not-found'],
    [{ rebasedAdded: '+start_unsafe(retry=True)' }, 'rebased protected region patch differs or is ambiguous'],
    [{ reviews: [review({ body: review().body.replace('`10-11`', '`11`') })] }, 'finding-does-not-cover-region'],
  ]) {
    const { result } = await collect(options);
    assert.equal(result.missingEvidence.accepted, 0);
    assert.deepEqual(result.missingEvidence.rejected.map((entry) => entry.reason), [reason]);
    assert.ok(result.missingEvidence.summary.includes(reason));
  }
});

test('a historical snapshot must bind the same reversal patch, provenance and original coverage', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' });
  for (const options of [{ originalRecorded: false }, { originalAdded: '-other_change()' },
    { originalLogin: 'foreign-builder' }, { originalParent: sha('9') }, { originalLine: 45 }, { snapshotCapped: true }]) {
    const { result } = await collect({ originalRecorded: true, reviews: [review(), later], ...options });
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(options));
  }
  const { result } = await collect({ originalRecorded: true, reviews: [review(), later],
    authoredAt: '2026-10-11T17:10:00Z' });
  assert.equal(result.ok, true);
});

test('an unauthorized rebased reversal still stops the hammer and names the missing authorization', async () => {
  const { evidence, result } = await collect({ cites: [] });
  assert.equal(evidence.reversalAuthorizations, undefined);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 0);
  assert.match(result.missingEvidence.summary, /no verified Reversal-Authorized-By covers the reverted src\/a\.mjs region \(0 verified\)/);
});

test('a superseded citation needs an immutable original reversal, even with a preserved author date', async () => {
  const superseding = review({ node_id: 'PRR_newer', commit_id: sha('9'), submitted_at: '2026-10-11T17:15:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const cases = [{ reviews: [review(), superseding] },
    { reviews: [review(), superseding], authoredAt: '2026-10-11T17:10:00Z' }];
  for (const options of cases) {
    const { evidence, result } = await collect(options);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(options));
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason), ['original-reversal-not-proven-before-supersession']);
  }
  // Worker-controlled dates have no role in a still-current authorization.
  for (const authoredAt of ['not a date', '2026-10-11T16:00:00Z']) {
    assert.equal((await collect({ authoredAt })).result.ok, true);
  }
  // Another family stacking on the same reviewed head does not supersede it.
  const stacked = review({ node_id: 'PRR_gemini', user: { login: 'lacey-gemini-reviewer[bot]' }, submitted_at: '2026-10-11T17:10:00Z' });
  assert.equal((await collect({ reviews: [review(), stacked] })).result.ok, true);
});

test('only a review head that diverged from the HAM parent may use the rebase path', async () => {
  // "behind": the cited head descends from the HAM parent, which no rebase produces.
  for (const reviewToParent of ['behind', 'unknown']) {
    const { evidence, result } = await collect({ reviewToParent });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.deepEqual(evidence.rejectedReversalAuthorizations.map(({ reason }) => reason),
      [reviewToParent === 'behind' ? 'review-not-current' : 'unverifiable']);
  }
});

test('HAMNOREREVIEW-01 missing reversal authorization retains the safety hold without review', async () => {
  const { result: primary } = await collect({ cites: ['PRR_other_pr finding=1 kind=blocking'] });
  const checks = { workerClass: true, head: true, parent: true, commitIdentity: true, nonEmptyCommit: true, primaryChange: false };
  const trace = { primaryChange: primary, hamTerminalRemediation: { active: true, checks } };
  const missingEvidence = primaryChangeExactReviewEvidence(trace);
  assert.equal(missingEvidence, primary.missingEvidence);
  for (const other of [{ ...checks, parent: false }, { ...checks, primaryChange: true }]) {
    assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: true, checks: other } }), null);
  }
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, hamTerminalRemediation: { active: false, checks } }), null);
  assert.equal(primaryChangeExactReviewEvidence({ ...trace, primaryChange: { ...primary,
    missingEvidence: { ...primary.missingEvidence, evidence: 'rename-preservation' } } }), null);

  const refusal = { dispatched: false, skipMergeAgent: true, reason: 'primary-change-repair-required', needsOperator: true,
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'primary-change-reverted'] };
  const requests = [];
  const logs = [];
  const recover = (result, extra = {}) => recoverStrandedCloserHead({ result, closerAuthored: true, rootDir: '/fixture',
    repo: 'fixture/repo', prNumber: 8088, headSha: head, logger: { log: (line) => logs.push(line), warn() {} },
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    requestBoundedReviewImpl: async (options) => { requests.push(options.headSha); return { triggered: true }; }, ...extra });
  const recovered = await recover({ ...refusal, missingEvidence, exactHeadReview: true });
  assert.equal(recovered, null, 'primary-change preservation remains a hold');
  assert.deepEqual(requests, []);
  assert.deepEqual(logs, []);
  // Without that proof, or with any other co-occurring refusal, the operator hold stays.
  for (const result of [refusal, { ...refusal, missingEvidence, exactHeadReview: true, reasons: [...refusal.reasons, 'ci-not-green'] },
    { ...refusal, missingEvidence, exactHeadReview: true, reasons: ['primary-change-reverted'] },
    { ...refusal, reason: 'primary-change-needs-operator', missingEvidence, exactHeadReview: true }]) {
    assert.equal(await recover(result), null);
  }
  // A live owner still wins.
  assert.equal(await recover({ ...refusal, missingEvidence, exactHeadReview: true },
    { probeOwnershipImpl: async () => ({ owned: true, uncertain: false }) }), null);
  assert.equal(requests.length, 0);
});

// The original reversal itself was already
// rebased when its immutable superseding review was posted.
test('HAMCLOSE-02 an original rebased App reversal survives a diverged superseding snapshot', async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const options = { reviews: [review(), later], originalRecorded: true,
    originalParent: author, originalLine: 15, snapshotStatus: 'diverged' };
  assert.equal((await collect(options)).result.ok, true);
  for (const forged of [{ cites: [] }, { cites: ['PRR_missing finding=1'] },
    { cites: ['PRR_cited finding=99'] }, { hammerLogin: 'builder' },
    { reviews: [review({ user: { login: 'builder' } }), later] },
    { rebasedAdded: '+builder_intervened()' }]) {
    assert.equal((await collect({ ...options, ...forged })).result.ok, false, JSON.stringify(forged));
  }
});

for (const opaque of [
  { filename: 'asset.png', status: 'modified', additions: 0, deletions: 0, sha: sha('8') },
  { filename: 'renamed.mjs', previous_filename: 'old.mjs', status: 'renamed', additions: 0, deletions: 0 },
]) test(`opaque ${opaque.filename} rebase proof declines only its original snapshot`, async () => {
  const later = review({ node_id: 'PRR_later', commit_id: sha('f'), submitted_at: '2026-10-11T19:10:00Z',
    body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved', state: 'APPROVED' });
  const { transport } = await collect({ reviews: [review(), later], originalRecorded: true,
    originalParent: author, originalLine: 15, snapshotStatus: 'diverged' });
  const original = await transport(`repos/fixture/repo/commits/${sha('d')}`);
  const opaqueOriginal = { ...original, sha: sha('9'), parents: [{ sha: sha('e') }] };
  const parent = await transport(`repos/fixture/repo/compare/${base}...${author}`);
  for (const validFallback of [false, true]) {
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 8088, headSha: head,
      get: async path => {
        if (path.endsWith(`${reviewedHead}...${sha('f')}`)) return { status: 'diverged',
          commits: validFallback ? [opaqueOriginal, original] : [opaqueOriginal], total_commits: validFallback ? 2 : 1 };
        if (path.endsWith(`/commits/${opaqueOriginal.sha}`)) return opaqueOriginal;
        if (path.endsWith(`${reviewedHead}...${sha('e')}`)) return { status: 'diverged' };
        if (path.endsWith(`${base}...${sha('e')}`)) return { ...parent, files: [...parent.files, opaque] };
        return transport(path);
      } }, { fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }) });
    assert.equal(evidence.hasHammerCommits, true, 'opaque evidence must not become a history read failure');
    assert.equal(evidence.readFailed, undefined);
    if (validFallback) {
      assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.commit.sha, original.sha);
      assert.equal(checkPrimaryChange(evidence, head).ok, true);
    } else {
      assert.equal(evidence.reversalAuthorizations, undefined);
      assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'original-reversal-not-proven-before-supersession');
      assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
    }
  }
});

test('unsigned unlinked author with copied hammer trailers and hammer committer is refused', async () => {
  const { evidence, result } = await collect({ nullAuthor: true });
  assert.equal(result.ok, false);
  assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'commit-provenance');
});

test('a rebased builder with unlinked author and hammer committer remains a builder', async () => {
  const { evidence, result } = await collect({ nullAuthor: true, builderOnly: true });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(result.ok, true);
});

test('REVERSALPROV-02: rebase proof ignores context while retaining changed-content coverage', async () => {
  assert.equal((await collect({ parentContext: '\n context_elsewhere', reviewedContext: '\n original_context' })).result.ok, true);
  assert.equal((await collect({ parentExtraHunk: true })).result.reason, 'primary-change-reverted');
});

test('unrelated mainline files in a diverged compare do not change authorization', async () => {
  assert.deepEqual((await collect({ unrelated: true })).result, (await collect({ unrelated: false })).result);
});

test('synthetic transport throws on an unrecorded path', async () => {
  const { transport } = await collect();
  await assert.rejects(transport('repos/fixture/repo/unrecorded'), /unexpected/);
});

test('unlinked rebased reversal requires an exact SHA in the authenticated App comment', async () => {
  assert.equal((await collect({ nullAuthor: true, attestationAuthor: 'the-hammer-lacey[bot]' })).result.ok, true);
  for (const options of [{ attestationAuthor: 'builder' },
    { attestationAuthor: 'the-hammer-lacey[bot]', attestationHead: '9'.repeat(40) }]) {
    assert.equal((await collect({ nullAuthor: true, ...options })).result.ok, false);
  }
});


test('operator attribution uses the effective non-blocking policy', async () => {
  const nonBlocking = review({ body: review().body.replace('## Blocking issues', '## Non-blocking issues')
    .replace('## Non-blocking issues\n- None.\n', '') });
  const { transport } = await collect({ reviews: [nonBlocking], cites: ['PRR_cited finding=1 kind=non-blocking'] });
  for (const strictNonBlockingRemediation of [true, false]) {
    let diagnosticReads = 0;
    const evidence = await fetchPrimaryChangeContext({ repo: 'fixture/repo', prNumber: 8088, headSha: head, get: transport }, {
      strictNonBlockingRemediation,
      fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
      createDiagnosticReaderImpl: () => async path => { diagnosticReads++; return transport(path); },
    });
    const result = checkPrimaryChange(evidence, head, { strictNonBlockingRemediation });
    assert.equal(result.ok, strictNonBlockingRemediation);
    assert.equal(diagnosticReads > 0, !strictNonBlockingRemediation);
    assert.equal(Boolean(evidence.revertedRegionDiagnostics), !strictNonBlockingRemediation);
  }
});

test('refused-region sweep cannot add accepted or rejected authorization evidence', async () => {
  const { evidence } = await collect({ duplicatePrimary: true });
  const authorization = evidence.reversalAuthorizations[0];
  authorization.rebased = false;
  authorization.reviewedFiles = evidence.primaryFiles;
  authorization.parentFiles = evidence.primaryFiles;
  authorization.review.body = review().body.replace('`10-11`', '`45-46`');
  authorization.commit.files[0].patch = authorization.commit.files[0].patch.replace('15,2 +15', '45,2 +45');
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 0);
  assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['finding-does-not-cover-region']);
  assert.deepEqual(result.missingEvidence.regions, [{ start: 15, end: 16 }]);
});

test('REVERSALPROV-02: cited non-blocking cleanup survives shifted context and commit coordinates', async () => {
  const nonBlocking = review({ body: review().body.replace('## Blocking issues', '## Non-blocking issues')
    .replace('## Non-blocking issues\n- None.\n', '') });
  const { evidence } = await collect({ reviews: [nonBlocking], cites: ['PRR_cited finding=1 kind=non-blocking'],
    parentContext: '\n shifted_context()', reviewedContext: '\n previous_context()' });
  const authorization = evidence.reversalAuthorizations[0];
  authorization.commit = withReversalContext(authorization.commit, 'shifted');
  assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
  const uncited = { ...evidence, reversalAuthorizations: [] };
  const refused = checkPrimaryChange(uncited, head, { strictNonBlockingRemediation: true });
  assert.equal(refused.reason, 'primary-change-reverted');
  assert.equal(refused.missingEvidence.accepted, 0);
  assert.match(refused.missingEvidence.summary, /no verified Reversal-Authorized-By/);
});

test('REVERSALPROV-02: partial or unrelated removed content cannot authorize the whole region', async () => {
  for (const patch of [
    '@@ -15 +15 @@\n-start_unsafe()\n+start()',
    '@@ -15,2 +15 @@\n-start_unsafe()\n-other_line()\n+start()',
    '@@ -15,0 +16 @@\n+start()',
  ]) {
    const { evidence } = await collect();
    const file = evidence.reversalAuthorizations[0].commit.files[0];
    file.patch = patch;
    file.deletions = patch.split('\n').filter(line => line.startsWith('-')).length;
    const result = checkPrimaryChange(evidence, head);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.missingEvidence.accepted, 0);
    assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['hammer-patch-does-not-touch-region']);
  }
});

test('REVERSALPROV-02: removal matching retains duplicate-line multiplicity', async () => {
  const { evidence: original } = await collect();
  const evidence = JSON.parse(JSON.stringify(original).replaceAll('log_startup()', 'start_unsafe()'));
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  const file = evidence.reversalAuthorizations[0].commit.files[0];
  file.patch = '@@ -15 +15 @@\n-start_unsafe()\n+start()';
  file.deletions = 1;
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

test('REVERSALPROV-02: a cited region leaves the uncited removed remainder protected', async () => {
  const { evidence } = await collect();
  const authorization = evidence.reversalAuthorizations[0];
  const extra = (files, line) => files.map(file => ({ ...file, additions: file.additions + 1, deletions: file.deletions + 1,
    patch: `${file.patch}\n@@ -${line} +${line + 1} @@\n-old_second()\n+new_second()` }));
  evidence.primaryFiles = extra(evidence.primaryFiles, 35);
  authorization.parentFiles = evidence.primaryFiles;
  authorization.reviewedFiles = extra(authorization.reviewedFiles, 30);
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 1);
  assert.deepEqual(result.missingEvidence.regions, [{ start: 35, end: 36 }]);
  assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['finding-does-not-cover-region']);
});

test('REVERSALPROV-02: uncited insertion reversals refuse with or without a final file diff', async () => {
  const { evidence } = await collect({ cites: [] });
  for (const finalFiles of [[], [{ filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -45,0 +46 @@\n+unrelated()' }]]) {
    const result = checkPrimaryChange({ ...evidence, finalFiles,
      primaryFiles: [{ filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 0,
        patch: '@@ -15,0 +16,2 @@\n+synthetic_entry_one()\n+synthetic_entry_two()' }] }, head);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.deepEqual(result.missingEvidence.regions, [{ start: 16, end: 16 }]);
  }
});

test('REVERSALPROV-02: one removed occurrence cannot authorize two protected regions', async () => {
  const { evidence } = await collect();
  const authorization = evidence.reversalAuthorizations[0];
  authorization.review.body = authorization.review.body.replace('`10-11`', '`10-31`');
  const extra = (files, line) => files.map(file => ({ ...file, additions: file.additions + 1, deletions: file.deletions + 1,
    patch: `${file.patch}\n@@ -${line} +${line + 1} @@\n-old_second()\n+start_unsafe()` }));
  evidence.primaryFiles = extra(evidence.primaryFiles, 35);
  authorization.parentFiles = evidence.primaryFiles;
  authorization.reviewedFiles = extra(authorization.reviewedFiles, 30);
  // Disk cache hydration may duplicate the same commit object across citations.
  evidence.reversalAuthorizations.push(structuredClone(authorization));
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
  evidence.reversalAuthorizations.pop();
  const file = authorization.commit.files[0];
  file.patch += '\n@@ -36 +35,0 @@\n-start_unsafe()';
  file.deletions++;
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
});

test('REVERSALPROV-02: original newline marker count remains part of the content proof', async () => {
  const { evidence, result } = await snapshotReversal({ transform: (path, response) =>
    path.endsWith(`/commits/${head}`) ? { ...response, files: response.files.map(file => ({ ...file,
      patch: `${file.patch}\n\\ No newline at end of file` })) } : response });
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(evidence.rejectedReversalAuthorizations[0].reason, 'original-reversal-not-proven-before-supersession');
});

test('REVERSALPROV-02: cited restoration of a primary deletion retains its existing authorization', async () => {
  const { evidence } = await collect();
  const authorization = evidence.reversalAuthorizations[0];
  const deletion = line => [{ filename: 'src/a.mjs', status: 'modified', additions: 0, deletions: 1,
    patch: `@@ -${line} +${line - 1},0 @@\n-start()` }];
  evidence.primaryFiles = deletion(15);
  authorization.parentFiles = evidence.primaryFiles;
  authorization.reviewedFiles = deletion(10);
  authorization.commit.files = [{ filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -14,0 +15 @@\n+start()' }];
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  authorization.commit.files[0].patch = '@@ -14,0 +15 @@\n+other()';
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});

function insertionReversal(evidence, { rebased = true, line = 15, reviewedLine = 10 } = {}) {
  const insertion = old => [{ filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 0,
    patch: `@@ -${old},0 +${old + 1},2 @@\n+introduced_one()\n+introduced_two()` }];
  evidence.primaryFiles = insertion(line);
  evidence.finalFiles = [];
  const authorization = evidence.reversalAuthorizations[0];
  Object.assign(authorization, { rebased, parentFiles: evidence.primaryFiles,
    reviewedFiles: insertion(rebased ? reviewedLine : line) });
  const first = (rebased ? reviewedLine : line) + 1;
  authorization.review.body = review().body.replace('`10-11`', `\`${first}-${first + 1}\``);
  authorization.commit.files = [{ filename: 'src/a.mjs', status: 'modified', additions: 0, deletions: 2,
    patch: `@@ -${line + 1},2 +${line},0 @@\n-introduced_one()\n-introduced_two()` }];
  return authorization;
}

test('REVERSALPROV-02: insertion reversal requires a full citation and removal multiset across rebases', async () => {
  for (const options of [{}, { rebased: false }, { line: 0, reviewedLine: 0 }]) {
    const { evidence } = await collect();
    const authorization = insertionReversal(evidence, options);
    assert.equal(checkPrimaryChange(evidence, head).ok, true, JSON.stringify(options));
    assert.equal(checkPrimaryChange({ ...evidence, reversalAuthorizations: [] }, head).reason, 'primary-change-reverted');
    const body = authorization.review.body;
    authorization.review.body = body.replace(/(\*\*Lines:\*\* `\d+)-\d+`/, '$1`');
    assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
    authorization.review.body = body;
    const line = (options.line ?? 15) + 1;
    for (const patch of [`@@ -${line} +${line - 1},0 @@\n-introduced_one()`,
      `@@ -${line},2 +${line - 1},0 @@\n-introduced_one()\n-unrelated()`]) {
      authorization.commit.files[0].patch = patch;
      authorization.commit.files[0].deletions = patch.split('\n').filter(line => line.startsWith('-')).length;
      const result = checkPrimaryChange(evidence, head);
      assert.equal(result.reason, 'primary-change-reverted');
      assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['hammer-patch-does-not-touch-region']);
    }
  }
});

test('REVERSALPROV-02: insertion removal matching retains duplicate-line multiplicity', async () => {
  const { evidence } = await collect();
  insertionReversal(evidence);
  const duplicated = JSON.parse(JSON.stringify(evidence).replaceAll('introduced_two()', 'introduced_one()'));
  assert.equal(checkPrimaryChange(duplicated, head).ok, true);
  const file = duplicated.reversalAuthorizations[0].commit.files[0];
  file.patch = '@@ -16 +15,0 @@\n-introduced_one()';
  file.deletions = 1;
  assert.equal(checkPrimaryChange(duplicated, head).reason, 'primary-change-reverted');
});

test('REVERSALPROV-02: a cited insertion cannot waive a distinct uncited insertion', async () => {
  const { evidence } = await collect();
  const authorization = insertionReversal(evidence);
  const extra = (files, line) => files.map(file => ({ ...file, additions: file.additions + 1,
    patch: `${file.patch}\n@@ -${line},0 +${line + 3} @@\n+uncited()` }));
  evidence.primaryFiles = extra(evidence.primaryFiles, 35);
  authorization.parentFiles = evidence.primaryFiles;
  authorization.reviewedFiles = extra(authorization.reviewedFiles, 30);
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.missingEvidence.accepted, 1);
  assert.deepEqual(result.missingEvidence.regions, [{ start: 36, end: 36 }]);
});

test('REVERSALPROV-02: mixed replacements allow cited restoration of deleted base lines', async () => {
  const { evidence } = await collect();
  const authorization = evidence.reversalAuthorizations[0];
  // Retain both introduced lines, but restore the author's deleted baseline.
  evidence.finalFiles = [{ filename: 'src/a.mjs', status: 'modified', additions: 2, deletions: 0,
    patch: '@@ -15,0 +16,2 @@\n+start_unsafe()\n+log_startup()' }];
  authorization.commit.files = [{ filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -14,0 +15 @@\n+start()' }];
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  authorization.commit.files[0].patch = '@@ -14,0 +15 @@\n+unrelated()';
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.deepEqual(result.missingEvidence.rejected.map(entry => entry.reason), ['hammer-patch-does-not-touch-region']);
});

test('REVERSALPROV-02: rebase segments distinguish identical deletions with distinct additions', async () => {
  const { evidence } = await collect();
  const authorization = evidence.reversalAuthorizations[0];
  const extra = (files, line) => files.map(file => ({ ...file, additions: file.additions + 1, deletions: file.deletions + 1,
    patch: `${file.patch}\n@@ -${line} +${line + 1} @@\n-start()\n+distinct()` }));
  evidence.primaryFiles = extra(evidence.primaryFiles, 35);
  authorization.parentFiles = evidence.primaryFiles;
  authorization.reviewedFiles = extra(authorization.reviewedFiles, 30);
  evidence.finalFiles = [{ filename: 'src/a.mjs', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -35 +35 @@\n-start()\n+distinct()' }];
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  // Truly identical segments are still ambiguous and fail closed.
  evidence.primaryFiles = evidence.primaryFiles.map(file => ({ ...file, additions: file.additions + 1,
    patch: file.patch.replace('+distinct()', '+start_unsafe()\n+log_startup()') }));
  assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
});
