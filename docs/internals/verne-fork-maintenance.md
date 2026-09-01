# Maintaining the Verne fork

This repository is a product fork of [T3 Code](https://github.com/pingdotgg/t3code). Verne ships
intentional product and visual differences while continuing to absorb upstream T3 Code changes.
The maintenance goal is to make those two histories explicit: upstream is merged into Verne at
reviewable sync points, and Verne-specific changes remain narrow enough to understand, update, or
remove.

## Branch and remote model

- `upstream` is the canonical T3 Code repository. Treat it as read-only.
- `origin` is the Verne fork's repository.
- `upstream/main` is the untouched upstream history.
- `main` is Verne's protected production branch. It contains both upstream history and accepted
  Verne changes. Never rebase or force-push it.
- `sync/upstream-<date>` is a temporary integration branch created from Verne `main`. It merges one
  fetched `upstream/main` revision and returns to `main` through the normal review process.
- Feature branches start from Verne `main` and return to Verne `main` through the normal review
  process.

This is a merge-based product-fork model. Each upstream update is resolved once on a sync branch;
published Verne history is not replayed whenever upstream changes.

## Pre-release rewrite integration

Until the Verne rewrite is promoted for existing users, `main` remains the production line and
`rewrite/t3` temporarily acts as the integration base for the unreleased product. During this phase:

- create `sync/upstream-<date>` from `rewrite/t3`, not production `main`;
- merge one fetched `upstream/main` revision into that sync branch with `--no-ff`;
- return the reviewed sync to `rewrite/t3`;
- do not create release tags, publish packages, or deploy production update channels from the sync;
- leave `main` unchanged unless a maintainer separately authorizes promotion of the rewrite.

Before pushing a sync branch, verify that its workflow triggers cannot publish or deploy to existing
users. Record the exact upstream revision in `config/verne-upstream.json` as described in
[Verne release versioning and upstream provenance](verne-release-versioning.md).

This is a temporary exception to the branch model below, not a second permanent release process. It
ends when the rewrite is promoted to `main`; every later upstream sync starts from Verne `main`.

## Remote safety

Before fetching, publishing, or opening a pull request, inspect both fetch and push destinations:

```sh
git remote -v
git remote get-url upstream
git remote get-url --push upstream
git remote get-url origin
git remote get-url --push origin
```

The expected result is:

- `upstream` fetches from `https://github.com/pingdotgg/t3code.git` and has a disabled push URL;
- `origin` fetches from and pushes to the Verne repository.

If `origin` points at T3 Code, stop. An agent must report the mismatch and must not alter remotes,
push, or open a pull request without maintainer authorization. If no `upstream` remote exists, a
maintainer can perform this one-time migration after substituting the Verne repository URL:

```sh
git remote rename origin upstream
git remote set-url --push upstream DISABLED
git remote add origin <verne-repository-url>
git config remote.pushDefault origin
git config branch.main.pushRemote origin
git remote -v
```

If `origin` already points at Verne and only `upstream` is missing, a maintainer can add the
read-only remote with:

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
git remote set-url --push upstream DISABLED
git remote -v
```

Do not push Verne work to `upstream`, and do not treat this document as authorization to change
remotes or publish commits.

## Rules for Verne changes

1. Decide whether a change belongs in T3 Code or only in Verne. Keep generally useful work
   upstream-shaped and free of Verne branding so maintainers can propose it upstream as a separate
   change.
2. Keep Verne-specific behavior at explicit, narrow seams such as product configuration, theme
   contracts, scoped styling, assets, and small adapter boundaries. Prefer an existing extension
   point over modifying an upstream feature component.
3. Do not rename, reformat, or reorganize nearby upstream code as part of a Verne change. Avoid
   drive-by dependency updates, generated-file changes, and lockfile churn.
4. Do not copy upstream components or fork shared primitives merely to customize them. If a new
   seam is necessary, add the smallest stable contract and document why it exists.
5. Keep commits logical and easy to understand on their own. During development, use fixup commits as
   needed; before a private branch becomes long-lived history, autosquash iterative fixups into a
   small ordered series. Never rewrite a shared branch without explicit coordination.
6. Put durable architecture and maintenance decisions in `docs/internals/`; put user-facing
   behavior in `docs/user/`. Update the relevant note when an intentional fork seam changes.
7. Changes crossing clients, providers, or the wire follow the repository's normal contract and
   multi-surface rules. A Verne-only change must state the surfaces it intentionally excludes.

Keep the persistent Verne diff concentrated in named files or directories where practical.
Theme-specific boundaries, including semantic tokens and scoped selectors, are documented in
[the Verne theme architecture](verne-theme.md).

## Preparing an upstream sync

Perform upstream updates on a clean, dedicated branch or integration worktree. Preserve unrelated
work; do not reset, discard, stash, or rewrite another branch to make the sync convenient.

First verify the remotes as described above. The `git status` output below must be empty. Then
prepare the integration branch:

```sh
git status --short
git fetch upstream --prune
git fetch origin --prune
git rev-parse upstream/main
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-<date>
git merge --no-ff upstream/main
```

The merge commit is intentional: it records the exact upstream boundary and preserves Verne's
published history. Do not rebase `main` onto upstream, merge upstream independently into multiple
feature branches, or push directly to `main`.

The local preparation commands above do not authorize publishing. When a maintainer
asks for publication, push only the sync branch and use the repository's normal pull-request and
protected-branch process. Creating a pull request still requires explicit permission under
`AGENTS.md`.

## Resolving conflicts

Read both sides of every conflict and recover both intents where possible. Preserve upstream fixes
and structure unless they conflict with a documented Verne product requirement. Do not resolve a
file wholesale with `--ours` or `--theirs` without inspecting the result; those terms also change
meaning between merge and rebase workflows.

Classify each conflict:

- **Upstream-only:** Verne has no intentional difference, so preserve the upstream change.
- **Verne-only:** Reapply the documented Verne requirement against the new upstream structure.
- **Shared seam:** Preserve the upstream fix and structure, then express Verne's intent through the
  smallest existing or newly documented seam.
- **Obsolete customization:** Drop the Verne customization because upstream now supplies the
  behavior or a better extension point.

If a conflict touches a documented seam, read its internal document before resolving it. Record a
new durable decision when the resolution changes that seam.

## Verifying a sync

Before declaring the integration complete, verify that the fetched upstream revision is an
ancestor of the sync branch:

```sh
git merge-base --is-ancestor upstream/main HEAD
```

A zero exit status is required. Then inspect both the upstream delta introduced by the sync and the
complete Verne delta from the new upstream tree:

```sh
git diff main HEAD --stat
git diff main HEAD
git diff upstream/main HEAD --stat
git diff upstream/main HEAD
git log --oneline upstream/main..HEAD
```

Use direct two-dot tree comparisons here. A three-dot comparison against upstream uses the merge
base and can hide upstream commits that have not actually been incorporated.

The final `upstream/main..HEAD` history and direct tree diff should be explainable as Verne product
decisions plus the integration merge. Remove unrelated formatting, generated files, dependency
churn, or accidental upstream edits before review.

Run the smallest proof appropriate to the files affected by both the upstream update and conflict
resolution:

- focused tests for changed behavior;
- targeted type checking and linting for affected packages;
- migration, contract, and provider-adapter checks when those areas changed;
- an integrated pass on affected client surfaces when the maintainer requests it.

When upstream changes a component that Verne styles, confirm the scoped stylesheet still targets
semantic `data-slot` or named surface attributes that the new component actually exposes. Removed
implementation classes are not a compatibility surface: replace those selectors at the sync point
instead of restoring the old class names or forking the component. For composer changes, follow the
hook contract and state checklist in [the Verne theme architecture](verne-theme.md).

Do not run repository-wide checks by default. Do not launch a second dev server or use live T3
userdata for verification.

## Updating feature branches

After the sync branch has been accepted into Verne `main`:

- a private, unpublished feature branch may rebase onto the updated `main`;
- a shared or published feature branch should merge the updated `main`;
- rewriting a shared branch requires maintainer coordination and, if publishing rewritten history,
  authorization to use `--force-with-lease`;
- `main` is never rebased.

Use `git range-diff` to compare the old and new patch series when rebasing a substantial private
branch. Prefer dropping a Verne commit that upstream made obsolete over preserving it by rote.

## Maintenance report

At the end of an upstream sync, report:

- the exact `upstream/main` commit absorbed;
- the sync branch and resulting merge commit, if created;
- Verne changes retained, adapted, or dropped;
- conflicts that changed a documented seam;
- focused checks run and surfaces intentionally not verified;
- whether the branch remains local or a maintainer authorized publication.
