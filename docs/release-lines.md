# Release lines

Zimi keeps three long-lived branches open at once, one per size of release, and ships each when it is ready. A fix lands once, in the lowest line it applies to, and is merged upward. One command points the NAS at any line.

## Choices the owner has to make

Each has a recommendation, and the scripts work with any answer (branch names are read from `ZIMI_LINE_PATCH`, `ZIMI_LINE_MINOR` and `ZIMI_LINE_MAJOR`, and `.coderabbit.yaml` lists the pattern in one place).

1. Branch names. Recommended: `line/patch`, `line/minor`, `line/major`. The names stay the same forever and the version each line currently carries is in the table below. The alternative, `release/1.15`, `release/1.16`, `release/2.0`, names the version but has to be renamed after every release.
2. What counts as patch, minor, major. Recommended: patch is a bug fix, a security fix or a dependency bump with no new screen, setting, endpoint or file format and no change in what an existing user sees by default. Minor is anything a user can see or set that is new, a new ZIM or app, a data migration that older code can still read. Major is anything that breaks an existing API, config key, data file or workflow, plus the redesign work held for 2.0. When in doubt between two lines, pick the higher one.
3. Merge-up cadence. Recommended: whoever merges into a line merges that line up on the same day, so the gap between lines is never more than one PR. The minor-to-major step may wait until the Friday before a release if nothing conflicts.
4. How lines are merged. Recommended: topic PRs into a line are squashed. Merge-up PRs and release PRs are merge commits, never squashed, because a squash gives the same change a new identity and the next merge conflicts on it. This changes today's habit of squashing the release PR into main.
5. Who merges up. Recommended: Claude opens the merge-up PR and the owner merges it, the same as every other PR.

## The lines

| Line | Branch | What belongs there | Carries now |
|------|--------|--------------------|-------------|
| Patch | `line/patch` | Fixes for the version users run. Nothing new. | the next 1.15.x |
| Minor | `line/minor` | The next medium release: new features and apps. | 1.16.0 |
| Major | `line/major` | The release that is allowed to break things. | 2.0.0 |

A line is a role, not a version. After a release the versions roll, see "After a release".

## Landing a fix

A fix goes into the lowest line it applies to, as a topic branch with a PR into that line. A bug that exists in what users run now goes to the patch line. A bug that exists only in code that is not released yet goes to the minor line, or the major line if only that line has the code. A feature goes to the line whose size matches it.

Then the line is merged upward: patch into minor, minor into major. The merge is a PR from the lower line to the higher one titled `merge-up: patch into minor`. CodeRabbit skips PRs with `merge-up` in the title, since the content was reviewed when it first landed. CI runs on every PR whatever its base.

Conflicts are resolved on the receiving side, in the merge-up PR, never by editing the lower line. Two files conflict by design. `pyproject.toml` keeps the receiving line's version. `CHANGELOG.md` keeps both lines' bullets under the receiving line's heading. Any other conflict means the same code was changed in two lines: keep the receiving line's design and port the fix into it, and say so in the PR in one sentence.

A line is never merged downward, with one exception: after a release, main is merged into the lower lines (below).

## Topic PRs

Each topic PR targets one line and stays small enough to review: under about 100 files after the path filters in `.coderabbit.yaml`, and ideally under 200 changed lines. CodeRabbit reviews only PRs whose base is the default branch unless `reviews.auto_review.base_branches` lists more; this change lists `line/.*`. A bigger piece of work is split into PRs that each leave the line working, with the last one switching the feature on.

Nothing on a topic PR changes the version. The version of a line changes only in the roll after a release.

## Releasing

A release is a short PR from a line to `main`, titled `Zimi X.Y.Z`, using a merge commit. The line already carries the version, so the PR contains no new work. The checks that exist for main apply as they do now: the `version` job fails when main already has that version tagged, the catalog snapshots must be refreshed within 14 days, and the full CI suite runs. Auto Release then tags the version from the push to main, the desktop and publish workflows run, and the owner reviews and publishes the draft release. Nobody creates, moves or deletes a tag by hand. None of the workflows changes: they act on `main` and on `pyproject.toml`, and a line only reaches them through a release PR.

## After a release

The released line is spent. The same day, in a PR into each affected line:

1. Bump the released line's own version to the next one (the patch line after 1.15.6 carries 1.15.7).
2. When the minor line was released, merge `main` into the patch line, so patch fixes now apply to 1.16 and the patch line carries 1.16.1. The minor line takes the next minor (1.17.0).
3. Merge `main` into every line that does not yet contain it, so the next release PR shows only new work.

## Pointing the NAS at a line

```
scripts/nas-line show             which line, commit and version the NAS runs now
scripts/nas-line use minor        plan, ask, deploy the tip of line/minor
scripts/nas-line use minor -n     the plan only
scripts/nas-line use minor --yes  plan and deploy without the question
./deploy.sh --dry-run             the plan for this checkout
./deploy.sh                       deploy this checkout
```

`nas-line use` clones the line from origin into a temporary folder and deploys that clone, so an uncommitted change in a working tree cannot reach the NAS. It uses the `deploy.sh` of the checkout it is run from, so a line that predates the manifest deploys too.

`deploy.sh` keeps no state of its own. The NAS holds `.zimi-deploy/manifest` in the deploy folder: the files the last deploy put there with their hashes, the ref and commit they came from, and whether the deploy finished. A deploy hashes the tree it is given, sends what differs, and removes what the manifest lists and the tree does not have. That is why a switch between lines removes exactly the other line's leftovers and why any clone deploys correctly. The container is stopped, then recreated, so the NAS does not log a crash for each deploy. Nothing in `zimi-data` or any ZIM file is sent or removed, and the NAS is never scanned. Unknown arguments deploy nothing, `--help` and `--dry-run` change nothing.

The first deploy after this change finds no manifest, so it sends every file and cannot remove anything. Make that first deploy from the line the NAS runs now; after it, a switch is exact.

If a deploy dies halfway, the manifest says `sent` instead of `deployed` and the files it was changing are left out of it, so the next deploy sends them again.

## Forbidden

- Commits to `main`. It only changes through a release PR.
- Hand-made tags. Tags come only from Auto Release.
- Re-cutting a version that reached main. Fixes after a release ship as the next patch.
- Squashing a merge-up or a release PR.
- A topic PR that changes the version.
- Deploying from a dirty tree to the NAS by hand when `nas-line` can do it from a clean clone.
