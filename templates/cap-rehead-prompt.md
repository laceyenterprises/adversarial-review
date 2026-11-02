# CAPREHEAD builder PR update

Update only the existing PR branch selected by this dispatch. This is branch
maintenance after the closer retry cap, with no merge authority.

1. Start with a clean worktree. Fetch origin and check out the PR branch.
   Record the exact remote PR head as
   `old_head` and the branch as `pr_branch`. Read every PR commit since its base,
   including earlier closer commits even when the current tip is builder-authored.
   Run `node bin/cap-rehead-update-mode.mjs OWNER/REPO PR "$old_head"` from
   the adversarial-review checkout. It reuses `primary-change.mjs`'s existing
   `isHammerCommit` detection and complete-history reader, including recovery
   of the differing-merge-base case. Do not invent a trailer/login detector or
   classify just the tip. If history cannot be read, report the error; do not
   guess a variant. If the remote head changes, fetch and inspect again.
2. When the mode is `squash` (ANY hammer/closer commit in the PR range), reset the
   branch to current `origin/main` with `git reset --hard origin/main`, then run
   `git merge --squash "$old_head"`. The result must become ONE new builder
   commit containing the entire PR change applied to current main. Do not copy
   commit messages, hammer or closer trailers, or attestations.
   Do not merge main into the old hammer history: `src/ama/primary-change.mjs`
   derives the primary head from the first hammer's first parent; a later main
   merge can make primary and final merge bases differ forever. The single
   builder commit removes that history and requires full fresh review of the diff.
3. When the mode is `merge-main` (NO hammer/closer commits), keep the existing
   history: run `git merge --no-ff origin/main`. Never rebase or amend.
   If main is already merged, report
   no change; do not manufacture a commit.
4. Resolve conflicts keeping both sides' intended behavior. Regenerate generated
   files with their generators. Make no independent content or feature changes.
   If preserving both sides cannot be done safely, stop and report the conflict.
   Run affected tests before committing and pushing either variant.
5. Commit and publish the selected variant to the existing PR branch.
   For squash, verify exactly one commit above the fetched main, with the
   resolved PR tree (use `--allow-empty` if main already contains the entire
   change, so the old hammer history is still replaced), then use the explicit lease
   `git-safe push --force-with-lease="refs/heads/$pr_branch:$old_head" origin "HEAD:refs/heads/$pr_branch"`.
   A lease refusal requires reconciling the new remote head, never overwriting it.
   For merge-main, push fast-forward. Keep the PR open and its title unchanged.
   Do not open another PR. Add
   no hammer or closer trailers or attestations. Do not invoke a hammer, closer,
   or merge command against the PR.

Normal adversarial review and the closer own the new head after publication.
