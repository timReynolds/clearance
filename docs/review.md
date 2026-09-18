# Review with Clearance

Clearance Review helps you return to a pull request with a clear view of what changed and what
still needs your attention. It combines code, discussions, ownership requirements, and review
progress while keeping native review actions on GitHub.

## Open a pull request

Use your team's Clearance host with the GitHub repository and PR number:

```text
https://YOUR_HOST/review/OWNER/REPO/pull/NUMBER
```

Sign in with GitHub to comment, reply, resolve threads, approve, or request changes. Your normal
GitHub permissions apply. Sign-in must first be enabled by the instance operator; see
[Deployment](deployment.md).

| Capability                                            | Public PR preview                                     | PR indexed by the App                                 |
| ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Current diff and public review comments               | Yes                                                   | Yes, using indexed review data                        |
| Comment, reply, submit a review                       | With GitHub sign-in                                   | With GitHub sign-in                                   |
| Resolve a thread                                      | With sign-in and an available GitHub thread reference | With sign-in and an available GitHub thread reference |
| Compare recorded patchsets                            | No                                                    | Yes                                                   |
| Save file review marks and track new comment activity | No                                                    | With GitHub sign-in                                   |
| Track and pass attention                              | No                                                    | With GitHub sign-in                                   |
| Ownership requirements                                | No                                                    | From the repository's `OWNERS.toml` rules             |

Public preview reads the current PR from GitHub without requiring an App installation on that
repository. It still needs a running Clearance instance.

## Work through a review

1. **Check what needs action.** The workspace surfaces pending ownership requirements, open
   discussions, files to review, and the people currently holding attention.
2. **Choose the changes to read.** Use the patchset controls to compare recorded revisions on an
   indexed PR. A patchset is a PR head revision observed by Clearance, labelled `PS 1`, `PS 2`, and
   so on.
3. **Read at your own pace.** Filter the changed file list, choose split or unified diffs, and adjust
   wrapping and display options. Mark files **Viewed** as you finish them.
4. **Discuss the code.** Start a line comment from the diff gutter or add a file comment. Reply to
   existing discussions and resolve threads when the issue is addressed.
5. **Submit your review.** Use **Review** to approve, request changes, or leave a review comment.
   Clearance writes the review to GitHub as you.
6. **Hand over the next step.** Pass attention to a teammate or choose **Not my turn**. Attention is
   a coordination aid; required ownership approvals still determine review clearance.

## Return after a push

On indexed PRs, file marks distinguish **current**, **stale**, and **unreviewed** files. New comment
activity is tracked against your last visit. Patchset comparisons help you focus on the changes
between review passes, and force-push indicators identify recorded history changes.

Clearance also tries to relocate comments using their surrounding code when lines move. It exposes
uncertain or deleted anchors when it cannot confidently place a discussion on the new revision.

File marks track your reading progress. They do not themselves approve ownership requirements or
create an additional required GitHub status. Mirroring marks to GitHub's viewed-file state is best
effort.

## Keyboard navigation

Choose GitHub or VS Code bindings in the workspace preferences. These navigation shortcuts apply
outside text inputs:

| Action                       | GitHub bindings | VS Code bindings                        |
| ---------------------------- | --------------- | --------------------------------------- |
| Filter files                 | `T`             | `Ctrl/Cmd+P`                            |
| Next / previous file         | `]` / `[`       | `Ctrl/Cmd+PageDown` / `Ctrl/Cmd+PageUp` |
| Next / previous review issue | `J` / `K`       | `F8` / `Shift+F8`                       |
| Mark the current file viewed | `V`             | `Ctrl/Cmd+K`, then `V`                  |

## How review data stays current

Recorded history starts with the revisions the App observes. Indexed discussions contain the
threads captured by Clearance, so GitHub is the place to check the complete PR conversation.

Patchset comparisons use GitHub's commit comparison API. When that comparison is unavailable,
Clearance shows an indexed snapshot with a message explaining the fallback.

Native review actions are saved to GitHub before the Clearance index is updated. If indexing
fails afterward, the action remains saved on GitHub and Clearance reports a warning. Refresh to
reload the available state; a warning about indexing does not mean the GitHub action failed.

[Set up ownership rules](configuration.md) · [Deploy an instance](deployment.md)
