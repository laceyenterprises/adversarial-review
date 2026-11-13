// HAMCONFLICTCUSTODY-01: conflict repair never needs the PR branch's checkout slot.
//
// The hammer worktree can share its git directory with a builder's linked
// worktree that still holds the PR branch. `git checkout <branch>` is refused
// there, so every such repair stopped at conflict-checkout-failed. The repair
// now runs on a detached HEAD at the fetched PR head and publishes with
// HEAD:refs/heads/<branch> leased on the source it replayed.
//
// The fixture is synthetic: a bare origin, a shared clone, a builder linked
// worktree on the PR branch (with an unpushed commit) and a detached hammer
// linked worktree. The real conflict repair and the real rendered publication
// phase run against real git; only GitHub reads, the bounded-step wrapper,
// provenance and the shared resolver are stubbed at the process boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import {
  CONFLICT_PUBLISH_FILE, conflictPublishBinding, parseConflictPublishBinding,
} from '../src/ama/hammer-conflict-binding.mjs';

const root = resolve(import.meta.dirname, '..');
const template = readFileSync(join(root, 'templates/hammer-prompt.md'), 'utf8');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const TOKEN_VARIABLES = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN',
  'HAMMER_LACEY_GH_TOKEN_EXPIRES_AT', 'MERGE_AGENT_GH_TOKEN_EXPIRES_AT',
  'HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND', 'MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND',
  'HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND',
];

const fakeNode = realNode => `#!/bin/bash
log() { printf '%s\\n' "$*" >> "$FIXTURE_LOG"; }
path="$1"; shift
case "$(basename "$path")" in
  hammer-helper-step.mjs) shift 4; exec "$@" ;;
  metered-gh.mjs) [ "$1" = exec-git ] || exit 97; shift; log "git $*"; exec git "$@" ;;
  hammer-pr-read.mjs)
    case " $* " in
      *' baseRefName '*) echo main ;;
      *' headRefName '*) echo feature ;;
      *) exit 97 ;;
    esac ;;
  load-aware-timeout.mjs) echo 30 ;;
  hammer-terminal-audit.mjs) log "terminal-audit $*" ;;
  hammer-progress.mjs) log "progress $*" ;;
  hammer-pushed-attestation.mjs) log "pushed-attestation $*" ;;
  *) exec ${shellQuote(realNode)} "$path" "$@" ;;
esac
`;

// The PR read the API publisher makes. FIXTURE_LIVE_HEAD pins a stale answer.
const fakeGh = `#!/bin/sh
[ "$1" = api ] || exit 97
case "$2" in */pulls/42) ;; *) exit 97 ;; esac
if [ -s "$FIXTURE_LIVE_HEAD" ]; then sha=$(cat "$FIXTURE_LIVE_HEAD")
else sha=$(git --git-dir="$FIXTURE_ORIGIN" rev-parse refs/heads/feature) || exit 1; fi
printf '{"head":{"ref":"feature","sha":"%s"}}\\n' "$sha"
`;

function custodyFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hamconflictcustody-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, 'fake-bin');
  const run = join(dir, 'run');
  mkdirSync(fakeBin); mkdirSync(run, { mode: 0o700 });
  writeFileSync(join(dir, 'gitconfig'), '');
  const log = join(dir, 'events.log');
  const origin = join(dir, 'origin.git');
  const liveHeadFile = join(dir, 'live-head');
  const env = {
    PATH: `${fakeBin}:/usr/bin:/bin`, HOME: dir, TMPDIR: run, FIXTURE_LOG: log,
    FIXTURE_ORIGIN: origin, FIXTURE_LIVE_HEAD: liveHeadFile,
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid',
  };
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\nexec ${shellQuote(realGit)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'node'), fakeNode(process.execPath), { mode: 0o755 });
  writeFileSync(join(fakeBin, 'gh'), fakeGh, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'hq'), `#!/bin/bash
printf 'hq %s\\n' "$*" >> "$FIXTURE_LOG"
[ "$1 $2 $3" = "generated-conflicts resolve --worktree" ] || exit 97
exec git -C "$4" rebase --continue
`, { mode: 0o755 });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });

  // Synthetic PR: a feature commit that conflicts with a later base commit.
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', origin, 'author');
  const author = join(dir, 'author');
  writeFileSync(join(author, 'example.txt'), 'one\ntwo\nthree\n');
  git(author, 'add', 'example.txt'); git(author, 'commit', '-qm', 'Synthetic base');
  git(author, 'push', '-q', 'origin', 'main');
  git(author, 'checkout', '-qb', 'feature');
  writeFileSync(join(author, 'example.txt'), 'one\ntwo feature\nthree\n');
  git(author, 'commit', '-qam', 'Synthetic feature change');
  git(author, 'push', '-q', 'origin', 'feature');
  const reviewed = git(author, 'rev-parse', 'HEAD');
  git(author, 'checkout', '-q', 'main');
  writeFileSync(join(author, 'example.txt'), 'one\ntwo\nthree upstream\n');
  git(author, 'commit', '-qam', 'Synthetic upstream change');
  git(author, 'push', '-q', 'origin', 'main');
  const base = git(author, 'rev-parse', 'HEAD');

  // One shared git directory with two linked worktrees, as on a worker host.
  git(dir, 'clone', '-q', origin, 'shared');
  const shared = join(dir, 'shared');
  const builder = join(dir, 'builder');
  const hammer = join(dir, 'hammer');
  git(shared, 'worktree', 'add', '-q', builder, 'feature');
  writeFileSync(join(builder, 'builder-notes.txt'), 'unpushed builder work\n');
  git(builder, 'add', 'builder-notes.txt'); git(builder, 'commit', '-qm', 'Synthetic unpushed builder change');
  const builderHead = git(builder, 'rev-parse', 'HEAD');
  git(shared, 'worktree', 'add', '-q', '--detach', hammer, reviewed);
  git(shared, 'update-ref', 'refs/remotes/origin/main', `${base}^`);

  const bound = {
    ROOT_DIR: root, RUN_DIR: run, HQ_ROOT: '/synthetic/hq', REPO: 'fixture/repo', PR_NUMBER: '42',
    PR_URL: 'https://github.com/fixture/repo/pull/42', REVIEWED_SHA: reviewed, TARGET_REMEDIATION_SHA: reviewed,
    RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture', AUDIT_PATH: join(run, 'audit.json'),
    REVIEWER: 'synthetic-reviewer', AMA_TRAILERS_SHELL: "''",
  };
  const inputs = template.match(/cat > '<<RUN_DIR>>\/inputs\.sh' <<'HAM_INPUTS'\n([\s\S]*?)\nHAM_INPUTS/)[1]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => bound[key]);
  writeFileSync(join(run, 'inputs.sh'), `${inputs}\n`);
  writeFileSync(join(run, 'base-head'), reviewed);
  writeFileSync(join(run, 'hammer-publish.sh'), renderHammerProcedure('hammer-publish', bound));
  const command = template.match(/^\/bin\/bash "<<ROOT_DIR>>\/bin\/hammer-conflict-repair\.sh" "<<RUN_DIR>>\/inputs\.sh"$/m)[0]
    .replace(/<<([A-Z_]+)>>/g, (_, key) => bound[key]);
  const repair = (...extra) => spawnSync('/bin/bash', ['-c', `${command} ${extra.join(' ')}`], {
    cwd: hammer, encoding: 'utf8', timeout: 60_000, env: { ...env, HAM_NODE_BIN: join(fakeBin, 'node') },
  });
  // The close command's step 1: publish the local commit the PR does not have.
  const publishEnv = { ...process.env, ...env, HAM_NODE_BIN: join(fakeBin, 'node') };
  for (const name of TOKEN_VARIABLES) delete publishEnv[name];
  const publish = () => spawnSync('/bin/bash', ['-c', `
source ${shellQuote(join(run, 'inputs.sh'))} || exit 9
export HAM_COMMIT_PUBLICATION_ONLY=1
if source ${shellQuote(join(run, 'hammer-publish.sh'))}; then status=0; else status=$?; fi
printf 'PUBLISH status=%s outcome=%s pushed=%s from=%s\\n' "$status" "$HAM_PHASE_OUTCOME" "\${HAM_PUSHED_HEAD:-}" "\${HAM_PUSHED_FROM_HEAD:-}"
`], { cwd: hammer, encoding: 'utf8', timeout: 60_000, env: publishEnv });
  const remoteHead = () => git(dir, '--git-dir', origin, 'rev-parse', 'refs/heads/feature');
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  // Resolve the synthetic conflict as the closer would, keeping both sides.
  const repairThroughConflict = () => {
    const first = repair();
    assert.equal(first.status, 22, first.stderr);
    assert.doesNotMatch(first.stderr, /conflict-checkout-failed/);
    writeFileSync(join(hammer, 'example.txt'), 'one\ntwo feature\nthree upstream\n');
    git(hammer, 'add', 'example.txt');
    const second = repair('--continue');
    assert.equal(second.status, 0, second.stderr);
    return git(hammer, 'rev-parse', 'HEAD');
  };
  return {
    dir, run, author, builder, hammer, origin, reviewed, base, builderHead, liveHeadFile,
    git, tryGit, repair, publish, remoteHead, events, repairThroughConflict,
  };
}

const publishLine = result => {
  const line = result.stdout.split('\n').find(text => text.startsWith('PUBLISH '));
  assert.ok(line, `${result.stdout}\n${result.stderr}`);
  return Object.fromEntries(line.slice('PUBLISH '.length).split(' ').map(part => part.split('=')));
};
const builderUntouched = f => {
  assert.equal(f.git(f.builder, 'symbolic-ref', '--short', 'HEAD'), 'feature', 'the builder still holds its branch');
  assert.equal(f.git(f.builder, 'rev-parse', 'refs/heads/feature'), f.builderHead, 'unpushed builder work is intact');
  assert.equal(f.git(f.builder, 'status', '--porcelain'), '');
};

test('a builder worktree holding the PR branch does not block conflict repair, which publishes the rebased head', t => {
  const f = custodyFixture(t);
  // The failure this ticket fixes: the shared git dir refuses a second checkout.
  const refused = f.tryGit(f.hammer, 'checkout', 'feature');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already (?:checked out|used by worktree)/);

  const repaired = f.repairThroughConflict();
  assert.equal(f.git(f.hammer, 'rev-parse', 'HEAD^'), f.base, 'rebased onto the live base');
  assert.equal(f.tryGit(f.hammer, 'symbolic-ref', '-q', 'HEAD').status, 1, 'the hammer stays detached');
  // HAMEMPTYPRIMARY-01 capture and author preservation are unchanged.
  assert.equal(f.git(f.hammer, 'log', '-1', '--format=%an <%ae>%n%s'),
    'Fixture Author <author@example.invalid>\nSynthetic feature change');
  assert.equal(JSON.parse(readFileSync(join(f.run, 'conflict-primary.json'), 'utf8')).proof, 'conflict-primary-preserved');
  assert.equal(readFileSync(join(f.run, CONFLICT_PUBLISH_FILE), 'utf8'),
    `source=${f.reviewed}\nhead=${repaired}\nbranch=feature\n`);
  assert.match(f.events(), /^hq generated-conflicts resolve --worktree /m);
  builderUntouched(f);

  const published = f.publish();
  const result = publishLine(published);
  assert.equal(result.status, '0', published.stderr);
  assert.equal(result.pushed, repaired);
  assert.equal(result.from, f.reviewed);
  assert.equal(f.remoteHead(), repaired, 'the PR branch now names the rebased head');
  assert.match(f.events(), new RegExp(`^git push origin HEAD:refs/heads/feature --force-with-lease=refs/heads/feature:${f.reviewed}$`, 'm'),
    'publication uses an explicit refspec leased on the captured source');
  assert.match(f.events(), new RegExp(`^pushed-attestation fixture/repo 42 ${f.reviewed} ${repaired}$`, 'm'));
  builderUntouched(f);
});

test('a PR branch updated after the repair captured its source refuses publication', async t => {
  for (const staleRead of [false, true]) {
    await t.test(staleRead ? 'the git lease refuses even when the PR read is stale' : 'the live PR read refuses', t => {
      const f = custodyFixture(t);
      f.repairThroughConflict();
      // A concurrent update of the PR branch (a later author push).
      f.git(f.author, 'fetch', '-q', 'origin');
      f.git(f.author, 'checkout', '-q', '-B', 'feature', 'origin/feature');
      writeFileSync(join(f.author, 'later.txt'), 'later\n');
      f.git(f.author, 'add', 'later.txt'); f.git(f.author, 'commit', '-qm', 'Synthetic concurrent change');
      f.git(f.author, 'push', '-q', 'origin', 'feature');
      const concurrent = f.git(f.author, 'rev-parse', 'HEAD');
      if (staleRead) writeFileSync(f.liveHeadFile, f.reviewed);

      const published = f.publish();
      const result = publishLine(published);
      assert.notEqual(result.status, '0', published.stdout);
      assert.equal(result.pushed, '');
      assert.equal(f.remoteHead(), concurrent, 'the concurrent update survives');
      const api = JSON.parse(published.stdout.split('\n').find(line => line.startsWith('{"route"')));
      assert.equal(api.route, 're-review');
      assert.equal(api.fallbackHead, f.reviewed, 'the lease expects the captured source, not the live head');
      if (!staleRead) assert.match(api.reason, /PR head moved after the conflict repair captured its source/);
      assert.match(published.stderr, /stale info|rejected/);
      assert.doesNotMatch(f.events(), /^pushed-attestation/m);
      builderUntouched(f);
    });
  }
});

test('the publication binding applies only to its own head and fails closed when malformed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hamconflictcustody-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = 'a'.repeat(40), head = 'b'.repeat(40);
  assert.equal(conflictPublishBinding(dir, () => head), null, 'no binding file');
  assert.equal(conflictPublishBinding('', () => head), null, 'no run directory');
  writeFileSync(join(dir, CONFLICT_PUBLISH_FILE), `source=${source}\nhead=${head}\nbranch=feature/x\n`);
  assert.deepEqual(conflictPublishBinding(dir, () => `${head}\n`), { source, head, branch: 'feature/x' });
  assert.equal(conflictPublishBinding(dir, () => 'c'.repeat(40)), null, 'a later local commit is not the repaired head');
  for (const text of [
    `source=${source}\nhead=${head}\n`,
    `source=short\nhead=${head}\nbranch=feature\n`,
    `source=${source}\nhead=${head}\nbranch=-x\n`,
    `source=${source}\nhead=${head}\nbranch=a b\n`,
    `source=${source}\nsource=${source}\nhead=${head}\nbranch=feature\n`,
    `source=${source}\nhead=${head}\nbranch=feature\nextra=1\n`,
  ]) {
    assert.throws(() => parseConflictPublishBinding(text), /malformed/, JSON.stringify(text));
  }
});
