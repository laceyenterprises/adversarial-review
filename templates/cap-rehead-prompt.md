# CAPREHEAD merge-main PR update

Update only the existing PR branch selected by this dispatch. This is branch
maintenance after the closer retry cap, with no merge authority.

1. Fetch origin and check out the PR branch. Run `git merge --no-ff origin/main`.
   Never rebase, squash, force-push, or amend.
2. Resolve conflicts keeping both sides' intended behavior. Regenerate generated
   files with their generators. Make no independent content or feature changes.
   If preserving both sides cannot be done safely, stop and report the conflict.
3. Run the affected tests, commit the merge, and push fast-forward to the existing
   PR branch. Do not open another PR. If main is already merged, report no change;
   do not manufacture a commit.
4. Add no hammer or closer trailers or attestations. Do not copy them from prior
   commits. Do not invoke a hammer, closer, or merge command against the PR.

Normal adversarial review and the closer own the new head after publication.
